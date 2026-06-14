import { LoginSchema, RefreshSchema, RegisterSchema } from "@shipping-hub/shared";
import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { unauthenticated } from "../http/errors.js";
import { parseOrThrow } from "../http/validate.js";
import * as authService from "../services/auth.service.js";

export const authRouter: Router = Router();

authRouter.post("/register", async (req, res) => {
  const input = parseOrThrow(RegisterSchema, req.body ?? {});
  res.status(201).json(await authService.register(input));
});

authRouter.post("/login", async (req, res) => {
  const input = parseOrThrow(LoginSchema, req.body ?? {});
  res.json(await authService.login(input));
});

authRouter.post("/refresh", async (req, res) => {
  const input = parseOrThrow(RefreshSchema, req.body ?? {});
  res.json(await authService.refresh(input));
});

authRouter.post("/logout", async (req, res) => {
  const input = parseOrThrow(RefreshSchema, req.body ?? {});
  await authService.logout(input);
  res.status(204).end();
});

authRouter.get("/me", requireAuth, async (req, res) => {
  if (!req.auth) throw unauthenticated();
  res.json({ user: await authService.getCurrentUser(req.auth.sub) });
});
