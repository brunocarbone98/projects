import type { ShipmentDto } from "@shipping-hub/shared";
import { describe, expect, it } from "vitest";
import { api, bearer, createShipment, createStaff, registerCustomer } from "./helpers.js";

async function addEvent(token: string, shipmentId: string, status: string, location?: string) {
  return api()
    .post(`/api/v1/shipments/${shipmentId}/events`)
    .set("Authorization", bearer(token))
    .send({ status, location });
}

describe("shipment state machine (via API)", () => {
  it("advances a shipment through the full happy path to DELIVERED", async () => {
    const customer = await registerCustomer("flow@example.com");
    const courier = await createStaff("COURIER");
    const shipment = await createShipment(customer.tokens.accessToken);

    const path = [
      "LABEL_PAID",
      "PICKED_UP",
      "IN_TRANSIT",
      "AT_DESTINATION_HUB",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
    ];

    let last: ShipmentDto | undefined;
    for (const status of path) {
      const res = await addEvent(courier.tokens.accessToken, shipment.id, status, "Hub scan");
      expect(res.status, `transition to ${status}`).toBe(201);
      last = res.body as ShipmentDto;
      expect(last.status).toBe(status);
    }

    expect(last?.status).toBe("DELIVERED");
    // CREATED + 6 transitions.
    expect(last?.events).toHaveLength(7);
  });

  it("rejects an invalid transition with 409 INVALID_TRANSITION", async () => {
    const customer = await registerCustomer("invalid@example.com");
    const courier = await createStaff("COURIER");
    const shipment = await createShipment(customer.tokens.accessToken);

    const res = await addEvent(courier.tokens.accessToken, shipment.id, "DELIVERED");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVALID_TRANSITION");
    expect(res.body.error.details).toMatchObject({ from: "CREATED", to: "DELIVERED" });
  });

  it("refuses to move a terminal shipment", async () => {
    const customer = await registerCustomer("terminal@example.com");
    const courier = await createStaff("COURIER");
    const shipment = await createShipment(customer.tokens.accessToken);

    await addEvent(courier.tokens.accessToken, shipment.id, "CANCELLED");
    const res = await addEvent(courier.tokens.accessToken, shipment.id, "LABEL_PAID");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVALID_TRANSITION");
  });
});
