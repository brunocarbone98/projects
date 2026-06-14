// Maps Prisma rows to the API DTOs declared in @shipping-hub/shared.
import type {
  AddressDto,
  PublicTrackingDto,
  ShipmentDto,
  TrackingEventDto,
} from "@shipping-hub/shared";
import type { Address, Shipment, TrackingEvent } from "@prisma/client";

export type ShipmentWithRelations = Shipment & {
  originAddress: Address;
  destinationAddress: Address;
  events: TrackingEvent[];
};

export function toAddressDto(address: Address): AddressDto {
  return {
    contactName: address.contactName,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    country: address.country,
    phone: address.phone,
  };
}

export function toTrackingEventDto(event: TrackingEvent): TrackingEventDto {
  return {
    id: event.id,
    status: event.status,
    location: event.location,
    description: event.description,
    occurredAt: event.occurredAt.toISOString(),
  };
}

function sortedEvents(events: TrackingEvent[]): TrackingEvent[] {
  return [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}

export function toShipmentDto(shipment: ShipmentWithRelations): ShipmentDto {
  return {
    id: shipment.id,
    trackingCode: shipment.trackingCode,
    status: shipment.status,
    serviceLevel: shipment.serviceLevel,
    origin: toAddressDto(shipment.originAddress),
    destination: toAddressDto(shipment.destinationAddress),
    parcel: {
      weightGrams: shipment.weightGrams,
      lengthCm: shipment.lengthCm,
      widthCm: shipment.widthCm,
      heightCm: shipment.heightCm,
    },
    priceCents: shipment.priceCents,
    currency: shipment.currency,
    zoneCode: shipment.zoneCode,
    estimatedDeliveryAt: shipment.estimatedDeliveryAt?.toISOString() ?? null,
    createdAt: shipment.createdAt.toISOString(),
    updatedAt: shipment.updatedAt.toISOString(),
    events: sortedEvents(shipment.events).map(toTrackingEventDto),
  };
}

/** PII-free projection for the public tracking endpoint. */
export function toPublicTrackingDto(shipment: ShipmentWithRelations): PublicTrackingDto {
  return {
    trackingCode: shipment.trackingCode,
    status: shipment.status,
    serviceLevel: shipment.serviceLevel,
    origin: { city: shipment.originAddress.city, country: shipment.originAddress.country },
    destination: {
      city: shipment.destinationAddress.city,
      country: shipment.destinationAddress.country,
    },
    estimatedDeliveryAt: shipment.estimatedDeliveryAt?.toISOString() ?? null,
    createdAt: shipment.createdAt.toISOString(),
    events: sortedEvents(shipment.events).map((event) => ({
      status: event.status,
      location: event.location,
      description: event.description,
      occurredAt: event.occurredAt.toISOString(),
    })),
  };
}
