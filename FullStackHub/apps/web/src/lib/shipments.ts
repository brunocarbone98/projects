import type {
  CreateShipmentInput,
  CreateTrackingEventInput,
  PaginatedDto,
  ShipmentDto,
  ShipmentStatus,
} from "@shipping-hub/shared";
import { serverApi } from "./server-api";

export async function listShipments(params: {
  status?: ShipmentStatus;
  page?: number;
  pageSize?: number;
}): Promise<PaginatedDto<ShipmentDto>> {
  const search = new URLSearchParams();
  if (params.status) search.set("status", params.status);
  if (params.page) search.set("page", String(params.page));
  if (params.pageSize) search.set("pageSize", String(params.pageSize));
  const qs = search.toString();
  return serverApi<PaginatedDto<ShipmentDto>>(`/api/v1/shipments${qs ? `?${qs}` : ""}`);
}

export async function getShipment(id: string): Promise<ShipmentDto> {
  return serverApi<ShipmentDto>(`/api/v1/shipments/${encodeURIComponent(id)}`);
}

export async function createShipment(input: CreateShipmentInput): Promise<ShipmentDto> {
  return serverApi<ShipmentDto>("/api/v1/shipments", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function addTrackingEvent(
  id: string,
  input: CreateTrackingEventInput,
): Promise<ShipmentDto> {
  return serverApi<ShipmentDto>(`/api/v1/shipments/${encodeURIComponent(id)}/events`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
