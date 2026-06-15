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

/** Build the initial database (relative to `now`). */
export function buildSeed(now = new Date()) {
  const users = [
    { id: nextId("usr"), email: "admin@shippinghub.test", name: "Ops Admin", role: "ADMIN", password: DEMO_PASSWORD },
    { id: nextId("usr"), email: "courier@shippinghub.test", name: "Field Courier", role: "COURIER", password: DEMO_PASSWORD },
    { id: nextId("usr"), email: "ana@example.com", name: "Ana Pérez", role: "CUSTOMER", password: DEMO_PASSWORD },
    { id: nextId("usr"), email: "luis@example.com", name: "Luis Gómez", role: "CUSTOMER", password: DEMO_PASSWORD },
  ];
  const owners = { customer1: users[2], customer2: users[3] };
  const year = now.getUTCFullYear();
  let sequence = 1000;
  const shipments = [];

  for (const seed of SHIPMENTS) {
    sequence += 1;
    const trackingCode = buildTrackingCode(year, sequence);
    const zoneCode = resolveZoneCode(seed.destination.country);
    const [baseCents, perKgCents, , etaMaxDays] = RATES[zoneCode][seed.serviceLevel];
    const billable = billableWeightGrams(
      seed.parcel.weightGrams, seed.parcel.lengthCm, seed.parcel.widthCm, seed.parcel.heightCm,
    );
    const priceCents = computePriceCents(baseCents, perKgCents, billable);

    const base = new Date(now.getTime());
    base.setUTCDate(base.getUTCDate() - seed.baseDaysAgo);
    base.setUTCHours(13, 0, 0, 0);
    const eventTime = (offset) => {
      const t = new Date(base.getTime());
      t.setUTCDate(t.getUTCDate() + offset);
      return t.toISOString();
    };

    const events = seed.events.map((event) => ({
      id: nextId("evt"), status: event.status, location: event.location,
      description: event.description, occurredAt: eventTime(event.dayOffset),
    }));

    shipments.push({
      id: nextId("shp"), trackingCode, userId: owners[seed.owner].id,
      serviceLevel: seed.serviceLevel, status: events[events.length - 1].status,
      weightGrams: seed.parcel.weightGrams, lengthCm: seed.parcel.lengthCm,
      widthCm: seed.parcel.widthCm, heightCm: seed.parcel.heightCm,
      priceCents, currency: "USD", zoneCode,
      estimatedDeliveryAt: addBusinessDays(base, etaMaxDays, seed.destination.country).toISOString(),
      createdAt: base.toISOString(),
      originAddress: { ...ORIGIN }, destinationAddress: { ...seed.destination },
      events,
    });
  }

  // A starter top-up so the wallet has a balance and some history to show.
  const ledger = [owners.customer1, owners.customer2].map((user) => ({
    id: nextId("led"), userId: user.id, kind: "TOPUP", amountCents: 10000,
    shipmentId: null, idempotencyKey: nextId("seed-topup"), createdAt: now.toISOString(),
  }));

  return { users, shipments, ledger, counter: { shipment: sequence }, origin: { ...ORIGIN } };
}

export { ORIGIN };
