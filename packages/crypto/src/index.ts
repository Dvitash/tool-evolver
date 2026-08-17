import { createHash } from "node:crypto";

export function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export const CRYPTO_VERSION = "0.1.0";
