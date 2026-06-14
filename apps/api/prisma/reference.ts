// Reference data (zones + rates) shared by the seed script and the test harness
// so they never drift. Origin is always Panama; destination country picks a zone.
import type { ServiceLevel } from "@shipping-hub/shared";
import type { PrismaClient } from "@prisma/client";

export const ZONES = [
  { code: "PA", name: "Panama (domestic)" },
  { code: "US", name: "United States" },
  { code: "LATAM", name: "Latin America" },
];

// [baseCents, perKgCents, etaMinDays, etaMaxDays] per zone & service level.
export const RATES: Record<string, Record<ServiceLevel, [number, number, number, number]>> = {
  PA: { EXPRESS: [800, 150, 1, 1], STANDARD: [500, 100, 1, 2], ECONOMY: [350, 70, 2, 3] },
  US: { EXPRESS: [2500, 600, 1, 3], STANDARD: [1500, 400, 3, 6], ECONOMY: [1000, 250, 6, 10] },
  LATAM: { EXPRESS: [3000, 800, 2, 4], STANDARD: [1800, 500, 4, 8], ECONOMY: [1200, 300, 8, 14] },
};

export async function seedReferenceData(client: PrismaClient): Promise<void> {
  for (const zone of ZONES) {
    const created = await client.zone.upsert({
      where: { code: zone.code },
      create: zone,
      update: { name: zone.name },
    });
    for (const [serviceLevel, [baseCents, perKgCents, etaMinDays, etaMaxDays]] of Object.entries(
      RATES[zone.code],
    )) {
      await client.rate.upsert({
        where: {
          zoneId_serviceLevel: { zoneId: created.id, serviceLevel: serviceLevel as ServiceLevel },
        },
        create: {
          zoneId: created.id,
          serviceLevel: serviceLevel as ServiceLevel,
          baseCents,
          perKgCents,
          etaMinDays,
          etaMaxDays,
        },
        update: { baseCents, perKgCents, etaMinDays, etaMaxDays },
      });
    }
  }
}
