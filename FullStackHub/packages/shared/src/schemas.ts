// API contracts: Zod schemas validate input at the edge; DTO types describe
// the JSON the API returns. Both web and api import from here — never duplicate.

import { z } from "zod";
import { SERVICE_LEVELS, SHIPMENT_STATUSES } from "./enums";
import type { ServiceLevel, ShipmentStatus, UserRole } from "./enums";

// ---------------------------------------------------------------------------
// Input schemas (request validation)
// ---------------------------------------------------------------------------

export const RegisterSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(120),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

export const LoginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const RefreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshInput = z.infer<typeof RefreshSchema>;

export const AddressInputSchema = z.object({
  contactName: z.string().min(1).max(120),
  line1: z.string().min(1).max(160),
  line2: z.string().max(160).optional(),
  city: z.string().min(1).max(120),
  state: z.string().max(120).optional(),
  postalCode: z.string().min(1).max(32),
  country: z
    .string()
    .length(2)
    .transform((value) => value.toUpperCase()),
  phone: z.string().max(40).optional(),
});
export type AddressInput = z.infer<typeof AddressInputSchema>;

export const ParcelSchema = z.object({
  weightGrams: z.int().positive().max(70_000),
  lengthCm: z.int().positive().max(300),
  widthCm: z.int().positive().max(300),
  heightCm: z.int().positive().max(300),
});
export type ParcelInput = z.infer<typeof ParcelSchema>;

export const CreateShipmentSchema = z.object({
  origin: AddressInputSchema,
  destination: AddressInputSchema,
  serviceLevel: z.enum(SERVICE_LEVELS),
  parcel: ParcelSchema,
});
export type CreateShipmentInput = z.infer<typeof CreateShipmentSchema>;

export const CreateTrackingEventSchema = z.object({
  status: z.enum(SHIPMENT_STATUSES),
  location: z.string().max(160).optional(),
  description: z.string().max(280).optional(),
  occurredAt: z.iso.datetime().optional(),
});
export type CreateTrackingEventInput = z.infer<typeof CreateTrackingEventSchema>;

export const ListShipmentsQuerySchema = z.object({
  status: z.enum(SHIPMENT_STATUSES).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});
export type ListShipmentsQuery = z.infer<typeof ListShipmentsQuerySchema>;

export const QuoteRequestSchema = z.object({
  originCountry: z
    .string()
    .length(2)
    .default("PA")
    .transform((value) => value.toUpperCase()),
  destinationCountry: z
    .string()
    .length(2)
    .transform((value) => value.toUpperCase()),
  weightGrams: z.int().positive().max(70_000),
  lengthCm: z.int().positive().max(300),
  widthCm: z.int().positive().max(300),
  heightCm: z.int().positive().max(300),
  serviceLevel: z.enum(SERVICE_LEVELS),
});
export type QuoteRequestInput = z.infer<typeof QuoteRequestSchema>;

// ---------------------------------------------------------------------------
// Output DTOs (response shapes)
// ---------------------------------------------------------------------------

export interface UserDto {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
}

export interface AuthTokensDto {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number; // access token lifetime in seconds
}

export interface AuthResponseDto {
  user: UserDto;
  tokens: AuthTokensDto;
}

export interface AddressDto {
  contactName: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  postalCode: string;
  country: string;
  phone: string | null;
}

export interface ParcelDto {
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

export interface TrackingEventDto {
  id: string;
  status: ShipmentStatus;
  location: string | null;
  description: string | null;
  occurredAt: string;
}

export interface ShipmentDto {
  id: string;
  trackingCode: string;
  status: ShipmentStatus;
  serviceLevel: ServiceLevel;
  origin: AddressDto;
  destination: AddressDto;
  parcel: ParcelDto;
  priceCents: number;
  currency: string;
  zoneCode: string;
  estimatedDeliveryAt: string | null;
  createdAt: string;
  updatedAt: string;
  events: TrackingEventDto[];
}

/** Minimal, PII-free projection served by the public tracking endpoint. */
export interface PublicTrackingEventDto {
  status: ShipmentStatus;
  location: string | null;
  description: string | null;
  occurredAt: string;
}

export interface PublicTrackingDto {
  trackingCode: string;
  status: ShipmentStatus;
  serviceLevel: ServiceLevel;
  origin: { city: string; country: string };
  destination: { city: string; country: string };
  estimatedDeliveryAt: string | null;
  createdAt: string;
  events: PublicTrackingEventDto[];
}

export interface QuoteDto {
  zoneCode: string;
  serviceLevel: ServiceLevel;
  billableWeightGrams: number;
  priceCents: number;
  currency: string;
  etaMinDays: number;
  etaMaxDays: number;
  estimatedDeliveryAt: string;
}

export interface PaginatedDto<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ApiErrorDto {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
