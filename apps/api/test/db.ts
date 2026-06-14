import { seedReferenceData } from "../prisma/reference.js";
import { prisma } from "../src/prisma.js";

const SHIPMENT_COUNTER_START = 1000;

/** Wipes transactional tables and resets the tracking counter for isolation. */
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "tracking_events", "shipments", "addresses", "refresh_tokens", "users" RESTART IDENTITY CASCADE;`,
  );
  await prisma.counter.upsert({
    where: { id: "shipment" },
    create: { id: "shipment", value: SHIPMENT_COUNTER_START },
    update: { value: SHIPMENT_COUNTER_START },
  });
}

export async function ensureReferenceData(): Promise<void> {
  await seedReferenceData(prisma);
}
