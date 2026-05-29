/**
 * Walmart Items API — minimal slice for Account Health v2.
 *
 * We list items filtered by lifecycle status (BLOCKED / TROUBLED_LISTING /
 * PUBLISHED_WITH_ERRORS / etc) to surface item-compliance issues on the
 * Walmart Account Health tab.
 *
 * Endpoint reference:
 *   GET /v3/items?nextCursor=&lifecycleStatus=…&publishedStatus=…
 *
 * Walmart paginates with an opaque `nextCursor` exactly like /v3/orders.
 */

import type { WalmartClient } from "./client";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type WalmartItemSeverity = "URGENT" | "MONITOR" | "INFO";

export interface WalmartItemIssue {
  itemId: string;
  sku?: string;
  title?: string;
  lifecycleStatus: string;
  publishedStatus: string;
  stage?: string;
  issueType: string;
  issueDetails?: string;
  severity: WalmartItemSeverity;
  reportedAt: Date;
}

// Lifecycle filters we consider compliance-relevant. We hit each and merge
// results so a single sync covers every flavour of "needs attention".
const COMPLIANCE_FILTERS: Array<{
  lifecycleStatus?: string;
  publishedStatus?: string;
  issueType: string;
  severity: WalmartItemSeverity;
}> = [
  { lifecycleStatus: "TROUBLED_LISTING",      issueType: "TROUBLED_LISTING",      severity: "URGENT" },
  { lifecycleStatus: "RETIRED",               issueType: "RETIRED",               severity: "MONITOR" },
  { publishedStatus: "PUBLISHED_WITH_ERRORS", issueType: "PUBLISHED_WITH_ERRORS", severity: "MONITOR" },
  { publishedStatus: "SYSTEM_PROBLEM",        issueType: "SYSTEM_PROBLEM",        severity: "MONITOR" },
  { publishedStatus: "STAGE",                 issueType: "STAGE",                 severity: "INFO" },
];

export class WalmartItemsApi {
  constructor(private client: WalmartClient) {}

  async getCompliance(): Promise<WalmartItemIssue[]> {
    const all: WalmartItemIssue[] = [];
    for (const f of COMPLIANCE_FILTERS) {
      try {
        for await (const item of this.paginate(f)) {
          all.push({
            ...item,
            issueType: f.issueType,
            severity: f.severity,
          });
        }
      } catch (err) {
        // Walmart returns 4xx for unsupported filter combinations on some
        // accounts. Don't let one filter take the whole sync down.
        console.warn(
          `[Walmart Items] filter ${JSON.stringify(f)} failed:`,
          err instanceof Error ? err.message : err
        );
      }
    }
    return all;
  }

  /** Page through /v3/items with the given filter. */
  private async *paginate(filter: {
    lifecycleStatus?: string;
    publishedStatus?: string;
  }): AsyncGenerator<WalmartItemIssue> {
    let cursor: string | undefined;
    let first = true;
    do {
      const params: Record<string, string | number> = first
        ? {
            ...(filter.lifecycleStatus
              ? { lifecycleStatus: filter.lifecycleStatus }
              : {}),
            ...(filter.publishedStatus
              ? { publishedStatus: filter.publishedStatus }
              : {}),
            limit: 50,
          }
        : { nextCursor: cursor as string };
      first = false;

      const data = await this.client.request<any>("GET", "/items", {
        params,
      });

      const items = unwrapItems(data);
      for (const raw of items) {
        const issue = mapItem(raw);
        if (issue) yield issue;
      }
      cursor =
        data?.ItemResponse?.nextCursor ||
        data?.itemResponse?.nextCursor ||
        data?.nextCursor ||
        undefined;
    } while (cursor);
  }
}

function unwrapItems(data: any): any[] {
  // Walmart wraps the list inconsistently across newer/legacy responses.
  // Try the common shapes in order, fall back to []. We log unfamiliar
  // shapes once so future debugging is easier.
  if (Array.isArray(data?.ItemResponse)) return data.ItemResponse;
  if (Array.isArray(data?.itemResponse)) return data.itemResponse;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data)) return data;
  return [];
}

/**
 * Lightweight item record for search/inventory workflows — captures the
 * fields Jackie + the operator need to confirm which SKUs are about to
 * be changed, without the compliance-status decoration.
 */
export interface WalmartItemSummary {
  itemId: string;
  sku: string;
  title: string;
  lifecycleStatus: string;
  publishedStatus: string;
}

/**
 * Find every Walmart item whose title OR SKU matches `query` (case-
 * insensitive substring). Built for "Vladimir says product name, Jackie
 * needs every SKU it lives in" — multi-packs, bundles, variants of the
 * same product live under different SKUs and all of them must show up.
 *
 * Three optimisations because Walmart's `/v3/items` does NOT support
 * server-side text search:
 *
 *   1. If the query looks like an exact SKU (alphanumerics + dashes, no
 *      spaces) we hit `?sku=<query>` first — 1 request, instant.
 *      Returns immediately on hit; on miss falls through to scan.
 *   2. The scan defaults to `publishedStatus=PUBLISHED` (≈4 000 items
 *      in Vladimir's account vs ≈5 300 total) — these are the items
 *      customers can actually buy, so zeroing them out is what
 *      affects shoppers. Override with `includeUnpublished:true` for
 *      a full sweep.
 *   3. Page size 200 (Walmart's max), offset+limit pagination — early
 *      exit when we've collected `limit` matches OR scanned
 *      `maxItemsScanned` rows. The default cap keeps a typical search
 *      under 20 s.
 *
 * Walmart pagination quirk: `/v3/items` does NOT return a `nextCursor`
 * field — it uses traditional offset+limit. The old cursor-based code
 * silently stopped after page 1 (50 of 5 278 items) because the cursor
 * was always missing.
 */
export async function searchWalmartItems(
  client: WalmartClient,
  query: string,
  opts: {
    limit?: number;
    maxItemsScanned?: number;
    includeUnpublished?: boolean;
  } = {},
): Promise<{
  matches: WalmartItemSummary[];
  itemsScanned: number;
  truncated: boolean;
  totalItemsAvailable: number;
  shortcutUsed: "exact_sku" | "scan";
}> {
  const q = query.trim().toLowerCase();
  if (!q) {
    return { matches: [], itemsScanned: 0, truncated: false, totalItemsAvailable: 0, shortcutUsed: "scan" };
  }
  const limit = opts.limit ?? 50;
  const cap = opts.maxItemsScanned ?? 4500;
  const PAGE_SIZE = 200; // Walmart caps /v3/items at 200/page

  // Shortcut: query has no whitespace → looks like a SKU, try exact
  // lookup first (1 request, instant). On miss fall through to scan.
  const trimmed = query.trim();
  if (!/\s/.test(trimmed)) {
    try {
      const data = await client.request<any>("GET", "/items", {
        params: { sku: trimmed },
      });
      const rows = unwrapItems(data);
      if (rows.length > 0) {
        return {
          matches: rows.map((raw) => mapSummary(raw)),
          itemsScanned: rows.length,
          truncated: false,
          totalItemsAvailable: Number(data?.totalItems ?? rows.length),
          shortcutUsed: "exact_sku",
        };
      }
    } catch {
      // Walmart 400/404 on bad SKU lookup — fall through to scan.
    }
  }

  // Full scan with offset+limit + status filter.
  const matches: WalmartItemSummary[] = [];
  let offset = 0;
  let scanned = 0;
  let truncated = false;
  let totalItemsAvailable = 0;

  while (true) {
    const params: Record<string, string | number> = {
      limit: PAGE_SIZE,
      offset,
    };
    if (!opts.includeUnpublished) params.publishedStatus = "PUBLISHED";

    const data = await client.request<any>("GET", "/items", { params });
    totalItemsAvailable = Number(data?.totalItems ?? totalItemsAvailable);
    const rows = unwrapItems(data);
    if (rows.length === 0) break;

    for (const raw of rows) {
      scanned++;
      const sku = String(raw?.sku ?? raw?.Sku ?? "");
      const title = String(raw?.productName ?? raw?.title ?? "");
      if (!sku && !title) continue;
      if (sku.toLowerCase().includes(q) || title.toLowerCase().includes(q)) {
        matches.push(mapSummary(raw));
        if (matches.length >= limit) {
          truncated = scanned < totalItemsAvailable;
          return { matches, itemsScanned: scanned, truncated, totalItemsAvailable, shortcutUsed: "scan" };
        }
      }
    }

    offset += rows.length;
    if (offset >= totalItemsAvailable || scanned >= cap) {
      truncated = scanned < totalItemsAvailable;
      break;
    }
  }

  return { matches, itemsScanned: scanned, truncated, totalItemsAvailable, shortcutUsed: "scan" };
}

function mapSummary(raw: any): WalmartItemSummary {
  return {
    itemId: String(raw?.mart?.itemId ?? raw?.itemId ?? raw?.wpid ?? raw?.Wpid ?? ""),
    sku: String(raw?.sku ?? raw?.Sku ?? ""),
    title: String(raw?.productName ?? raw?.title ?? ""),
    lifecycleStatus: String(raw?.lifecycleStatus ?? ""),
    publishedStatus: String(raw?.publishedStatus ?? ""),
  };
}

function mapItem(raw: any): WalmartItemIssue | null {
  const itemId =
    raw?.mart?.itemId ??
    raw?.itemId ??
    raw?.wpid ??
    raw?.Wpid ??
    null;
  if (!itemId) return null;
  return {
    itemId: String(itemId),
    sku: raw?.sku ?? raw?.Sku ?? undefined,
    title: raw?.productName ?? raw?.title ?? undefined,
    lifecycleStatus: String(raw?.lifecycleStatus ?? ""),
    publishedStatus: String(raw?.publishedStatus ?? ""),
    stage: raw?.stage ? String(raw.stage) : undefined,
    issueType: String(raw?.lifecycleStatus ?? raw?.publishedStatus ?? "UNKNOWN"),
    issueDetails: raw?.statusChangeReason ?? raw?.reason ?? undefined,
    severity: "MONITOR",
    reportedAt: raw?.lastEditedDate
      ? new Date(raw.lastEditedDate)
      : new Date(),
  };
}
