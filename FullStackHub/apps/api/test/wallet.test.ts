import { describe, expect, it } from "vitest";
import { prisma } from "../src/prisma.js";
import { reversePayment } from "../src/services/wallet.service.js";
import { api, bearer, createShipment, registerCustomer } from "./helpers.js";

const topup = (token: string, amountCents: number, idempotencyKey: string) =>
  api()
    .post("/api/v1/wallet/topup")
    .set("Authorization", bearer(token))
    .send({ amountCents, idempotencyKey });

const getWallet = (token: string) =>
  api().get("/api/v1/wallet").set("Authorization", bearer(token));

const pay = (token: string, shipmentId: string, idempotencyKey: string) =>
  api()
    .post(`/api/v1/shipments/${shipmentId}/pay`)
    .set("Authorization", bearer(token))
    .send({ idempotencyKey });

describe("wallet + double-entry ledger", () => {
  it("starts at zero and tops up", async () => {
    const { tokens } = await registerCustomer("w1@example.com");
    expect((await getWallet(tokens.accessToken)).body.balanceCents).toBe(0);

    const res = await topup(tokens.accessToken, 5000, "topup-key-1");
    expect(res.status).toBe(200);
    expect(res.body.balanceCents).toBe(5000);
    expect(res.body.entries[0].kind).toBe("TOPUP");
  });

  it("a concurrent double-click top-up credits only once", async () => {
    const { tokens } = await registerCustomer("w2@example.com");
    const key = "dup-topup";
    const [a, b] = await Promise.all([
      topup(tokens.accessToken, 3000, key),
      topup(tokens.accessToken, 3000, key),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((await getWallet(tokens.accessToken)).body.balanceCents).toBe(3000);
  });

  it("pays for a shipment: debits wallet, advances to LABEL_PAID", async () => {
    const { tokens } = await registerCustomer("w3@example.com");
    await topup(tokens.accessToken, 10000, "fund-3");
    const shipment = await createShipment(tokens.accessToken);

    const res = await pay(tokens.accessToken, shipment.id, "pay-3");
    expect(res.status).toBe(201);
    expect(res.body.shipment.status).toBe("LABEL_PAID");
    expect(res.body.payment.status).toBe("COMPLETED");
    expect(res.body.wallet.balanceCents).toBe(10000 - shipment.priceCents);
  });

  it("a double-click payment charges only once", async () => {
    const { tokens } = await registerCustomer("w4@example.com");
    await topup(tokens.accessToken, 20000, "fund-4");
    const shipment = await createShipment(tokens.accessToken);

    const first = await pay(tokens.accessToken, shipment.id, "dup-pay");
    const second = await pay(tokens.accessToken, shipment.id, "dup-pay");
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    expect((await getWallet(tokens.accessToken)).body.balanceCents).toBe(
      20000 - shipment.priceCents,
    );
    expect(await prisma.payment.count({ where: { shipmentId: shipment.id } })).toBe(1);
  });

  it("rejects payment when the wallet has insufficient funds", async () => {
    const { tokens } = await registerCustomer("w5@example.com");
    const shipment = await createShipment(tokens.accessToken);
    const res = await pay(tokens.accessToken, shipment.id, "pay-5");
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe("INSUFFICIENT_FUNDS");
  });

  it("reverses a payment: balance restored, shipment back to CREATED, ledger nets to zero", async () => {
    const { tokens } = await registerCustomer("w6@example.com");
    await topup(tokens.accessToken, 10000, "fund-6");
    const shipment = await createShipment(tokens.accessToken);
    const paid = await pay(tokens.accessToken, shipment.id, "pay-6");

    await reversePayment(paid.body.payment.id);

    expect((await getWallet(tokens.accessToken)).body.balanceCents).toBe(10000);
    const after = await api()
      .get(`/api/v1/shipments/${shipment.id}`)
      .set("Authorization", bearer(tokens.accessToken));
    expect(after.body.status).toBe("CREATED");

    // Every double-entry transaction must sum to zero.
    const txns = await prisma.ledgerTransaction.findMany({ include: { entries: true } });
    for (const txn of txns) {
      expect(txn.entries.reduce((sum, e) => sum + e.amountCents, 0)).toBe(0);
    }
  });

  it("scopes idempotency keys per user (no cross-user collision)", async () => {
    const a = await registerCustomer("scope-a@example.com");
    const b = await registerCustomer("scope-b@example.com");
    // Both submit the SAME client idempotency key.
    expect((await topup(a.tokens.accessToken, 5000, "shared-key")).status).toBe(200);
    expect((await topup(b.tokens.accessToken, 7000, "shared-key")).status).toBe(200);
    // Each wallet is credited independently — B's key did not collide with A's.
    expect((await getWallet(a.tokens.accessToken)).body.balanceCents).toBe(5000);
    expect((await getWallet(b.tokens.accessToken)).body.balanceCents).toBe(7000);
  });

  it("does not leak another user's payment when an idempotency key is replayed", async () => {
    const a = await registerCustomer("idor-a@example.com");
    const b = await registerCustomer("idor-b@example.com");
    await topup(a.tokens.accessToken, 10000, "fund-a");
    const shipA = await createShipment(a.tokens.accessToken);
    expect((await pay(a.tokens.accessToken, shipA.id, "shared-pay-key")).status).toBe(201);

    // B replays A's idempotency key against B's own shipment.
    await topup(b.tokens.accessToken, 10000, "fund-b");
    const shipB = await createShipment(b.tokens.accessToken);
    const resB = await pay(b.tokens.accessToken, shipB.id, "shared-pay-key");

    expect(resB.status).toBe(201);
    expect(resB.body.shipment.id).toBe(shipB.id); // B's own shipment, not A's
    expect(resB.body.payment.shipmentId).toBe(shipB.id);
  });
});
