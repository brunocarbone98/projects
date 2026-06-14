import type { WalletDto } from "@shipping-hub/shared";
import { serverApi } from "./server-api";

export function getWallet(): Promise<WalletDto> {
  return serverApi<WalletDto>("/api/v1/wallet");
}
