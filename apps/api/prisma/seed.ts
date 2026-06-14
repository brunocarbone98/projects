// Seeds reference data, demo accounts and 10 shipments spread across the
// state machine. Re-runnable: transactional tables are cleared first.
import { buildTrackingCode, type ServiceLevel, type ShipmentStatus } from "@shipping-hub/shared";
import { hashPassword } from "../src/auth/passwords.js";
import { addBusinessDays, billableWeightGrams, computePriceCents, resolveZoneCode } from "../src/domain/pricing.js";
import { prisma } from "../src/prisma.js";
import { RATES, seedReferenceData } from "./reference.js";

const DEMO_PASSWORD = "Password123!";

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

interface ShipmentSeed {
  owner: "customer1" | "customer2";
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

const SHIPMENTS: ShipmentSeed[] = [
  {
    owner: "customer1",
    serviceLevel: "EXPRESS",
    destination: D("Miami", "US", { state: "FL", postalCode: "33101" }),
    parcel: { weightGrams: 2400, lengthCm: 30, widthCm: 20, heightCm: 15 },
    baseDaysAgo: 4,
    events: [
      ...happyPath("Panama City, PA"),
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
      ...happyPath("Panama City, PA"),
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
    events: [...happyPath("Panama City, PA")],
  },
  {
    owner: "customer2",
    serviceLevel: "EXPRESS",
    destination: D("New York", "US", { state: "NY", postalCode: "10001" }),
    parcel: { weightGrams: 800, lengthCm: 20, widthCm: 15, heightCm: 10 },
    baseDaysAgo: 2,
    events: [
      ...happyPath("Panama City, PA"),
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
      { status: "CREATED", location: "Panama City, PA", description: "Shipment created", dayOffset: 0 },
      { status: "LABEL_PAID", location: "Panama City, PA", description: "Label paid", dayOffset: 0 },
      { status: "PICKED_UP", location: "Panama City, PA", description: "Picked up by courier", dayOffset: 0 },
    ],
  },
  {
    owner: "customer2",
    serviceLevel: "STANDARD",
    destination: D("Santiago", "CL", { postalCode: "8320000" }),
    parcel: { weightGrams: 3100, lengthCm: 35, widthCm: 25, heightCm: 20 },
    baseDaysAgo: 1,
    events: [
      { status: "CREATED", location: "Panama City, PA", description: "Shipment created", dayOffset: 0 },
      { status: "LABEL_PAID", location: "Panama City, PA", description: "Label paid", dayOffset: 0 },
    ],
  },
  {
    owner: "customer1",
    serviceLevel: "ECONOMY",
    destination: D("Colón", "PA", { postalCode: "0301" }),
    parcel: { weightGrams: 1200, lengthCm: 20, widthCm: 15, heightCm: 12 },
    baseDaysAgo: 0,
    events: [
      { status: "CREATED", location: "Panama City, PA", description: "Shipment created", dayOffset: 0 },
    ],
  },
  {
    owner: "customer2",
    serviceLevel: "STANDARD",
    destination: D("Buenos Aires", "AR", { postalCode: "C1000" }),
    parcel: { weightGrams: 6700, lengthCm: 45, widthCm: 35, heightCm: 30 },
    baseDaysAgo: 6,
    events: [
      ...happyPath("Panama City, PA"),
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
      ...happyPath("Panama City, PA"),
      { status: "EXCEPTION", location: "Quito, EC", description: "Address could not be verified", dayOffset: 4 },
      { status: "RETURNED_TO_SENDER", location: "Panama City, PA", description: "Returned to sender", dayOffset: 8 },
    ],
  },
  {
    owner: "customer2",
    serviceLevel: "EXPRESS",
    destination: D("Houston", "US", { state: "TX", postalCode: "77001" }),
    parcel: { weightGrams: 1500, lengthCm: 22, widthCm: 18, heightCm: 14 },
    baseDaysAgo: 1,
    events: [
      { status: "CREATED", location: "Panama City, PA", description: "Shipment created", dayOffset: 0 },
      { status: "LABEL_PAID", location: "Panama City, PA", description: "Label paid", dayOffset: 0 },
      { status: "CANCELLED", location: "Panama City, PA", description: "Cancelled at customer request", dayOffset: 0 },
    ],
  },
];

async function main(): Promise<void> {
  // Clear transactional data (FK-safe order); keep nothing stale.
  await prisma.trackingEvent.deleteMany();
  await prisma.shipment.deleteMany();
  await prisma.address.deleteMany();
  await prisma.refreshToken.deleteMany();

  // Reference data.
  await seedReferenceData(prisma);

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const [, courier, customer1, customer2] = await Promise.all([
    prisma.user.upsert({
      where: { email: "admin@shippinghub.test" },
      create: { email: "admin@shippinghub.test", name: "Ops Admin", role: "ADMIN", passwordHash },
      update: { passwordHash, role: "ADMIN" },
    }),
    prisma.user.upsert({
      where: { email: "courier@shippinghub.test" },
      create: { email: "courier@shippinghub.test", name: "Field Courier", role: "COURIER", passwordHash },
      update: { passwordHash, role: "COURIER" },
    }),
    prisma.user.upsert({
      where: { email: "ana@example.com" },
      create: { email: "ana@example.com", name: "Ana Pérez", role: "CUSTOMER", passwordHash },
      update: { passwordHash },
    }),
    prisma.user.upsert({
      where: { email: "luis@example.com" },
      create: { email: "luis@example.com", name: "Luis Gómez", role: "CUSTOMER", passwordHash },
      update: { passwordHash },
    }),
  ]);
  const owners = { customer1, customer2 };

  // Allocate sequences after the demo set so API-created shipments continue cleanly.
  let sequence = 1000;
  const year = new Date().getUTCFullYear();
  const createdCodes: string[] = [];

  for (const seed of SHIPMENTS) {
    sequence += 1;
    const trackingCode = buildTrackingCode(year, sequence);
    const zoneCode = resolveZoneCode(seed.destination.country);
    const [baseCents, perKgCents, , etaMaxDays] = RATES[zoneCode][seed.serviceLevel];
    const billable = billableWeightGrams(
      seed.parcel.weightGrams,
      seed.parcel.lengthCm,
      seed.parcel.widthCm,
      seed.parcel.heightCm,
    );
    const priceCents = computePriceCents({ serviceLevel: seed.serviceLevel, baseCents, perKgCents, etaMinDays: 0, etaMaxDays }, billable);

    const base = new Date();
    base.setUTCDate(base.getUTCDate() - seed.baseDaysAgo);
    base.setUTCHours(13, 0, 0, 0);
    const eventTime = (offset: number): Date => {
      const t = new Date(base.getTime());
      t.setUTCDate(t.getUTCDate() + offset);
      return t;
    };

    const finalStatus = seed.events[seed.events.length - 1].status;
    await prisma.shipment.create({
      data: {
        trackingCode,
        user: { connect: { id: owners[seed.owner].id } },
        serviceLevel: seed.serviceLevel,
        status: finalStatus,
        weightGrams: seed.parcel.weightGrams,
        lengthCm: seed.parcel.lengthCm,
        widthCm: seed.parcel.widthCm,
        heightCm: seed.parcel.heightCm,
        priceCents,
        currency: "USD",
        zoneCode,
        estimatedDeliveryAt: addBusinessDays(base, etaMaxDays),
        createdAt: base,
        originAddress: { create: { ...ORIGIN } },
        destinationAddress: { create: { ...seed.destination } },
        events: {
          create: seed.events.map((event) => ({
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
    createdCodes.push(`${trackingCode}  ${finalStatus}`);
  }

  await prisma.counter.upsert({
    where: { id: "shipment" },
    create: { id: "shipment", value: sequence },
    update: { value: sequence },
  });

  console.log("Seed complete.");
  console.log(`Demo password for all accounts: ${DEMO_PASSWORD}`);
  console.log(`Accounts: admin@shippinghub.test (ADMIN), courier@shippinghub.test (COURIER), ana@example.com & luis@example.com (CUSTOMER)`);
  console.log("Shipments:");
  for (const line of createdCodes) console.log(`  ${line}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
