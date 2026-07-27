/**
 * Phase 2.5 Stage 7 — channel → marketplace account mapping for
 * distribution. Wraps the audit account-map and adds an explicit
 * skip-set covering accounts that aren't currently authorized.
 *
 * Sources of truth this depends on:
 *   CLAUDE.md "Аккаунты Amazon (5 штук)" table — store indices + status
 *   src/lib/bundle-factory/audit/account-map.ts — AccountKey enum
 */

import {
  storeIndexFor as auditStoreIndexFor,
  type AccountKey,
} from "@/lib/bundle-factory/audit/account-map";

export type MarketplaceKind = "amazon" | "walmart" | "ebay" | "tiktok";

export interface ChannelTarget {
  kind: MarketplaceKind;
  /** AccountKey for Amazon channels, undefined for Walmart/eBay/TikTok. */
  account?: AccountKey;
  /** SP-API store index (1-5) for Amazon. Walmart uses its own store index. */
  storeIndex: number;
  /** Reason this channel must be skipped, or null if publish is OK. */
  skipReason: string | null;
}

/**
 * Map ChannelSKU.channel to its marketplace target. Source of truth for
 * "where does this channel publish, and is the account currently OK to
 * publish to?". Skip reasons match CLAUDE.md status table.
 */
export function channelTarget(channel: string): ChannelTarget {
  switch (channel) {
    case "AMAZON_SALUTEM":
      return {
        kind: "amazon",
        account: "SALUTEM",
        storeIndex: auditStoreIndexFor("SALUTEM"),
        skipReason: null,
      };
    case "AMAZON_AMZCOM":
      return {
        kind: "amazon",
        account: "AMZCOM",
        storeIndex: auditStoreIndexFor("AMZCOM"),
        skipReason: null,
      };
    case "AMAZON_PERSONAL":
      return {
        kind: "amazon",
        account: "PERSONAL",
        storeIndex: auditStoreIndexFor("PERSONAL"),
        skipReason: null,
      };
    case "AMAZON_SIRIUS":
      return {
        kind: "amazon",
        account: "SIRIUS",
        storeIndex: auditStoreIndexFor("SIRIUS"),
        // CLAUDE.md: "Sirius International — TBD (no SP-API app yet)".
        skipReason:
          "STORE4 SIRIUS has no SP-API app configured. Create the app in Seller Central first.",
      };
    case "AMAZON_RETAILER":
      return {
        kind: "amazon",
        account: "RETAILER",
        storeIndex: auditStoreIndexFor("RETAILER"),
        // CLAUDE.md: "Retailer Distributor — US suspended 2026-05-17".
        skipReason:
          "STORE5 RETAILER is US-suspended (refresh_token revoked 2026-05-17). Re-authorize in Seller Central first.",
      };
    case "WALMART":
      return { kind: "walmart", storeIndex: 1, skipReason: null };
    case "EBAY":
      return {
        kind: "ebay",
        storeIndex: 1,
        skipReason: "eBay distribution not implemented (Phase 2.6+).",
      };
    case "TIKTOK_1":
    case "TIKTOK_2":
      return {
        kind: "tiktok",
        storeIndex: channel === "TIKTOK_1" ? 1 : 2,
        skipReason: "TikTok distribution not implemented (Phase 2.6+).",
      };
    default:
      return {
        kind: "amazon",
        storeIndex: 0,
        skipReason: `Unknown channel: ${channel}`,
      };
  }
}
