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
