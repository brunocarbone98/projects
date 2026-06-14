import type { PaginatedDto, ShipmentDto } from "@shipping-hub/shared";
import { hasTrackingCodeShape, isValidTrackingCode } from "@shipping-hub/shared";
import { describe, expect, it } from "vitest";
import { api, bearer, createShipment, createStaff, registerCustomer } from "./helpers.js";

describe("shipments", () => {
  it("creates a shipment with a valid tracking code, price and initial event", async () => {
    const { tokens } = await registerCustomer("creator@example.com");
    const shipment = await createShipment(tokens.accessToken);

    expect(hasTrackingCodeShape(shipment.trackingCode)).toBe(true);
    expect(isValidTrackingCode(shipment.trackingCode)).toBe(true);
    expect(shipment.status).toBe("CREATED");
    expect(shipment.zoneCode).toBe("US");
    expect(shipment.priceCents).toBeGreaterThan(0);
    expect(shipment.estimatedDeliveryAt).toBeTruthy();
    expect(shipment.events).toHaveLength(1);
    expect(shipment.events[0].status).toBe("CREATED");
  });

  it("rejects an invalid create payload", async () => {
    const { tokens } = await registerCustomer("badpayload@example.com");
    const res = await api()
      .post("/api/v1/shipments")
      .set("Authorization", bearer(tokens.accessToken))
      .send({ serviceLevel: "EXPRESS" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("scopes the list to the owning customer", async () => {
    const ana = await registerCustomer("ana@example.com");
    const luis = await registerCustomer("luis@example.com");
    await createShipment(ana.tokens.accessToken);
    await createShipment(ana.tokens.accessToken);
    await createShipment(luis.tokens.accessToken);

    const res = await api().get("/api/v1/shipments").set("Authorization", bearer(ana.tokens.accessToken));
    expect(res.status).toBe(200);
    const body = res.body as PaginatedDto<ShipmentDto>;
    expect(body.total).toBe(2);
    expect(body.data.every((s) => s.events.length >= 1)).toBe(true);
  });

  it("hides another customer's shipment behind a 404", async () => {
    const ana = await registerCustomer("ana2@example.com");
    const luis = await registerCustomer("luis2@example.com");
    const anaShipment = await createShipment(ana.tokens.accessToken);

    const res = await api()
      .get(`/api/v1/shipments/${anaShipment.id}`)
      .set("Authorization", bearer(luis.tokens.accessToken));
    expect(res.status).toBe(404);
  });

  it("lets an admin see any shipment", async () => {
    const ana = await registerCustomer("ana3@example.com");
    const admin = await createStaff("ADMIN");
    const shipment = await createShipment(ana.tokens.accessToken);

    const res = await api()
      .get(`/api/v1/shipments/${shipment.id}`)
      .set("Authorization", bearer(admin.tokens.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(shipment.id);
  });

  it("forbids customers from registering tracking events", async () => {
    const { tokens } = await registerCustomer("cust@example.com");
    const shipment = await createShipment(tokens.accessToken);

    const res = await api()
      .post(`/api/v1/shipments/${shipment.id}/events`)
      .set("Authorization", bearer(tokens.accessToken))
      .send({ status: "LABEL_PAID" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });
});
