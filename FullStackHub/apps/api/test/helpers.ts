import type {
  AuthResponseDto,
  CreateShipmentInput,
  ShipmentDto,
  UserRole,
} from "@shipping-hub/shared";
import type { Express } from "express";
import supertest from "supertest";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/passwords.js";
import { prisma } from "../src/prisma.js";

// High rate limit so ordinary tests never trip it; the rate-limit test builds its own app.
export const app: Express = buildApp({ publicRateLimitMax: 1000 });

export const api = () => supertest(app);

export const DEFAULT_PASSWORD = "Password123!";

export const sampleShipment: CreateShipmentInput = {
  origin: {
    contactName: "Warehouse",
    line1: "Calle 50",
    city: "Panama City",
    postalCode: "0801",
    country: "PA",
  },
  destination: {
    contactName: "Jane Doe",
    line1: "123 Ocean Drive",
    city: "Miami",
    state: "FL",
    postalCode: "33101",
    country: "US",
  },
  serviceLevel: "EXPRESS",
  parcel: { weightGrams: 2000, lengthCm: 30, widthCm: 20, heightCm: 15 },
};

export async function registerCustomer(email = "customer@example.com"): Promise<AuthResponseDto> {
  const res = await api()
    .post("/api/v1/auth/register")
    .send({ email, password: DEFAULT_PASSWORD, name: "Test Customer" });
  if (res.status !== 201) throw new Error(`registerCustomer failed: ${res.status} ${res.text}`);
  return res.body as AuthResponseDto;
}

/** Creates a user with an elevated role directly, then logs in to obtain tokens. */
export async function createStaff(
  role: UserRole,
  email = `${role.toLowerCase()}@example.com`,
): Promise<AuthResponseDto> {
  await prisma.user.create({
    data: { email, name: `${role} User`, role, passwordHash: await hashPassword(DEFAULT_PASSWORD) },
  });
  const res = await api().post("/api/v1/auth/login").send({ email, password: DEFAULT_PASSWORD });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.text}`);
  return res.body as AuthResponseDto;
}

export const bearer = (token: string) => `Bearer ${token}`;

export async function createShipment(
  token: string,
  overrides: Partial<CreateShipmentInput> = {},
): Promise<ShipmentDto> {
  const res = await api()
    .post("/api/v1/shipments")
    .set("Authorization", bearer(token))
    .send({ ...sampleShipment, ...overrides });
  if (res.status !== 201) throw new Error(`createShipment failed: ${res.status} ${res.text}`);
  return res.body as ShipmentDto;
}
