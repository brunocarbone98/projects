// Seeds reference data, demo accounts and a realistic set of shipments + wallet
// activity. Re-runnable: transactional and wallet tables are cleared first.
//
// - 4 fixed accounts (admin, courier, ana, luis) keep their hand-crafted set of
//   10 shipments (so PTY-2026-001001-0 stays the public demo code).
// - 20 additional customer profiles get 2–3 shipments each, spread across every
//   status, destination, service level and parcel size.
// - Every customer gets a wallet: a top-up plus a label payment per paid
//   shipment, recorded as correct double-entry ledger transactions.
import { buildTrackingCode, type ServiceLevel, type ShipmentStatus } from "@shipping-hub/shared";
import { hashPassword } from "../src/auth/passwords.js";
import { addBusinessDays, billableWeightGrams, computePriceCents, resolveZoneCode } from "../src/domain/pricing.js";
import { prisma } from "../src/prisma.js";
import { RATES, seedReferenceData } from "./reference.js";

const DEMO_PASSWORD = "Password123!";
const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

interface AddressSeed {
  contactName: string;
  line1: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
  phone?: string;
}

interface EventSeed {
  status: ShipmentStatus;
  location: string;
  description: string;
  dayOffset: number;
}

interface ShipmentSpec {
  serviceLevel: ServiceLevel;
  destination: AddressSeed;
  parcel: { weightGrams: number; lengthCm: number; widthCm: number; heightCm: number };
  baseDaysAgo: number;
  events: EventSeed[];
}

const ORIGIN: AddressSeed = {
  contactName: "Shipping Hub Warehouse",
  line1: "Calle 50, Torre Global Bank, Piso 12",
  city: "Panama City",
  state: "Panama",
  postalCode: "0801",
  country: "PA",
  phone: "+507 200 0000",
};
const ORIGIN_LABEL = "Panama City, PA";

const D = (city: string, country: string, extra: Partial<AddressSeed> = {}): AddressSeed => ({
  contactName: `${city} Recipient`,
  line1: "123 Main St",
  city,
  postalCode: "00000",
  country,
  ...extra,
});

const happyPath = (origin: string): EventSeed[] => [
  { status: "CREATED", location: origin, description: "Shipment created", dayOffset: 0 },
  { status: "LABEL_PAID", location: origin, description: "Label paid", dayOffset: 0 },
  { status: "PICKED_UP", location: origin, description: "Picked up by courier", dayOffset: 0 },
  { status: "IN_TRANSIT", location: "Tocumen Intl (PTY)", description: "Departed origin facility", dayOffset: 1 },
];

// The original hand-crafted 10 shipments for ana (customer1) and luis (customer2).
const SHIPMENTS: (ShipmentSpec & { owner: "customer1" | "customer2" })[] = [
  {
    owner: "customer1",
    serviceLevel: "EXPRESS",
    destination: D("Miami", "US", { state: "FL", postalCode: "33101" }),
    parcel: { weightGrams: 2400, lengthCm: 30, widthCm: 20, heightCm: 15 },
    baseDaysAgo: 4,
    events: [
      ...happyPath(ORIGIN_LABEL),
      { status: "AT_DESTINATION_HUB", location: "Miami, US", description: "Arrived at destination hub", dayOffset: 2 },
      { status: "OUT_FOR_DELIVERY", location: "Miami, US", description: "Out for delivery", dayOffset: 3 },
      { status: "DELIVERED", location: "Miami, US", description: "Delivered, signed by recipient", dayOffset: 3 },
    ],
  },
  {
    owner: "customer2",
    serviceLevel: "STANDARD",
    destination: D("Bogotá", "CO", { postalCode: "110111" }),
    parcel: { weightGrams: 5200, lengthCm: 40, widthCm: 30, heightCm: 25 },
    baseDaysAgo: 5,
    events: [
      ...happyPath(ORIGIN_LABEL),
      { status: "AT_DESTINATION_HUB", location: "Bogotá, CO", description: "Arrived at destination hub", dayOffset: 3 },
      { status: "OUT_FOR_DELIVERY", location: "Bogotá, CO", description: "Out for delivery", dayOffset: 4 },
    ],
  },
  {
    owner: "customer1",
    serviceLevel: "STANDARD",
    destination: D("Mexico City", "MX", { postalCode: "01000" }),
    parcel: { weightGrams: 1800, lengthCm: 25, widthCm: 20, heightCm: 10 },
    baseDaysAgo: 2,
    events: [...happyPath(ORIGIN_LABEL)],
  },
  {
    owner: "customer2",
    serviceLevel: "EXPRESS",
    destination: D("New York", "US", { state: "NY", postalCode: "10001" }),
    parcel: { weightGrams: 800, lengthCm: 20, widthCm: 15, heightCm: 10 },
    baseDaysAgo: 2,
    events: [
      ...happyPath(ORIGIN_LABEL),
      { status: "AT_DESTINATION_HUB", location: "New York, US", description: "Arrived at destination hub", dayOffset: 2 },
    ],
  },
  {
    owner: "customer1",
    serviceLevel: "ECONOMY",
    destination: D("Lima", "PE", { postalCode: "15001" }),
    parcel: { weightGrams: 9500, lengthCm: 50, widthCm: 40, heightCm: 30 },
    baseDaysAgo: 1,
    events: [
      { status: "CREATED", location: ORIGIN_LABEL, description: "Shipment created", dayOffset: 0 },
      { status: "LABEL_PAID", location: ORIGIN_LABEL, description: "Label paid", dayOffset: 0 },
      { status: "PICKED_UP", location: ORIGIN_LABEL, description: "Picked up by courier", dayOffset: 0 },
    ],
  },
  {
    owner: "customer2",
    serviceLevel: "STANDARD",
    destination: D("Santiago", "CL", { postalCode: "8320000" }),
    parcel: { weightGrams: 3100, lengthCm: 35, widthCm: 25, heightCm: 20 },
    baseDaysAgo: 1,
    events: [
      { status: "CREATED", location: ORIGIN_LABEL, description: "Shipment created", dayOffset: 0 },
      { status: "LABEL_PAID", location: ORIGIN_LABEL, description: "Label paid", dayOffset: 0 },
    ],
  },
  {
    owner: "customer1",
    serviceLevel: "ECONOMY",
    destination: D("Colón", "PA", { postalCode: "0301" }),
    parcel: { weightGrams: 1200, lengthCm: 20, widthCm: 15, heightCm: 12 },
    baseDaysAgo: 0,
    events: [{ status: "CREATED", location: ORIGIN_LABEL, description: "Shipment created", dayOffset: 0 }],
  },
  {
    owner: "customer2",
    serviceLevel: "STANDARD",
    destination: D("Buenos Aires", "AR", { postalCode: "C1000" }),
    parcel: { weightGrams: 6700, lengthCm: 45, widthCm: 35, heightCm: 30 },
    baseDaysAgo: 6,
    events: [
      ...happyPath(ORIGIN_LABEL),
      { status: "EXCEPTION", location: "Buenos Aires, AR", description: "Customs hold — documentation requested", dayOffset: 4 },
    ],
  },
  {
    owner: "customer1",
    serviceLevel: "ECONOMY",
    destination: D("Quito", "EC", { postalCode: "170102" }),
    parcel: { weightGrams: 2200, lengthCm: 28, widthCm: 22, heightCm: 18 },
    baseDaysAgo: 9,
    events: [
      ...happyPath(ORIGIN_LABEL),
      { status: "EXCEPTION", location: "Quito, EC", description: "Address could not be verified", dayOffset: 4 },
      { status: "RETURNED_TO_SENDER", location: ORIGIN_LABEL, description: "Returned to sender", dayOffset: 8 },
    ],
  },
  {
    owner: "customer2",
    serviceLevel: "EXPRESS",
    destination: D("Houston", "US", { state: "TX", postalCode: "77001" }),
    parcel: { weightGrams: 1500, lengthCm: 22, widthCm: 18, heightCm: 14 },
    baseDaysAgo: 1,
    events: [
      { status: "CREATED", location: ORIGIN_LABEL, description: "Shipment created", dayOffset: 0 },
      { status: "LABEL_PAID", location: ORIGIN_LABEL, description: "Label paid", dayOffset: 0 },
      { status: "CANCELLED", location: ORIGIN_LABEL, description: "Cancelled at customer request", dayOffset: 0 },
    ],
  },
];

// 20 additional customer profiles.
const CUSTOMER_NAMES = [
  "María González", "Carlos Rodríguez", "Sofía Martínez", "Diego Hernández",
  "Valentina López", "Andrés Ramírez", "Camila Torres", "José Morales",
  "Daniela Castillo", "Miguel Ortega", "Gabriela Flores", "Ricardo Mendoza",
  "Isabela Vargas", "Fernando Jiménez", "Lucía Romero", "Javier Navarro",
  "Paula Guerrero", "Sebastián Ríos", "Natalia Cruz", "Emily Johnson",
];

const emailFor = (name: string): string =>
  `${name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, ".")}@example.com`;

// Pools the generator cycles through for variety.
const DESTS: AddressSeed[] = [
  D("Miami", "US", { state: "FL", postalCode: "33101" }),
  D("New York", "US", { state: "NY", postalCode: "10001" }),
  D("Houston", "US", { state: "TX", postalCode: "77001" }),
  D("Los Angeles", "US", { state: "CA", postalCode: "90001" }),
  D("Orlando", "US", { state: "FL", postalCode: "32801" }),
  D("Bogotá", "CO", { postalCode: "110111" }),
  D("Medellín", "CO", { postalCode: "050001" }),
  D("Mexico City", "MX", { postalCode: "01000" }),
  D("Guadalajara", "MX", { postalCode: "44100" }),
  D("Lima", "PE", { postalCode: "15001" }),
  D("Santiago", "CL", { postalCode: "8320000" }),
  D("San José", "CR", { postalCode: "10101" }),
  D("Buenos Aires", "AR", { postalCode: "C1000" }),
  D("Córdoba", "AR", { postalCode: "X5000" }),
  D("Quito", "EC", { postalCode: "170102" }),
  D("Guayaquil", "EC", { postalCode: "090101" }),
  D("Colón", "PA", { postalCode: "0301" }),
  D("David", "PA", { postalCode: "0426" }),
];
const SERVICES: ServiceLevel[] = ["EXPRESS", "STANDARD", "ECONOMY"];
const PARCELS = [
  { weightGrams: 800, lengthCm: 20, widthCm: 15, heightCm: 10 },
  { weightGrams: 1500, lengthCm: 25, widthCm: 18, heightCm: 14 },
  { weightGrams: 2400, lengthCm: 30, widthCm: 20, heightCm: 15 },
  { weightGrams: 3200, lengthCm: 35, widthCm: 25, heightCm: 20 },
  { weightGrams: 5200, lengthCm: 40, widthCm: 30, heightCm: 25 },
  { weightGrams: 9500, lengthCm: 50, widthCm: 40, heightCm: 30 },
];
const STATUS_CYCLE: ShipmentStatus[] = [
  "DELIVERED", "IN_TRANSIT", "OUT_FOR_DELIVERY", "AT_DESTINATION_HUB", "LABEL_PAID",
  "CREATED", "PICKED_UP", "EXCEPTION", "RETURNED_TO_SENDER", "CANCELLED",
];
const BASE_DAYS_AGO: Record<ShipmentStatus, number> = {
  CREATED: 0, LABEL_PAID: 1, PICKED_UP: 1, IN_TRANSIT: 2, AT_DESTINATION_HUB: 3,
  OUT_FOR_DELIVERY: 4, DELIVERED: 5, EXCEPTION: 6, RETURNED_TO_SENDER: 10, CANCELLED: 1,
};

/** Build a coherent event chain (with day offsets) ending at `target`. */
function eventsForStatus(target: ShipmentStatus, destLabel: string): EventSeed[] {
  const E = (status: ShipmentStatus, location: string, description: string, dayOffset: number): EventSeed => ({ status, location, description, dayOffset });
  const chain: EventSeed[] = [
    E("CREATED", ORIGIN_LABEL, "Shipment created", 0),
    E("LABEL_PAID", ORIGIN_LABEL, "Label paid", 0),
    E("PICKED_UP", ORIGIN_LABEL, "Picked up by courier", 0),
    E("IN_TRANSIT", "Tocumen Intl (PTY)", "Departed origin facility", 1),
    E("AT_DESTINATION_HUB", destLabel, "Arrived at destination hub", 2),
    E("OUT_FOR_DELIVERY", destLabel, "Out for delivery", 3),
    E("DELIVERED", destLabel, "Delivered, signed by recipient", 3),
  ];
  const mainIdx: Partial<Record<ShipmentStatus, number>> = {
    CREATED: 0, LABEL_PAID: 1, PICKED_UP: 2, IN_TRANSIT: 3, AT_DESTINATION_HUB: 4, OUT_FOR_DELIVERY: 5, DELIVERED: 6,
  };
  if (mainIdx[target] !== undefined) return chain.slice(0, mainIdx[target]! + 1);
  if (target === "EXCEPTION") return [...chain.slice(0, 4), E("EXCEPTION", destLabel, "Customs hold — documentation requested", 4)];
  if (target === "RETURNED_TO_SENDER") {
    return [...chain.slice(0, 4), E("EXCEPTION", destLabel, "Address could not be verified", 4), E("RETURNED_TO_SENDER", ORIGIN_LABEL, "Returned to sender", 8)];
  }
  return [chain[0], E("CANCELLED", ORIGIN_LABEL, "Cancelled at customer request", 0)]; // CANCELLED (before paying)
}

/** Generate 2–3 deterministic, varied shipment specs for customer index `i`. */
function shipmentsForCustomer(i: number): ShipmentSpec[] {
  const count = 2 + (i % 2); // 2 or 3
  const specs: ShipmentSpec[] = [];
  for (let j = 0; j < count; j++) {
    const status = STATUS_CYCLE[(i * 3 + j) % STATUS_CYCLE.length];
    const destination = DESTS[(i * 2 + j * 5) % DESTS.length];
    const serviceLevel = SERVICES[(i + j) % SERVICES.length];
    const parcel = PARCELS[(i * 2 + j) % PARCELS.length];
    specs.push({
      serviceLevel,
      destination,
      parcel,
      baseDaysAgo: BASE_DAYS_AGO[status] + (j % 3),
      events: eventsForStatus(status, `${destination.city}, ${destination.country}`),
    });
  }
  return specs;
}

interface TrackedShipment {
  shipmentId: string;
  trackingCode: string;
  priceCents: number;
  paid: boolean;
  labelPaidAt: Date;
  createdAt: Date;
}

async function main(): Promise<void> {
  // Clear transactional + wallet data (FK-safe order); keep nothing stale.
  await prisma.payment.deleteMany();
  await prisma.ledgerEntry.deleteMany();
  await prisma.ledgerTransaction.deleteMany();
  await prisma.walletAccount.deleteMany();
  await prisma.trackingEvent.deleteMany();
  await prisma.shipment.deleteMany();
  await prisma.address.deleteMany();
  await prisma.refreshToken.deleteMany();

  await seedReferenceData(prisma);

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const [, courier, customer1, customer2] = await Promise.all([
    prisma.user.upsert({ where: { email: "admin@shippinghub.test" }, create: { email: "admin@shippinghub.test", name: "Ops Admin", role: "ADMIN", passwordHash }, update: { passwordHash, role: "ADMIN" } }),
    prisma.user.upsert({ where: { email: "courier@shippinghub.test" }, create: { email: "courier@shippinghub.test", name: "Field Courier", role: "COURIER", passwordHash }, update: { passwordHash, role: "COURIER" } }),
    prisma.user.upsert({ where: { email: "ana@example.com" }, create: { email: "ana@example.com", name: "Ana Pérez", role: "CUSTOMER", passwordHash }, update: { passwordHash } }),
    prisma.user.upsert({ where: { email: "luis@example.com" }, create: { email: "luis@example.com", name: "Luis Gómez", role: "CUSTOMER", passwordHash }, update: { passwordHash } }),
  ]);

  const extraCustomers = await Promise.all(
    CUSTOMER_NAMES.map((name) => {
      const email = emailFor(name);
      return prisma.user.upsert({ where: { email }, create: { email, name, role: "CUSTOMER", passwordHash }, update: { name, passwordHash } });
    }),
  );

  // Singleton system accounts for the double-entry ledger.
  const cash = await prisma.walletAccount.upsert({ where: { systemKey: "CASH" }, create: { kind: "CASH", systemKey: "CASH" }, update: {} });
  const revenue = await prisma.walletAccount.upsert({ where: { systemKey: "REVENUE" }, create: { kind: "REVENUE", systemKey: "REVENUE" }, update: {} });

  let sequence = 1000;
  const year = new Date().getUTCFullYear();
  const tracked = new Map<string, TrackedShipment[]>();

  async function createShipment(ownerId: string, spec: ShipmentSpec): Promise<void> {
    sequence += 1;
    const trackingCode = buildTrackingCode(year, sequence);
    const zoneCode = resolveZoneCode(spec.destination.country);
    const [baseCents, perKgCents, , etaMaxDays] = RATES[zoneCode][spec.serviceLevel];
    const billable = billableWeightGrams(spec.parcel.weightGrams, spec.parcel.lengthCm, spec.parcel.widthCm, spec.parcel.heightCm);
    const priceCents = computePriceCents({ serviceLevel: spec.serviceLevel, baseCents, perKgCents, etaMinDays: 0, etaMaxDays }, billable);

    const base = new Date();
    base.setUTCDate(base.getUTCDate() - spec.baseDaysAgo);
    base.setUTCHours(13, 0, 0, 0);
    const eventTime = (offset: number): Date => {
      const t = new Date(base.getTime());
      t.setUTCDate(t.getUTCDate() + offset);
      return t;
    };

    const finalStatus = spec.events[spec.events.length - 1].status;
    const labelPaidEvent = spec.events.find((e) => e.status === "LABEL_PAID");
    const created = await prisma.shipment.create({
      data: {
        trackingCode,
        user: { connect: { id: ownerId } },
        serviceLevel: spec.serviceLevel,
        status: finalStatus,
        weightGrams: spec.parcel.weightGrams,
        lengthCm: spec.parcel.lengthCm,
        widthCm: spec.parcel.widthCm,
        heightCm: spec.parcel.heightCm,
        priceCents,
        currency: "USD",
        zoneCode,
        estimatedDeliveryAt: addBusinessDays(base, etaMaxDays),
        createdAt: base,
        originAddress: { create: { ...ORIGIN } },
        destinationAddress: { create: { ...spec.destination } },
        events: {
          create: spec.events.map((event) => ({
            status: event.status,
            location: event.location,
            description: event.description,
            actorId: courier.id,
            occurredAt: eventTime(event.dayOffset),
            recordedAt: eventTime(event.dayOffset),
          })),
        },
      },
    });

    const entry = tracked.get(ownerId) ?? [];
    entry.push({
      shipmentId: created.id,
      trackingCode,
      priceCents,
      paid: labelPaidEvent !== undefined && finalStatus !== "CANCELLED",
      labelPaidAt: eventTime(labelPaidEvent?.dayOffset ?? 0),
      createdAt: base,
    });
    tracked.set(ownerId, entry);
  }

  // Hand-crafted set for ana/luis, then the generated set for the 20 customers.
  const owners = { customer1, customer2 };
  for (const spec of SHIPMENTS) await createShipment(owners[spec.owner].id, spec);
  for (let i = 0; i < extraCustomers.length; i++) {
    for (const spec of shipmentsForCustomer(i)) await createShipment(extraCustomers[i].id, spec);
  }

  // Wallet activity: one top-up per customer plus a label payment per paid
  // shipment, written as correct double-entry ledger transactions.
  const remainders = [2500, 5000, 1000, 7500, 3000, 4500];
  const allCustomers = [customer1, customer2, ...extraCustomers];
  for (let c = 0; c < allCustomers.length; c++) {
    const customer = allCustomers[c];
    const ships = tracked.get(customer.id) ?? [];
    if (ships.length === 0) continue;
    const wallet = await prisma.walletAccount.upsert({ where: { userId: customer.id }, create: { kind: "USER", userId: customer.id }, update: {} });

    const paidShips = ships.filter((s) => s.paid);
    const totalPaid = paidShips.reduce((sum, s) => sum + s.priceCents, 0);
    const remainder = remainders[c % remainders.length];
    const topUpCents = totalPaid + remainder;
    const earliest = ships.reduce((min, s) => (s.createdAt < min ? s.createdAt : min), ships[0].createdAt);
    const topUpAt = new Date(earliest.getTime() - 24 * 3600 * 1000);

    const topUpTx = await prisma.ledgerTransaction.create({ data: { idempotencyKey: `seed:topup:${customer.id}`, kind: "TOPUP", description: `Wallet top-up ${dollars(topUpCents)}`, createdAt: topUpAt } });
    await prisma.ledgerEntry.createMany({
      data: [
        { transactionId: topUpTx.id, accountId: wallet.id, amountCents: topUpCents, createdAt: topUpAt },
        { transactionId: topUpTx.id, accountId: cash.id, amountCents: -topUpCents, createdAt: topUpAt },
      ],
    });

    let p = 0;
    for (const ship of paidShips) {
      const payTx = await prisma.ledgerTransaction.create({ data: { idempotencyKey: `seed:pay:${customer.id}:${p}`, kind: "PAYMENT", description: `Label payment for ${ship.trackingCode}`, createdAt: ship.labelPaidAt } });
      await prisma.ledgerEntry.createMany({
        data: [
          { transactionId: payTx.id, accountId: wallet.id, amountCents: -ship.priceCents, createdAt: ship.labelPaidAt },
          { transactionId: payTx.id, accountId: revenue.id, amountCents: ship.priceCents, createdAt: ship.labelPaidAt },
        ],
      });
      await prisma.payment.create({ data: { userId: customer.id, shipmentId: ship.shipmentId, transactionId: payTx.id, amountCents: ship.priceCents, currency: "USD", status: "COMPLETED", createdAt: ship.labelPaidAt } });
      p++;
    }
  }

  await prisma.counter.upsert({ where: { id: "shipment" }, create: { id: "shipment", value: sequence }, update: { value: sequence } });

  const totalShipments = [...tracked.values()].reduce((n, s) => n + s.length, 0);
  console.log("Seed complete.");
  console.log(`Demo password for all accounts: ${DEMO_PASSWORD}`);
  console.log(`Users: 2 staff + ${allCustomers.length} customers · Shipments: ${totalShipments}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
