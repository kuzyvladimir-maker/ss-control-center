/**
 * Amazon Growth — Optimizer (deterministic, safe auto-fixes).
 *
 * Phase C closes the loop: turn the Listing Health issue backlog into actual
 * PATCHes. We only do DETERMINISTIC, low-risk fixes here — no guessing of
 * structural data (missing unit_count etc. routes to the sourcing harvest,
 * same policy as Walmart):
 *
 *   1. Title brand-voice scrub — strip emojis + promotional adjectives from
 *      item_name (the PDP-99300 / brand-voice violations the compliance
 *      component flags). Reuses the proven content-scrub regexes.
 *   2. Duplicate-attribute dedupe — Amazon issue 99016 ("a maximum of N
 *      occurrence(s) … but it currently occurs M times"): keep the first N.
 *
 * Every fix is previewed (before/after) and applied through patchListing with
 * a VALIDATION_PREVIEW gate before the real write. Idempotent: a listing with
 * nothing to fix yields an empty plan.
 */

import { getListing, patchListing, type ListingPatch } from "@/lib/amazon-sp-api/listings";
import { scrubDescription } from "@/lib/bundle-factory/remediation/content-scrub";
import type { HealthIssue } from "./listing-health";

const MARKETPLACE_ID = process.env.AMAZON_SP_MARKETPLACE_ID || "ATVPDKIKX0DER";

export type FixKind = "title-scrub" | "dedupe-attribute";

export interface OptimizerChange {
  kind: FixKind;
  field: string;
  before: string;
  after: string;
}

export interface OptimizerPlan {
  sku: string;
  asin: string | null;
  productType: string | null;
  changes: OptimizerChange[];
  patches: ListingPatch[];
  /** Issues we could NOT auto-fix (need real data / manual) — surfaced to UI. */
  unfixable: string[];
}

interface AttrValue {
  value?: string;
  marketplace_id?: string;
  language_tag?: string;
  [k: string]: unknown;
}

/** Scrub a title: strip emoji + promo words, keep it a single clean line. */
function scrubTitle(input: string): string {
  return scrubDescription(input).replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim();
}

/** Parse "a maximum of N occurrence(s)" from a 99016-style message. */
function parseMaxOccurrences(message: string): number | null {
  const m = message.match(/maximum of (\d+) occurrence/i);
  return m ? Number(m[1]) : null;
}

/**
 * Build a remediation plan for one SKU. Fetches the live listing (attributes +
 * productType), computes deterministic fixes against its stored issues, and
 * returns before/after changes + the JSON-Patch operations. No writes.
 */
export async function buildPlan(
  storeIndex: number,
  sellerId: string,
  sku: string,
  issues: HealthIssue[],
): Promise<OptimizerPlan> {
  const listing = await getListing(storeIndex, sellerId, sku);
  const summary = listing.summaries?.find((s) => s.marketplaceId === MARKETPLACE_ID) ?? listing.summaries?.[0];
  const productType = summary?.productType ?? null;
  const asin = summary?.asin ?? null;
  const attrs = (listing.attributes ?? {}) as Record<string, AttrValue[] | undefined>;

  const changes: OptimizerChange[] = [];
  const patches: ListingPatch[] = [];
  const unfixable: string[] = [];

  // ── 1. Title brand-voice scrub ──
  const nameArr = attrs.item_name;
  const nameEntry = nameArr?.find((v) => v.marketplace_id === MARKETPLACE_ID) ?? nameArr?.[0];
  if (nameEntry?.value) {
    const cleaned = scrubTitle(nameEntry.value);
    if (cleaned && cleaned !== nameEntry.value) {
      changes.push({ kind: "title-scrub", field: "item_name", before: nameEntry.value, after: cleaned });
      patches.push({
        op: "replace",
        path: "/attributes/item_name",
        value: [{ ...nameEntry, value: cleaned }],
      });
    }
  }

  // ── 2. Duplicate-attribute dedupe (issue 99016 et al.) ──
  for (const iss of issues) {
    const max = parseMaxOccurrences(iss.message);
    if (max == null) continue;
    for (const attrName of iss.attributeNames) {
      const arr = attrs[attrName];
      if (Array.isArray(arr) && arr.length > max) {
        const kept = arr.slice(0, max);
        changes.push({
          kind: "dedupe-attribute",
          field: attrName,
          before: `${arr.length} values`,
          after: `${kept.length} value(s)`,
        });
        patches.push({ op: "replace", path: `/attributes/${attrName}`, value: kept });
      }
    }
  }

  // ── Anything else with an ERROR severity we didn't touch is "unfixable" here ──
  for (const iss of issues) {
    if (iss.severity !== "ERROR") continue;
    const handled =
      parseMaxOccurrences(iss.message) != null ||
      iss.attributeNames.includes("item_name");
    if (!handled) unfixable.push(`${iss.code}: ${iss.message}`);
  }

  return { sku, asin, productType, changes, patches, unfixable };
}

export interface ApplyResult {
  sku: string;
  applied: boolean;
  dryRun: boolean;
  status?: string; // Amazon submission status: ACCEPTED | INVALID | …
  submissionId?: string;
  issues?: unknown[];
  error?: string;
  skipped?: "no-changes" | "no-product-type";
}

/**
 * Apply a plan via patchListing. With dryRun=true it hits Amazon's
 * VALIDATION_PREVIEW (no mutation) so the operator can confirm the patch is
 * accepted before the real write.
 */
export async function applyPlan(
  storeIndex: number,
  sellerId: string,
  plan: OptimizerPlan,
  dryRun: boolean,
): Promise<ApplyResult> {
  if (plan.patches.length === 0) return { sku: plan.sku, applied: false, dryRun, skipped: "no-changes" };
  if (!plan.productType) return { sku: plan.sku, applied: false, dryRun, skipped: "no-product-type" };

  try {
    const resp = await patchListing(storeIndex, sellerId, plan.sku, plan.productType, plan.patches, {
      validationPreview: dryRun,
    });
    return {
      sku: plan.sku,
      applied: !dryRun && resp?.status === "ACCEPTED",
      dryRun,
      status: resp?.status,
      submissionId: resp?.submissionId,
      issues: resp?.issues,
    };
  } catch (err) {
    return { sku: plan.sku, applied: false, dryRun, error: (err as Error).message };
  }
}
