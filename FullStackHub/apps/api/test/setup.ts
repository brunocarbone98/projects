import { afterAll, beforeAll, beforeEach } from "vitest";
import { prisma } from "../src/prisma.js";
import { ensureReferenceData, resetDatabase } from "./db.js";

beforeAll(async () => {
  await ensureReferenceData();
});

beforeEach(async () => {
  await resetDatabase();
  await ensureReferenceData();
});

afterAll(async () => {
  await prisma.$disconnect();
});
