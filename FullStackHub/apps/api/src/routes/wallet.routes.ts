import { TopUpSchema } from "@shipping-hub/shared";
import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { unauthenticated } from "../http/errors.js";
import { parseOrThrow } from "../http/validate.js";
import * as walletService from "../services/wallet.service.js";

export const walletRouter: Router = Router();

walletRouter.use(requireAuth);

walletRouter.get("/", async (req, res) => {
  if (!req.auth) throw unauthenticated();
  res.json(await walletService.getWallet(req.auth.sub));
});

walletRouter.post("/topup", async (req, res) => {
  if (!req.auth) throw unauthenticated();
  const input = parseOrThrow(TopUpSchema, req.body ?? {});
  res.json(await walletService.topUp(req.auth.sub, input));
});
