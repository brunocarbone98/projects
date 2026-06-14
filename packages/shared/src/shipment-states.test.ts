import { describe, expect, it } from "vitest";
import { SHIPMENT_STATUSES } from "./enums.js";
import {
  SHIPMENT_TRANSITIONS,
  canTransition,
  isTerminalStatus,
  nextStatuses,
} from "./shipment-states.js";

describe("shipment state machine", () => {
  it("defines transitions for every status", () => {
    for (const status of SHIPMENT_STATUSES) {
      expect(SHIPMENT_TRANSITIONS[status]).toBeDefined();
    }
  });

  it("allows the happy-path transitions", () => {
    expect(canTransition("CREATED", "LABEL_PAID")).toBe(true);
    expect(canTransition("LABEL_PAID", "PICKED_UP")).toBe(true);
    expect(canTransition("OUT_FOR_DELIVERY", "DELIVERED")).toBe(true);
  });

  it("rejects the canonical invalid transition DELIVERED -> IN_TRANSIT", () => {
    expect(canTransition("DELIVERED", "IN_TRANSIT")).toBe(false);
  });

  it("treats DELIVERED, CANCELLED and RETURNED_TO_SENDER as terminal", () => {
    expect(isTerminalStatus("DELIVERED")).toBe(true);
    expect(isTerminalStatus("CANCELLED")).toBe(true);
    expect(isTerminalStatus("RETURNED_TO_SENDER")).toBe(true);
    expect(nextStatuses("DELIVERED")).toHaveLength(0);
  });

  it("lets EXCEPTION recover or return to sender", () => {
    expect(canTransition("EXCEPTION", "IN_TRANSIT")).toBe(true);
    expect(canTransition("EXCEPTION", "RETURNED_TO_SENDER")).toBe(true);
    expect(canTransition("EXCEPTION", "DELIVERED")).toBe(false);
  });

  it("never lists a status as its own successor", () => {
    for (const status of SHIPMENT_STATUSES) {
      expect(SHIPMENT_TRANSITIONS[status]).not.toContain(status);
    }
  });
});
