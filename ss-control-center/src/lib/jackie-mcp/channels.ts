/**
 * Channel parameter validation + mapping helpers for Jackie tools.
 * Reuses the existing audit AccountKey enum (Phase 2.0a) plus Walmart.
 */

import {
  storeIndexFor as auditStoreIndexFor,
  type AccountKey,
} from "@/lib/bundle-factory/audit/account-map";

export const JACKIE_CHANNELS = [
  "AMAZON_SALUTEM",
  "AMAZON_AMZCOM",
  "AMAZON_PERSONAL",
  "AMAZON_SIRIUS",
  "AMAZON_RETAILER",
  "WALMART",
] as const;
export type JackieChannel = (typeof JACKIE_CHANNELS)[number];

export function isJackieChannel(v: unknown): v is JackieChannel {
  return typeof v === "string" && (JACKIE_CHANNELS as readonly string[]).includes(v);
}

export function requireChannel(args: Record<string, unknown>, key = "channel"): JackieChannel {
  const v = args[key];
  if (!isJackieChannel(v)) {
    throw new Error(`Missing or invalid '${key}' — must be one of: ${JACKIE_CHANNELS.join(", ")}`);
  }
  return v;
}

export function requireAmazonChannel(args: Record<string, unknown>, key = "channel"): JackieChannel {
  const v = requireChannel(args, key);
  if (!v.startsWith("AMAZON_")) {
    throw new Error(`'${key}' must be an Amazon channel; got ${v}`);
  }
  return v;
}

export function amazonChannelToAccount(channel: JackieChannel): AccountKey {
  switch (channel) {
    case "AMAZON_SALUTEM": return "SALUTEM";
    case "AMAZON_AMZCOM": return "AMZCOM";
    case "AMAZON_PERSONAL": return "PERSONAL";
    case "AMAZON_SIRIUS": return "SIRIUS";
    case "AMAZON_RETAILER": return "RETAILER";
    default:
      throw new Error(`Not an Amazon channel: ${channel}`);
  }
}

export function amazonChannelToStoreIndex(channel: JackieChannel): number {
  return auditStoreIndexFor(amazonChannelToAccount(channel));
}

/** Common skip-set so write tools can fail fast on accounts known to be
 *  administratively unavailable. Mirrors distribution/account-map.ts. */
export function channelSkipReason(channel: JackieChannel): string | null {
  if (channel === "AMAZON_SIRIUS") {
    return "AMAZON_SIRIUS has no SP-API app configured. Skipped.";
  }
  if (channel === "AMAZON_RETAILER") {
    return "AMAZON_RETAILER is US-suspended (refresh_token revoked 2026-05-17). Skipped.";
  }
  return null;
}

/** Helper to validate optional string args against an allowed enum. */
export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new Error(`'${key}' must be a string`);
  }
  return v;
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`'${key}' must be a finite number`);
  }
  return v;
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") {
    throw new Error(`'${key}' must be a boolean`);
  }
  return v;
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`'${key}' is required`);
  }
  return v;
}
