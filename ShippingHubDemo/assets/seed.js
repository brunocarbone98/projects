// Demo dataset — a port of FullStackHub/apps/api/prisma/seed.ts. Builds the
// four demo accounts, ten shipments spread across the state machine (with the
// same tracking codes, zone pricing and ETAs), and a starter wallet balance.
// Timestamps are computed relative to "now" so the timelines always look fresh.

import {
  addBusinessDays,
  billableWeightGrams,
  buildTrackingCode,
  computePriceCents,
  RATES,
  resolveZoneCode,
} from "./domain.js";

export const DEMO_PASSWORD = "Password123!";

const ORIGIN = {
  contactName: "Shipping Hub Warehouse",
  line1: "Calle 50, Torre Global Bank, Piso 12",
  city: "Panama City",
  state: "Panama",
  postalCode: "0801",
  country: "PA",
};

const D = (city, country, extra = {}) => ({
  contactName: `${city} Recipient`,
  line1: "123 Main St",
  city,
  postalCode: "00000",
  country,
  ...extra,
});

const happyPath = (origin) => [
  { status: "CREATED", location: origin, description: "Shipment created", dayOffset: 0 },
  { status: "LABEL_PAID", location: origin, description: "Label paid", dayOffset: 0 },
  { status: "PICKED_UP", location: origin, description: "Picked up by courier", dayOffset: 0 },
  { status: "IN_TRANSIT", location: "Tocumen Intl (PTY)", description: "Departed origin facility", dayOffset: 1 },
];

const SHIPMENTS = [
  { owner: "customer1", serviceLevel: "EXPRESS", destination: D("Miami", "US", { state: "FL", postalCode: "33101" }),
    parcel: { weightGrams: 2400, lengthCm: 30, widthCm: 20, heightCm: 15 }, baseDaysAgo: 4,
    events: [...happyPath("Panama City, PA"),
      { status: "AT_DESTINATION_HUB", location: "Miami, US", description: "Arrived at destination hub", dayOffset: 2 },
      { status: "OUT_FOR_DELIVERY", location: "Miami, US", description: "Out for delivery", dayOffset: 3 },
      { status: "DELIVERED", location: "Miami, US", description: "Delivered, signed by recipient", dayOffset: 3 }] },
  { owner: "customer2", serviceLevel: "STANDARD", destination: D("Bogotá", "CO", { postalCode: "110111" }),
    parcel: { weightGrams: 5200, lengthCm: 40, widthCm: 30, heightCm: 25 }, baseDaysAgo: 5,
    events: [...happyPath("Panama City, PA"),
      { status: "AT_DESTINATION_HUB", location: "Bogotá, CO", description: "Arrived at destination hub", dayOffset: 3 },
      { status: "OUT_FOR_DELIVERY", location: "Bogotá, CO", description: "Out for delivery", dayOffset: 4 }] },
  { owner: "customer1", serviceLevel: "STANDARD", destination: D("Mexico City", "MX", { postalCode: "01000" }),
    parcel: { weightGrams: 1800, lengthCm: 25, widthCm: 20, heightCm: 10 }, baseDaysAgo: 2,
    events: [...happyPath("Panama City, PA")] },
  { owner: "customer2", serviceLevel: "EXPRESS", destination: D("New York", "US", { state: "NY", postalCode: "10001" }),
    parcel: { weightGrams: 800, lengthCm: 20, widthCm: 15, heightCm: 10 }, baseDaysAgo: 2,
    events: [...happyPath("Panama City, PA"),
      { status: "AT_DESTINATION_HUB", location: "New York, US", description: "Arrived at destination hub", dayOffset: 2 }] },
  { owner: "customer1", serviceLevel: "ECONOMY", destination: D("Lima", "PE", { postalCode: "15001" }),
    parcel: { weightGrams: 9500, lengthCm: 50, widthCm: 40, heightCm: 30 }, baseDaysAgo: 1,
    events: [
      { status: "CREATED", location: "Panama City, PA", description: "Shipment created", dayOffset: 0 },
      { status: "LABEL_PAID", location: "Panama City, PA", description: "Label paid", dayOffset: 0 },
      { status: "PICKED_UP", location: "Panama City, PA", description: "Picked up by courier", dayOffset: 0 }] },
  { owner: "customer2", serviceLevel: "STANDARD", destination: D("Santiago", "CL", { postalCode: "8320000" }),
    parcel: { weightGrams: 3100, lengthCm: 35, widthCm: 25, heightCm: 20 }, baseDaysAgo: 1,
    events: [
      { status: "CREATED", location: "Panama City, PA", description: "Shipment created", dayOffset: 0 },
      { status: "LABEL_PAID", location: "Panama City, PA", description: "Label paid", dayOffset: 0 }] },
  { owner: "customer1", serviceLevel: "ECONOMY", destination: D("Colón", "PA", { postalCode: "0301" }),
    parcel: { weightGrams: 1200, lengthCm: 20, widthCm: 15, heightCm: 12 }, baseDaysAgo: 0,
    events: [{ status: "CREATED", location: "Panama City, PA", description: "Shipment created", dayOffset: 0 }] },
  { owner: "customer2", serviceLevel: "STANDARD", destination: D("Buenos Aires", "AR", { postalCode: "C1000" }),
    parcel: { weightGrams: 6700, lengthCm: 45, widthCm: 35, heightCm: 30 }, baseDaysAgo: 6,
    events: [...happyPath("Panama City, PA"),
      { status: "EXCEPTION", location: "Buenos Aires, AR", description: "Customs hold — documentation requested", dayOffset: 4 }] },
  { owner: "customer1", serviceLevel: "ECONOMY", destination: D("Quito", "EC", { postalCode: "170102" }),
    parcel: { weightGrams: 2200, lengthCm: 28, widthCm: 22, heightCm: 18 }, baseDaysAgo: 9,
    events: [...happyPath("Panama City, PA"),
      { status: "EXCEPTION", location: "Quito, EC", description: "Address could not be verified", dayOffset: 4 },
      { status: "RETURNED_TO_SENDER", location: "Panama City, PA", description: "Returned to sender", dayOffset: 8 }] },
  { owner: "customer2", serviceLevel: "EXPRESS", destination: D("Houston", "US", { state: "TX", postalCode: "77001" }),
    parcel: { weightGrams: 1500, lengthCm: 22, widthCm: 18, heightCm: 14 }, baseDaysAgo: 1,
    events: [
      { status: "CREATED", location: "Panama City, PA", description: "Shipment created", dayOffset: 0 },
      { status: "LABEL_PAID", location: "Panama City, PA", description: "Label paid", dayOffset: 0 },
      { status: "CANCELLED", location: "Panama City, PA", description: "Cancelled at customer request", dayOffset: 0 }] },
];

// Approximate coordinates for the route map (origin + demo destinations).
const CITY_COORDS = {
  "Panama City": [8.98, -79.52], "Colón": [9.36, -79.9], "Miami": [25.76, -80.19],
  "New York": [40.71, -74.01], "Houston": [29.76, -95.37], "Bogotá": [4.71, -74.07],
  "Mexico City": [19.43, -99.13], "Lima": [-12.05, -77.04], "Santiago": [-33.45, -70.67],
  "Buenos Aires": [-34.6, -58.38], "Quito": [-0.18, -78.47],
};
const COUNTRY_COORDS = {
  PA: [8.5, -80.0], US: [39.0, -98.0], CO: [4.6, -74.1], MX: [23.6, -102.5], PE: [-9.2, -75.0],
  CL: [-35.7, -71.5], CR: [9.7, -83.7], AR: [-38.4, -63.6], EC: [-1.8, -78.2],
};

/** Best-effort [lat, lng] for an address, used by the tracking map. */
export function coordsFor(city, country) {
  return CITY_COORDS[city] ?? COUNTRY_COORDS[String(country).toUpperCase()] ?? [0, 0];
}

let idCounter = 0;
const nextId = (prefix) => `${prefix}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;

// 20 additional customer profiles (kept in sync with apps/api/prisma/seed.ts).
const CUSTOMER_NAMES = [
  "María González", "Carlos Rodríguez", "Sofía Martínez", "Diego Hernández",
  "Valentina López", "Andrés Ramírez", "Camila Torres", "José Morales",
  "Daniela Castillo", "Miguel Ortega", "Gabriela Flores", "Ricardo Mendoza",
  "Isabela Vargas", "Fernando Jiménez", "Lucía Romero", "Javier Navarro",
  "Paula Guerrero", "Sebastián Ríos", "Natalia Cruz", "Emily Johnson",
];
const emailFor = (name) =>
  `${name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, ".")}@example.com`;

const DESTS = [
  D("Miami", "US", { state: "FL", postalCode: "33101" }), D("New York", "US", { state: "NY", postalCode: "10001" }),
  D("Houston", "US", { state: "TX", postalCode: "77001" }), D("Los Angeles", "US", { state: "CA", postalCode: "90001" }),
  D("Orlando", "US", { state: "FL", postalCode: "32801" }), D("Bogotá", "CO", { postalCode: "110111" }),
  D("Medellín", "CO", { postalCode: "050001" }), D("Mexico City", "MX", { postalCode: "01000" }),
  D("Guadalajara", "MX", { postalCode: "44100" }), D("Lima", "PE", { postalCode: "15001" }),
  D("Santiago", "CL", { postalCode: "8320000" }), D("San José", "CR", { postalCode: "10101" }),
  D("Buenos Aires", "AR", { postalCode: "C1000" }), D("Córdoba", "AR", { postalCode: "X5000" }),
  D("Quito", "EC", { postalCode: "170102" }), D("Guayaquil", "EC", { postalCode: "090101" }),
  D("Colón", "PA", { postalCode: "0301" }), D("David", "PA", { postalCode: "0426" }),
];
const SERVICES = ["EXPRESS", "STANDARD", "ECONOMY"];
const PARCELS = [
  { weightGrams: 800, lengthCm: 20, widthCm: 15, heightCm: 10 }, { weightGrams: 1500, lengthCm: 25, widthCm: 18, heightCm: 14 },
  { weightGrams: 2400, lengthCm: 30, widthCm: 20, heightCm: 15 }, { weightGrams: 3200, lengthCm: 35, widthCm: 25, heightCm: 20 },
  { weightGrams: 5200, lengthCm: 40, widthCm: 30, heightCm: 25 }, { weightGrams: 9500, lengthCm: 50, widthCm: 40, heightCm: 30 },
];
const STATUS_CYCLE = ["DELIVERED", "IN_TRANSIT", "OUT_FOR_DELIVERY", "AT_DESTINATION_HUB", "LABEL_PAID", "CREATED", "PICKED_UP", "EXCEPTION", "RETURNED_TO_SENDER", "CANCELLED"];
const BASE_DAYS_AGO = { CREATED: 0, LABEL_PAID: 1, PICKED_UP: 1, IN_TRANSIT: 2, AT_DESTINATION_HUB: 3, OUT_FOR_DELIVERY: 4, DELIVERED: 5, EXCEPTION: 6, RETURNED_TO_SENDER: 10, CANCELLED: 1 };
const ORIGIN_LABEL = "Panama City, PA";

/** Build a coherent event chain ending at `target` (mirrors the API seed). */
function eventsForStatus(target, destLabel) {
  const E = (status, location, description, dayOffset) => ({ status, location, description, dayOffset });
  const chain = [
    E("CREATED", ORIGIN_LABEL, "Shipment created", 0),
    E("LABEL_PAID", ORIGIN_LABEL, "Label paid", 0),
    E("PICKED_UP", ORIGIN_LABEL, "Picked up by courier", 0),
    E("IN_TRANSIT", "Tocumen Intl (PTY)", "Departed origin facility", 1),
    E("AT_DESTINATION_HUB", destLabel, "Arrived at destination hub", 2),
    E("OUT_FOR_DELIVERY", destLabel, "Out for delivery", 3),
    E("DELIVERED", destLabel, "Delivered, signed by recipient", 3),
  ];
  const mainIdx = { CREATED: 0, LABEL_PAID: 1, PICKED_UP: 2, IN_TRANSIT: 3, AT_DESTINATION_HUB: 4, OUT_FOR_DELIVERY: 5, DELIVERED: 6 };
  if (mainIdx[target] !== undefined) return chain.slice(0, mainIdx[target] + 1);
  if (target === "EXCEPTION") return [...chain.slice(0, 4), E("EXCEPTION", destLabel, "Customs hold — documentation requested", 4)];
  if (target === "RETURNED_TO_SENDER") return [...chain.slice(0, 4), E("EXCEPTION", destLabel, "Address could not be verified", 4), E("RETURNED_TO_SENDER", ORIGIN_LABEL, "Returned to sender", 8)];
  return [chain[0], E("CANCELLED", ORIGIN_LABEL, "Cancelled at customer request", 0)];
}

/** 2–3 deterministic, varied shipment specs for customer index `i`. */
function shipmentsForCustomer(i) {
  const count = 2 + (i % 2);
  const specs = [];
  for (let j = 0; j < count; j++) {
    const status = STATUS_CYCLE[(i * 3 + j) % STATUS_CYCLE.length];
    const destination = DESTS[(i * 2 + j * 5) % DESTS.length];
    const serviceLevel = SERVICES[(i + j) % SERVICES.length];
    const parcel = PARCELS[(i * 2 + j) % PARCELS.length];
    specs.push({ serviceLevel, destination, parcel, baseDaysAgo: BASE_DAYS_AGO[status] + (j % 3), events: eventsForStatus(status, `${destination.city}, ${destination.country}`) });
  }
  return specs;
}

/** Build the initial database (relative to `now`). */
export function buildSeed(now = new Date()) {
  const users = [
    { id: nextId("usr"), email: "admin@shippinghub.test", name: "Ops Admin", role: "ADMIN", password: DEMO_PASSWORD },
    { id: nextId("usr"), email: "courier@shippinghub.test", name: "Field Courier", role: "COURIER", password: DEMO_PASSWORD },
    { id: nextId("usr"), email: "ana@example.com", name: "Ana Pérez", role: "CUSTOMER", password: DEMO_PASSWORD },
    { id: nextId("usr"), email: "luis@example.com", name: "Luis Gómez", role: "CUSTOMER", password: DEMO_PASSWORD },
  ];
  const extra = CUSTOMER_NAMES.map((name) => ({ id: nextId("usr"), email: emailFor(name), name, role: "CUSTOMER", password: DEMO_PASSWORD }));
  users.push(...extra);
  const owners = { customer1: users[2], customer2: users[3] };
  const year = now.getUTCFullYear();
  let sequence = 1000;
  const shipments = [];
  const tracked = new Map();

  function createShipment(ownerId, spec) {
    sequence += 1;
    const trackingCode = buildTrackingCode(year, sequence);
    const zoneCode = resolveZoneCode(spec.destination.country);
    const [baseCents, perKgCents, , etaMaxDays] = RATES[zoneCode][spec.serviceLevel];
    const billable = billableWeightGrams(spec.parcel.weightGrams, spec.parcel.lengthCm, spec.parcel.widthCm, spec.parcel.heightCm);
    const priceCents = computePriceCents(baseCents, perKgCents, billable);

    const base = new Date(now.getTime());
    base.setUTCDate(base.getUTCDate() - spec.baseDaysAgo);
    base.setUTCHours(13, 0, 0, 0);
    const eventTime = (offset) => {
      const t = new Date(base.getTime());
      t.setUTCDate(t.getUTCDate() + offset);
      return t.toISOString();
    };
    const events = spec.events.map((event) => ({
      id: nextId("evt"), status: event.status, location: event.location,
      description: event.description, occurredAt: eventTime(event.dayOffset),
    }));
    const finalStatus = events[events.length - 1].status;
    const labelPaidEvent = spec.events.find((e) => e.status === "LABEL_PAID");
    const id = nextId("shp");
    shipments.push({
      id, trackingCode, userId: ownerId, serviceLevel: spec.serviceLevel, status: finalStatus,
      weightGrams: spec.parcel.weightGrams, lengthCm: spec.parcel.lengthCm, widthCm: spec.parcel.widthCm, heightCm: spec.parcel.heightCm,
      priceCents, currency: "USD", zoneCode,
      estimatedDeliveryAt: addBusinessDays(base, etaMaxDays, spec.destination.country).toISOString(),
      createdAt: base.toISOString(),
      originAddress: { ...ORIGIN }, destinationAddress: { ...spec.destination }, events,
    });
    const list = tracked.get(ownerId) ?? [];
    list.push({ shipmentId: id, priceCents, paid: !!labelPaidEvent && finalStatus !== "CANCELLED", labelPaidAt: eventTime(labelPaidEvent?.dayOffset ?? 0), createdAt: base.getTime() });
    tracked.set(ownerId, list);
  }

  for (const seed of SHIPMENTS) createShipment(owners[seed.owner].id, seed);
  for (let i = 0; i < extra.length; i++) for (const spec of shipmentsForCustomer(i)) createShipment(extra[i].id, spec);

  // Wallet: one top-up per customer plus a payment per paid shipment (signed ledger).
  const remainders = [2500, 5000, 1000, 7500, 3000, 4500];
  const ledger = [];
  const customers = [users[2], users[3], ...extra];
  customers.forEach((customer, c) => {
    const ships = tracked.get(customer.id) ?? [];
    if (!ships.length) return;
    const paid = ships.filter((s) => s.paid);
    const topUpCents = paid.reduce((sum, s) => sum + s.priceCents, 0) + remainders[c % remainders.length];
    const earliest = Math.min(...ships.map((s) => s.createdAt));
    const topUpAt = new Date(earliest - 24 * 3600 * 1000).toISOString();
    ledger.push({ id: nextId("led"), userId: customer.id, kind: "TOPUP", amountCents: topUpCents, shipmentId: null, idempotencyKey: nextId("seed-topup"), createdAt: topUpAt });
    for (const ship of paid) {
      ledger.push({ id: nextId("led"), userId: customer.id, kind: "PAYMENT", amountCents: -ship.priceCents, shipmentId: ship.shipmentId, idempotencyKey: nextId("seed-pay"), createdAt: ship.labelPaidAt });
    }
  });

  return { users, shipments, ledger, counter: { shipment: sequence }, origin: { ...ORIGIN } };
}

export { ORIGIN };
