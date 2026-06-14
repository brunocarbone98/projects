// Domain enums shared between web and api.
// Values must stay in sync with the Prisma enums in apps/api/prisma/schema.prisma.

export const USER_ROLES = ["CUSTOMER", "COURIER", "ADMIN"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const SERVICE_LEVELS = ["EXPRESS", "STANDARD", "ECONOMY"] as const;
export type ServiceLevel = (typeof SERVICE_LEVELS)[number];

export const SHIPMENT_STATUSES = [
  "CREATED",
  "LABEL_PAID",
  "PICKED_UP",
  "IN_TRANSIT",
  "AT_DESTINATION_HUB",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "EXCEPTION",
  "RETURNED_TO_SENDER",
  "CANCELLED",
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** Statuses from which a shipment can never transition again. */
export const TERMINAL_STATUSES: readonly ShipmentStatus[] = [
  "DELIVERED",
  "RETURNED_TO_SENDER",
  "CANCELLED",
];

export function isShipmentStatus(value: string): value is ShipmentStatus {
  return (SHIPMENT_STATUSES as readonly string[]).includes(value);
}

export function isServiceLevel(value: string): value is ServiceLevel {
  return (SERVICE_LEVELS as readonly string[]).includes(value);
}

export function isUserRole(value: string): value is UserRole {
  return (USER_ROLES as readonly string[]).includes(value);
}
