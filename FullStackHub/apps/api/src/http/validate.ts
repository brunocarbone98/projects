import type { z } from "zod";
import { badRequest } from "./errors.js";

/** Parses unknown input against a schema, throwing a 400 AppError on failure. */
export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw badRequest("Invalid request", result.error.issues);
  }
  return result.data;
}
