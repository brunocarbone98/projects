import type { PublicTrackingDto } from "@shipping-hub/shared";
import supertest from "supertest";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { api, createShipment, registerCustomer } from "./helpers.js";

describe("public tracking", () => {
  it("returns a PII-free timeline for a known code without auth", async () => {
    const { tokens } = await registerCustomer("track@example.com");
    const shipment = await createShipment(tokens.accessToken);

    const res = await api().get(`/api/v1/tracking/${shipment.trackingCode}`);
    expect(res.status).toBe(200);

    const body = res.body as PublicTrackingDto;
    expect(body.trackingCode).toBe(shipment.trackingCode);
    expect(body.status).toBe("CREATED");
    expect(body.origin).toEqual({ city: "Panama City", country: "PA" });
    expect(body.destination).toEqual({ city: "Miami", country: "US" });
    expect(body.events.length).toBeGreaterThanOrEqual(1);

    // No recipient PII should leak into the public payload.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("Jane Doe");
    expect(serialized).not.toContain("Ocean Drive");
  });

  it("returns 404 for an unknown but well-formed code", async () => {
    const res = await api().get("/api/v1/tracking/PTY-2026-000999-0");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 for a malformed code", async () => {
    const res = await api().get("/api/v1/tracking/not-a-code");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rate-limits the public endpoint", async () => {
    const limitedApp = buildApp({ publicRateLimitMax: 3, publicRateLimitWindowMs: 60_000 });
    const code = "PTY-2026-000999-0";

    for (let i = 0; i < 3; i++) {
      const res = await supertest(limitedApp).get(`/api/v1/tracking/${code}`);
      expect(res.status).toBe(404); // within budget, just not found
    }
    const limited = await supertest(limitedApp).get(`/api/v1/tracking/${code}`);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
  });
});
