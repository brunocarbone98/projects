// Shipment state machine — the single source of truth for valid transitions.
// The API validates every status change against this map and rejects invalid
// transitions (e.g. DELIVERED -> IN_TRANSIT). See ROADMAP.md section 4.

import type { ShipmentStatus } from "./enums.js";

/**
 * Happy path:
 *   CREATED -> LABEL_PAID -> PICKED_UP -> IN_TRANSIT -> AT_DESTINATION_HUB
 *           -> OUT_FOR_DELIVERY -> DELIVERED
 *
 * Side states: EXCEPTION (customs / bad address), RETURNED_TO_SENDER, CANCELLED.
 * Terminal states map to an empty list.
 */
export const SHIPMENT_TRANSITIONS: Readonly<Record<ShipmentStatus, readonly ShipmentStatus[]>> = {
  CREATED: ["LABEL_PAID", "CANCELLED"],
  LABEL_PAID: ["PICKED_UP", "CANCELLED"],
  PICKED_UP: ["IN_TRANSIT", "EXCEPTION"],
  IN_TRANSIT: ["AT_DESTINATION_HUB", "EXCEPTION"],
  AT_DESTINATION_HUB: ["OUT_FOR_DELIVERY", "EXCEPTION"],
  OUT_FOR_DELIVERY: ["DELIVERED", "EXCEPTION"],
  EXCEPTION: ["IN_TRANSIT", "OUT_FOR_DELIVERY", "RETURNED_TO_SENDER"],
  DELIVERED: [],
  RETURNED_TO_SENDER: [],
  CANCELLED: [],
};

/** Returns true if `to` is a legal next status from `from`. */
export function canTransition(from: ShipmentStatus, to: ShipmentStatus): boolean {
  return SHIPMENT_TRANSITIONS[from].includes(to);
}

/** The set of statuses reachable in one step from `from`. */
export function nextStatuses(from: ShipmentStatus): readonly ShipmentStatus[] {
  return SHIPMENT_TRANSITIONS[from];
}

export function isTerminalStatus(status: ShipmentStatus): boolean {
  return SHIPMENT_TRANSITIONS[status].length === 0;
}
