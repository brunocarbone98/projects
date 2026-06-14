import {
  buildTrackingCode,
  canTransition,
  isTerminalStatus,
  type CreateShipmentInput,
  type CreateTrackingEventInput,
  type ListShipmentsQuery,
  type PaginatedDto,
  type PublicTrackingDto,
  type ShipmentDto,
} from "@shipping-hub/shared";
import type { Prisma, ShipmentStatus } from "@prisma/client";
import type { AccessClaims } from "../auth/tokens.js";
import {
  addBusinessDays,
  billableWeightGrams,
  computePriceCents,
  resolveZoneCode,
} from "../domain/pricing.js";
import {
  toPublicTrackingDto,
  toShipmentDto,
  type ShipmentWithRelations,
} from "../domain/serializers.js";
import { AppError, badRequest, conflict, forbidden, notFound } from "../http/errors.js";
import { prisma } from "../prisma.js";

const SHIPMENT_INCLUDE = {
  originAddress: true,
  destinationAddress: true,
  events: true,
} satisfies Prisma.ShipmentInclude;

const SHIPMENT_COUNTER_ID = "shipment";

function addressCreate(
  input: CreateShipmentInput["origin"],
): Prisma.AddressCreateWithoutOriginOfInput {
  return {
    contactName: input.contactName,
    line1: input.line1,
    line2: input.line2 ?? null,
    city: input.city,
    state: input.state ?? null,
    postalCode: input.postalCode,
    country: input.country,
    phone: input.phone ?? null,
  };
}

export async function createShipment(
  input: CreateShipmentInput,
  userId: string | null,
): Promise<ShipmentDto> {
  const zoneCode = resolveZoneCode(input.destination.country);
  const zone = await prisma.zone.findUnique({
    where: { code: zoneCode },
    include: { rates: { where: { serviceLevel: input.serviceLevel } } },
  });
  const rate = zone?.rates[0];
  if (!zone || !rate) {
    throw badRequest(`No rate configured for ${zoneCode}/${input.serviceLevel}`);
  }

  const billableGrams = billableWeightGrams(
    input.parcel.weightGrams,
    input.parcel.lengthCm,
    input.parcel.widthCm,
    input.parcel.heightCm,
  );
  const priceCents = computePriceCents(rate, billableGrams);
  const now = new Date();
  const estimatedDeliveryAt = addBusinessDays(now, rate.etaMaxDays);

  const { id } = await prisma.$transaction(async (tx) => {
    const counter = await tx.counter.upsert({
      where: { id: SHIPMENT_COUNTER_ID },
      create: { id: SHIPMENT_COUNTER_ID, value: 1001 },
      update: { value: { increment: 1 } },
    });
    const trackingCode = buildTrackingCode(now.getUTCFullYear(), counter.value);

    return tx.shipment.create({
      data: {
        trackingCode,
        user: userId ? { connect: { id: userId } } : undefined,
        serviceLevel: input.serviceLevel,
        status: "CREATED",
        weightGrams: input.parcel.weightGrams,
        lengthCm: input.parcel.lengthCm,
        widthCm: input.parcel.widthCm,
        heightCm: input.parcel.heightCm,
        priceCents,
        currency: "USD",
        zoneCode,
        estimatedDeliveryAt,
        originAddress: { create: addressCreate(input.origin) },
        destinationAddress: { create: addressCreate(input.destination) },
        events: {
          create: {
            status: "CREATED",
            location: `${input.origin.city}, ${input.origin.country}`,
            description: "Shipment created",
            actorId: userId,
            occurredAt: now,
            recordedAt: now,
          },
        },
      },
      select: { id: true },
    });
  });

  const shipment = await prisma.shipment.findUniqueOrThrow({
    where: { id },
    include: SHIPMENT_INCLUDE,
  });
  return toShipmentDto(shipment);
}

export async function listShipments(
  actor: AccessClaims,
  query: ListShipmentsQuery,
): Promise<PaginatedDto<ShipmentDto>> {
  const where: Prisma.ShipmentWhereInput = {};
  if (actor.role === "CUSTOMER") where.userId = actor.sub;
  if (query.status) where.status = query.status;

  const [total, rows] = await prisma.$transaction([
    prisma.shipment.count({ where }),
    prisma.shipment.findMany({
      where,
      include: SHIPMENT_INCLUDE,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  return {
    data: rows.map((row) => toShipmentDto(row)),
    page: query.page,
    pageSize: query.pageSize,
    total,
  };
}

async function loadOwnedShipment(
  actor: AccessClaims,
  shipmentId: string,
): Promise<ShipmentWithRelations> {
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: SHIPMENT_INCLUDE,
  });
  if (!shipment) throw notFound("Shipment not found");
  if (actor.role === "CUSTOMER" && shipment.userId !== actor.sub) {
    throw notFound("Shipment not found");
  }
  return shipment;
}

export async function getShipment(actor: AccessClaims, shipmentId: string): Promise<ShipmentDto> {
  return toShipmentDto(await loadOwnedShipment(actor, shipmentId));
}

export async function addTrackingEvent(
  actor: AccessClaims,
  shipmentId: string,
  input: CreateTrackingEventInput,
): Promise<ShipmentDto> {
  if (actor.role !== "ADMIN" && actor.role !== "COURIER") {
    throw forbidden("Only couriers and admins can register tracking events");
  }

  const current = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!current) throw notFound("Shipment not found");

  const from = current.status;
  const to = input.status as ShipmentStatus;
  if (isTerminalStatus(from) || !canTransition(from, to)) {
    throw conflict("INVALID_TRANSITION", `Cannot move a shipment from ${from} to ${to}`, {
      from,
      to,
    });
  }

  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();

  // tracking_events is append-only — we only ever create rows here. The event
  // insert and the status update share one transaction so they commit together.
  await prisma.$transaction([
    prisma.trackingEvent.create({
      data: {
        shipmentId,
        status: to,
        location: input.location ?? null,
        description: input.description ?? null,
        actorId: actor.sub,
        occurredAt,
        recordedAt: new Date(),
      },
    }),
    prisma.shipment.update({ where: { id: shipmentId }, data: { status: to } }),
  ]);

  const updated = await prisma.shipment.findUniqueOrThrow({
    where: { id: shipmentId },
    include: SHIPMENT_INCLUDE,
  });
  return toShipmentDto(updated);
}

export async function getPublicTracking(trackingCode: string): Promise<PublicTrackingDto> {
  const shipment = await prisma.shipment.findUnique({
    where: { trackingCode },
    include: SHIPMENT_INCLUDE,
  });
  if (!shipment) throw notFound("No shipment found for that tracking code");
  return toPublicTrackingDto(shipment);
}

// Re-exported for callers that catch domain errors.
export { AppError };
