// Application errors with stable, machine-readable codes.

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "INVALID_CREDENTIALS"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "EMAIL_TAKEN"
  | "INVALID_TRANSITION"
  | "INVALID_TOKEN"
  | "RATE_LIMITED"
  | "INSUFFICIENT_FUNDS"
  | "ALREADY_PAID"
  | "LABEL_FAILED"
  | "INTERNAL";

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, "VALIDATION_ERROR", message, details);
export const unauthenticated = (message = "Authentication required") =>
  new AppError(401, "UNAUTHENTICATED", message);
export const invalidCredentials = (message = "Invalid email or password") =>
  new AppError(401, "INVALID_CREDENTIALS", message);
export const forbidden = (message = "You do not have access to this resource") =>
  new AppError(403, "FORBIDDEN", message);
export const notFound = (message = "Resource not found") => new AppError(404, "NOT_FOUND", message);
export const conflict = (code: ErrorCode, message: string, details?: unknown) =>
  new AppError(409, code, message, details);
