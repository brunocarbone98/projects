import {
  CreateShipmentSchema,
  CreateTrackingEventSchema,
  ListShipmentsQuerySchema,
} from "@shipping-hub/shared";
import { Router } from "express";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { unauthenticated } from "../http/errors.js";
import { parseOrThrow } from "../http/validate.js";
import * as shipmentService from "../services/shipment.service.js";

export const shipmentsRouter: Router = Router();

shipmentsRouter.use(requireAuth);

shipmentsRouter.get("/", async (req, res) => {
  if (!req.auth) throw unauthenticated();
  const query = parseOrThrow(ListShipmentsQuerySchema, req.query);
  res.json(await shipmentService.listShipments(req.auth, query));
});

shipmentsRouter.post("/", async (req, res) => {
  if (!req.auth) throw unauthenticated();
  const input = parseOrThrow(CreateShipmentSchema, req.body ?? {});
  res.status(201).json(await shipmentService.createShipment(input, req.auth.sub));
});

shipmentsRouter.get("/:id", async (req, res) => {
  if (!req.auth) throw unauthenticated();
  res.json(await shipmentService.getShipment(req.auth, String(req.params.id)));
});

shipmentsRouter.post("/:id/events", requireRole("ADMIN", "COURIER"), async (req, res) => {
  if (!req.auth) throw unauthenticated();
  const input = parseOrThrow(CreateTrackingEventSchema, req.body ?? {});
  res
    .status(201)
    .json(await shipmentService.addTrackingEvent(req.auth, String(req.params.id), input));
});
