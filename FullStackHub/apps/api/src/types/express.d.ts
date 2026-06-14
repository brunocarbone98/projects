import type { AccessClaims } from "../auth/tokens.js";

declare global {
  namespace Express {
    interface Request {
      auth?: AccessClaims;
    }
  }
}

export {};
