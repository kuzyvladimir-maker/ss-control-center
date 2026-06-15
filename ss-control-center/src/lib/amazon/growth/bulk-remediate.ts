/**
 * Amazon Growth — bulk remediation worker.
 *
 * Drains the AmazonRemediationQueue: for each queued listing, applies the chosen
 * SAFE fixes via the Listings API, records the outcome, re-scores the SKU. This
 * is the Walmart-style "filter → pool → Fix all" engine — the operator no longer
 * fixes listings one at a time.
 *
 * Fixes (each gated by the queue row's scope):
 *  - dedupe / brandVoice : deterministic optimizer plan (dedupe duplicate
 *    attributes + scrub promo/emoji from the title). No guessing.
 *  - suppression : for search-suppressed listings, derive the missing structural
 *    attribute from the TITLE (e.g. "Pack of 4" → unit_count = 4 Count; "1 lb" →
 *    item_weight = 1 pounds), build a SCHEMA-VALID PATCH via Product Type
 *    Definitions, and only write it if Amazon's VALIDATION_PREVIEW returns VALID.
 *    Anything not confidently derivable is SKIPPED with a reason — never guessed.
 */

import type { PrismaClient } from "@/generated/prisma/client";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { getListing, patchListing, type ListingPatch } from "@/lib/amazon-sp-api/listings";
import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import { buildPlan, applyPlan } from "./optimizer";
import { logChange, logOptimizerChanges } from "./change-log";
import { getAttributeForm, buildAttributeEntry } from "./product-type-definitions";
import { scoreListing, computeHealthScore, pickTopFix, type HealthIssue } from "./listing-health";
import { listSkus } from "@/lib/amazon-sp-api/listings";

const PACING_MS = 350;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface QueueScope {
  dedupe?: boolean;
  brandVoice?: boolean;
  suppression?: boolean;
}

export interface DrainResult {
  processed: number;
  done: number;
  skipped: number;
  errored: number;
  changesTotal: number;
  remaining: number;
  durationMs: number;
}

function parseIssues(s: string | null): HealthIssue[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function deriveUnitCount(title: string | null): number | null {
  const m = title?.match(/pack of (\d+)/i);
  return m ? Number(m[1]) : null;
}
function deriveWeight(title: string | null): { value: number; unit: string } | null {
  const m = title?.match(/(\d+(?:\.\d+)?)\s*(lbs?|pounds?|oz|ounces?)\b/i);
  if (!m) return null;
  const unit = /oz|ounce/i.test(m[2]) ? "ounces" : "pounds";
  return { value: Number(m[1]), unit };
}

/** Write one attribute (PTD-valid), validating first; logs to the audit trail. */
async function writeAttribute(
  prisma: PrismaClient,
  storeIndex: number,
  sellerId: string,
  sku: string,
  productType: string,
  attribute: string,
  value: string,
  subValues: Record<string, string>,
  existing: Array<Record<string, unknown>> | undefined,
): Promise<{ applied: boolean; status?: string; issue?: string }> {
  const form = await getAttributeForm(storeIndex, productType, attribute).catch(() => null);
  if (!form) return { applied: false, issue: "no schema" };
  let entry = buildAttributeEntry(form, value, subValues);
  if (existing?.[0]) entry = { ...existing[0], ...entry };
  const patches: ListingPatch[] = [{ op: existing ? "replace" : "add", path: `/attributes/${attribute}`, value: [entry] }];

  // Validate first.
  const preview = await patchListing(storeIndex, sellerId, sku, productType, patches, { validationPreview: true });
  if (preview?.status !== "VALID") {
    return { applied: false, status: preview?.status, issue: preview?.issues?.[0]?.message };
  }
  const resp = await patchListing(storeIndex, sellerId, sku, productType, patches, {});
  const applied = resp?.status === "ACCEPTED";
  if (applied) {
    await logChange(prisma, {
      storeIndex, sku, source: "bulk", changeType: "attribute-set", field: attribute,
      beforeValue: existing?.[0] ?? null, afterValue: entry, patch: patches,
      submissionId: resp?.submissionId, amazonStatus: resp?.status,
    }).catch(() => {});
  }
  return { applied, status: resp?.status, issue: resp?.issues?.[0]?.message };
}

/** Process one queued SKU. Returns the new status + change count + result note. */
async function processItem(
  prisma: PrismaClient,
  storeIndex: number,
  sellerId: string,
  sku: string,
  scope: QueueScope,
): Promise<{ status: "DONE" | "SKIPPED" | "ERROR"; changes: number; result: string; error?: string }> {
  const item = await prisma.amazonListingHealthItem.findUnique({
    where: { amazon_health_item_dedup: { storeIndex, sku } },
  });
  if (!item) return { status: "SKIPPED", changes: 0, result: "not in mirror" };

  const notes: string[] = [];
  let changes = 0;

  // 1. Deterministic optimizer fixes (dedupe + brand-voice scrub).
  if (scope.dedupe || scope.brandVoice) {
    const plan = await buildPlan(storeIndex, sellerId, sku, parseIssues(item.issuesSummary));
    if (plan.changes.length > 0) {
      const res = await applyPlan(storeIndex, sellerId, plan, false);
      if (res.applied) {
        changes += plan.changes.length;
        notes.push(`optimizer: ${plan.changes.map((c) => c.kind).join("+")}`);
        await logOptimizerChanges(prisma, storeIndex, sku, plan, res, "bulk").catch(() => {});
      } else if (res.status === "INVALID") {
        notes.push(`optimizer rejected: ${(res.issues?.[0] as { message?: string })?.message ?? "invalid"}`);
      }
    }
  }

  // 2. Suppression fix — derive structural attributes from the title (PTD-valid).
  if (scope.suppression && item.isSuppressed) {
    const listing = await getListing(storeIndex, sellerId, sku);
    const summary = listing.summaries?.find((s) => s.marketplaceId === MARKETPLACE_ID) ?? listing.summaries?.[0];
    const productType = summary?.productType;
    const title = summary?.itemName ?? item.itemName;
    const attrs = (listing.attributes ?? {}) as Record<string, Array<Record<string, unknown>> | undefined>;
    if (productType) {
      const unitCount = deriveUnitCount(title);
      if (unitCount != null) {
        const r = await writeAttribute(prisma, storeIndex, sellerId, sku, productType, "unit_count", String(unitCount), { type: "Count" }, attrs.unit_count);
        if (r.applied) { changes++; notes.push(`unit_count=${unitCount} Count`); }
        else notes.push(`unit_count skipped: ${r.issue ?? r.status}`);
      }
      const weight = deriveWeight(title);
      if (weight) {
        const r = await writeAttribute(prisma, storeIndex, sellerId, sku, productType, "item_weight", String(weight.value), { unit: weight.unit }, attrs.item_weight);
        if (r.applied) { changes++; notes.push(`item_weight=${weight.value} ${weight.unit}`); }
        else notes.push(`item_weight skipped: ${r.issue ?? r.status}`);
      }
    } else {
      notes.push("suppression skipped: no productType");
    }
  }

  if (changes > 0) await rescore(prisma, storeIndex, sellerId, sku);
  return {
    status: changes > 0 ? "DONE" : "SKIPPED",
    changes,
    result: notes.join(" · ") || "nothing to change",
  };
}

/** Drain up to `max` queued items within `budgetMs`. */
export async function drainQueue(
  prisma: PrismaClient,
  opts: { budgetMs?: number; max?: number } = {},
): Promise<DrainResult> {
  const startedAt = Date.now();
  const budgetMs = opts.budgetMs ?? 110_000;
  const max = opts.max ?? 60;

  const sellerIds = new Map<number, string>();
  let processed = 0, done = 0, skipped = 0, errored = 0, changesTotal = 0;

  for (let i = 0; i < max; i++) {
    if (Date.now() - startedAt > budgetMs) break;
    const row = await prisma.amazonRemediationQueue.findFirst({
      where: { status: "REQUESTED" },
      orderBy: { queuedAt: "asc" },
    });
    if (!row) break;
    await prisma.amazonRemediationQueue.update({ where: { id: row.id }, data: { status: "RUNNING" } });

    try {
      let sellerId = sellerIds.get(row.storeIndex);
      if (!sellerId) {
        sellerId = await getMerchantToken(row.storeIndex);
        sellerIds.set(row.storeIndex, sellerId);
      }
      const scope = JSON.parse(row.scope) as QueueScope;
      const out = await processItem(prisma, row.storeIndex, sellerId, row.sku, scope);
      await prisma.amazonRemediationQueue.update({
        where: { id: row.id },
        data: { status: out.status, changesApplied: out.changes, result: out.result, processedAt: new Date() },
      });
      processed++;
      changesTotal += out.changes;
      if (out.status === "DONE") done++;
      else skipped++;
    } catch (err) {
      await prisma.amazonRemediationQueue.update({
        where: { id: row.id },
        data: { status: "ERROR", error: (err as Error).message, processedAt: new Date() },
      });
      processed++;
      errored++;
    }
    await sleep(PACING_MS);
  }

  const remaining = await prisma.amazonRemediationQueue.count({ where: { status: "REQUESTED" } });
  return { processed, done, skipped, errored, changesTotal, remaining, durationMs: Date.now() - startedAt };
}

/** Re-read + re-score the SKU after writes so the worklist updates. */
async function rescore(prisma: PrismaClient, storeIndex: number, sellerId: string, sku: string): Promise<void> {
  const page = await listSkus(storeIndex, sellerId, { pageSize: 1, includedData: ["summaries", "issues"] });
  const raw = page.items.find((i) => i.sku === sku);
  if (!raw) return;
  const s = scoreListing(raw as unknown as Record<string, unknown>);
  const existing = await prisma.amazonListingHealthItem.findUnique({
    where: { amazon_health_item_dedup: { storeIndex, sku } },
  });
  if (!existing) return;
  const components = {
    buyability: s.components.buyability,
    issues: s.components.issues,
    content: existing.contentScore,
    compliance: s.components.compliance,
    buyBox: existing.buyBoxScore,
    conversion: existing.conversionScore,
  };
  await prisma.amazonListingHealthItem.update({
    where: { amazon_health_item_dedup: { storeIndex, sku } },
    data: {
      itemName: s.itemName,
      buyabilityScore: s.components.buyability,
      issuesScore: s.components.issues,
      complianceScore: s.components.compliance,
      errorIssueCount: s.errorIssueCount,
      warningIssueCount: s.warningIssueCount,
      issuesSummary: JSON.stringify(s.issues),
      isSuppressed: s.isSuppressed,
      isDiscoverable: s.isDiscoverable,
      healthScore: computeHealthScore(components),
      topFixComponent: pickTopFix(components),
    },
  });
}
