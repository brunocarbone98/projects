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
import { fetchLabelPdf } from "../clients/labels.js";
import {
  toPublicTrackingDto,
  toShipmentDto,
  type ShipmentWithRelations,
} from "../domain/serializers.js";
import { env } from "../env.js";
import { AppError, conflict, forbidden, notFound } from "../http/errors.js";
import { notifyStatusChange } from "../notifications/index.js";
import { prisma } from "../prisma.js";
import { getQuote } from "./quote.service.js";

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
  const now = new Date();
  // Quote via the pricing microservice (falls back to the local rate table).
  const quote = await getQuote({
    originCountry: input.origin.country,
    destinationCountry: input.destination.country,
    weightGrams: input.parcel.weightGrams,
    lengthCm: input.parcel.lengthCm,
    widthCm: input.parcel.widthCm,
    heightCm: input.parcel.heightCm,
    serviceLevel: input.serviceLevel,
  });

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
        priceCents: quote.priceCents,
        currency: quote.currency,
        zoneCode: quote.zoneCode,
        estimatedDeliveryAt: new Date(quote.estimatedDeliveryAt),
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

  const recipient = updated.userId
    ? ((await prisma.user.findUnique({ where: { id: updated.userId }, select: { email: true } }))
        ?.email ?? null)
    : null;
  notifyStatusChange({
    trackingCode: updated.trackingCode,
    status: to,
    recipientEmail: recipient,
    trackingUrl: `${env.PUBLIC_WEB_URL}/en/tracking/${updated.trackingCode}`,
  });

  return toShipmentDto(updated);
}

/** Generates the shipping-label PDF for an owned shipment via the labels service. */
export async function getShipmentLabel(
  actor: AccessClaims,
  shipmentId: string,
): Promise<{ filename: string; pdf: Buffer }> {
  const shipment = await loadOwnedShipment(actor, shipmentId);
  const pdf = await fetchLabelPdf({
    trackingCode: shipment.trackingCode,
    serviceLevel: shipment.serviceLevel,
    origin: { city: shipment.originAddress.city, country: shipment.originAddress.country },
    destination: {
      city: shipment.destinationAddress.city,
      country: shipment.destinationAddress.country,
    },
    weightGrams: shipment.weightGrams,
    trackingUrl: `${env.PUBLIC_WEB_URL}/en/tracking/${shipment.trackingCode}`,
  });
  return { filename: `label-${shipment.trackingCode}.pdf`, pdf };
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
