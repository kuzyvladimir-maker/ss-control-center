/**
 * Amazon Growth — bulk AI-advisor worker ("stage 2").
 *
 * Drains the AmazonAdvisorQueue: for each queued listing it runs the LLM Growth
 * Advisor (adviseListing), stores the diagnosis + ranked action plan, and — when
 * autoApply is on — executes the SAFE, deterministic subset of the plan:
 *   - optimizer actions      → dedupe duplicate attrs + brand-voice title scrub
 *   - set-attribute actions  → only the structural suppression attrs
 *     (unit_count / item_weight), each VALIDATION_PREVIEW-checked before writing.
 * Content/price/keyword/manual actions are recorded as recommendations, never
 * auto-written. Every write lands in the change log. LLM = real cost, so this is
 * operator-triggered (drained from the UI), not a cron.
 */

import type { PrismaClient } from "@/generated/prisma/client";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { getListing, patchListing, listSkus, type ListingPatch } from "@/lib/amazon-sp-api/listings";
import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import { adviseListing, BULK_ADVISOR_MODEL, type AdvisorInput, type AdvisorAction } from "./advisor";
import { summarizeForAdvisor } from "./learning-store";
import { buildPlan, applyPlan } from "./optimizer";
import { logChange, logOptimizerChanges } from "./change-log";
import { getAttributeForm, buildAttributeEntry } from "./product-type-definitions";
import { scoreListing, computeHealthScore, pickTopFix } from "./listing-health";

const PACING_MS = 600; // LLM + writes — gentler pacing than the deterministic worker
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Only these attributes are auto-written from an LLM suggestion. They're the
// structural, search-suppression-clearing fields — safe and easy to validate.
// Everything else (content, keywords, price) stays a reviewed recommendation.
const SAFE_AUTO_ATTRS = new Set(["unit_count", "item_weight"]);

export interface AdvisorDrainResult {
  processed: number;
  done: number;
  skipped: number;
  errored: number;
  actionsApplied: number;
  remaining: number;
  durationMs: number;
}

function parseIssues(s: string | null): Array<{ code: string; message: string }> {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map((i) => ({ code: String(i.code ?? ""), message: String(i.message ?? "") })) : [];
  } catch {
    return [];
  }
}

function buildInput(it: {
  sku: string; asin: string | null; itemName: string | null; productType: string | null;
  isSuppressed: boolean; isBuyable: boolean; suppressionReason: string | null;
  healthScore: number | null; buyabilityScore: number | null; issuesScore: number | null;
  contentScore: number | null; complianceScore: number | null; buyBoxScore: number | null;
  conversionScore: number | null; errorIssueCount: number; issuesSummary: string | null;
  impressions30d: number | null; clicks30d: number | null; ctr: number | null;
  sessions30d: number | null; pageViews30d: number | null; cartAdds30d: number | null;
  cartAddRate: number | null; unitsOrdered30d: number | null; unitSessionPct: number | null;
  purchases30d: number | null; purchaseRate: number | null; buyBoxPercentage: number | null;
  revenue30d: number | null; returns30d: number | null; returnRate: number | null;
}): AdvisorInput {
  const status: AdvisorInput["status"] = it.isSuppressed ? "suppressed" : it.isBuyable ? "live" : "inactive";
  return {
    sku: it.sku, asin: it.asin, itemName: it.itemName, productType: it.productType, status,
    suppressionReason: it.suppressionReason, healthScore: it.healthScore,
    components: {
      buyability: it.buyabilityScore, issues: it.issuesScore, content: it.contentScore,
      compliance: it.complianceScore, buyBox: it.buyBoxScore, conversion: it.conversionScore,
    },
    errorIssueCount: it.errorIssueCount, issues: parseIssues(it.issuesSummary),
    impressions30d: it.impressions30d, clicks30d: it.clicks30d, ctr: it.ctr,
    sessions30d: it.sessions30d, pageViews30d: it.pageViews30d, cartAdds30d: it.cartAdds30d,
    cartAddRate: it.cartAddRate, unitsOrdered30d: it.unitsOrdered30d, unitSessionPct: it.unitSessionPct,
    purchases30d: it.purchases30d, purchaseRate: it.purchaseRate, buyBoxPercentage: it.buyBoxPercentage,
    revenue30d: it.revenue30d, returns30d: it.returns30d, returnRate: it.returnRate,
  };
}

/** Write ONE attribute (PTD-valid), validating first. Handles nested sub-fields
 *  like "unit_count.type" by patching the whole parent. Logs to the audit trail. */
async function writeAttribute(
  prisma: PrismaClient, storeIndex: number, sellerId: string, sku: string,
  productType: string, attribute: string, value: string,
  attrs: Record<string, Array<Record<string, unknown>> | undefined>,
): Promise<{ applied: boolean; note: string }> {
  const dot = attribute.indexOf(".");
  const parentAttr = dot >= 0 ? attribute.slice(0, dot) : attribute;
  const subField = dot >= 0 ? attribute.slice(dot + 1) : null;
  const existing = attrs[parentAttr];
  const form = await getAttributeForm(storeIndex, productType, parentAttr).catch(() => null);

  let entry: Record<string, unknown>;
  if (subField) {
    const base: Record<string, unknown> = existing?.[0] ? { ...existing[0] } : { marketplace_id: MARKETPLACE_ID };
    const ef = form?.enumFields.find((e) => e.name === subField);
    base[subField] = ef?.nested ? { value: value.trim(), language_tag: "en_US" } : value.trim();
    entry = base;
  } else if (form) {
    // unit_count needs a valid count type; item_weight a valid unit — supply the
    // common safe default when the schema requires it and we don't have one.
    const sub: Record<string, string> = {};
    for (const ef of form.enumFields) {
      const cur = existing?.[0]?.[ef.name];
      const curVal = ef.nested ? (cur as { value?: string } | undefined)?.value : (cur as string | undefined);
      if (typeof curVal === "string" && ef.allowed.includes(curVal)) sub[ef.name] = curVal;
      else if (parentAttr === "unit_count" && ef.name === "type" && ef.allowed.includes("Count")) sub[ef.name] = "Count";
    }
    entry = buildAttributeEntry(form, value, sub);
    if (existing?.[0]) entry = { ...existing[0], ...entry };
  } else {
    return { applied: false, note: `${attribute}: no schema` };
  }

  const patches: ListingPatch[] = [{ op: existing ? "replace" : "add", path: `/attributes/${parentAttr}`, value: [entry] }];
  const preview = await patchListing(storeIndex, sellerId, sku, productType, patches, { validationPreview: true });
  if (preview?.status !== "VALID") return { applied: false, note: `${attribute} skipped: ${preview?.issues?.[0]?.message ?? preview?.status}` };

  const resp = await patchListing(storeIndex, sellerId, sku, productType, patches, {});
  if (resp?.status !== "ACCEPTED") return { applied: false, note: `${attribute} rejected: ${resp?.status}` };
  await logChange(prisma, {
    storeIndex, sku, source: "advisor", changeType: "attribute-set", field: attribute,
    beforeValue: existing?.[0] ?? null, afterValue: entry, patch: patches,
    submissionId: resp?.submissionId, amazonStatus: resp?.status,
  }).catch(() => {});
  return { applied: true, note: `${attribute}=${value}` };
}

/** Analyze one listing with the LLM and apply the safe executable subset. */
async function processAdvise(
  prisma: PrismaClient, storeIndex: number, sellerId: string, sku: string, autoApply: boolean,
): Promise<{
  status: "DONE" | "SKIPPED" | "ERROR";
  diagnosis?: string; rootCause?: string; expectedOutcome?: string; confidence?: string;
  actions?: AdvisorAction[]; actionsApplied: number; result: string;
}> {
  const item = await prisma.amazonListingHealthItem.findUnique({
    where: { amazon_health_item_dedup: { storeIndex, sku } },
  });
  if (!item) return { status: "SKIPPED", actionsApplied: 0, result: "not in mirror" };

  const learnings = await summarizeForAdvisor(prisma, storeIndex, item.productType).catch(() => "");
  const plan = await adviseListing(buildInput(item), { model: BULK_ADVISOR_MODEL, thinking: "off", learnings });
  const notes: string[] = [];
  let applied = 0;

  if (autoApply) {
    // Deterministic optimizer fixes (run once if the plan calls for them).
    if (plan.actions.some((a) => a.execution.mode === "optimizer")) {
      const opt = await buildPlan(storeIndex, sellerId, sku, JSON.parse(item.issuesSummary ?? "[]"));
      if (opt.changes.length > 0) {
        const res = await applyPlan(storeIndex, sellerId, opt, false);
        if (res.applied) {
          applied += opt.changes.length;
          notes.push(`optimizer: ${opt.changes.map((c) => c.kind).join("+")}`);
          await logOptimizerChanges(prisma, storeIndex, sku, opt, res, "advisor").catch(() => {});
        }
      }
    }

    // Structural set-attribute fixes (unit_count / item_weight only).
    const setAttrs = plan.actions.filter(
      (a) => a.execution.mode === "set-attribute" && a.execution.attribute && a.execution.suggestedValue &&
        SAFE_AUTO_ATTRS.has(a.execution.attribute.split(".")[0]),
    );
    if (setAttrs.length > 0) {
      const listing = await getListing(storeIndex, sellerId, sku);
      const summary = listing.summaries?.find((s) => s.marketplaceId === MARKETPLACE_ID) ?? listing.summaries?.[0];
      const productType = summary?.productType;
      const attrs = (listing.attributes ?? {}) as Record<string, Array<Record<string, unknown>> | undefined>;
      if (productType) {
        const seen = new Set<string>();
        for (const a of setAttrs) {
          const attr = a.execution.attribute!;
          if (seen.has(attr)) continue;
          seen.add(attr);
          const r = await writeAttribute(prisma, storeIndex, sellerId, sku, productType, attr, a.execution.suggestedValue!, attrs);
          if (r.applied) applied++;
          notes.push(r.note);
        }
      }
    }

    if (applied > 0) await rescore(prisma, storeIndex, sellerId, sku);
  }

  const manualCount = plan.actions.filter((a) => a.execution.mode === "manual").length;
  if (notes.length === 0) notes.push(autoApply ? `analyzed · ${plan.actions.length} actions (${manualCount} manual)` : "analyzed (no auto-apply)");

  return {
    status: "DONE",
    diagnosis: plan.diagnosis, rootCause: plan.rootCause, expectedOutcome: plan.expectedOutcome, confidence: plan.confidence,
    actions: plan.actions, actionsApplied: applied, result: notes.join(" · "),
  };
}

/** Drain up to `max` queued AI-advisor items within `budgetMs`. */
export async function drainAdvisorQueue(
  prisma: PrismaClient, opts: { budgetMs?: number; max?: number } = {},
): Promise<AdvisorDrainResult> {
  const startedAt = Date.now();
  const budgetMs = opts.budgetMs ?? 110_000;
  const max = opts.max ?? 20;

  // Reclaim rows left RUNNING by a previous batch killed mid-flight (e.g. a
  // function timeout). The UI drains sequentially, so any RUNNING now is stale.
  await prisma.amazonAdvisorQueue.updateMany({ where: { status: "RUNNING" }, data: { status: "REQUESTED" } });

  const sellerIds = new Map<number, string>();
  let processed = 0, done = 0, skipped = 0, errored = 0, actionsApplied = 0;

  for (let i = 0; i < max; i++) {
    if (Date.now() - startedAt > budgetMs) break;
    const row = await prisma.amazonAdvisorQueue.findFirst({ where: { status: "REQUESTED" }, orderBy: { queuedAt: "asc" } });
    if (!row) break;
    await prisma.amazonAdvisorQueue.update({ where: { id: row.id }, data: { status: "RUNNING" } });

    try {
      let sellerId = sellerIds.get(row.storeIndex);
      if (!sellerId) { sellerId = await getMerchantToken(row.storeIndex); sellerIds.set(row.storeIndex, sellerId); }
      const out = await processAdvise(prisma, row.storeIndex, sellerId, row.sku, row.autoApply);
      await prisma.amazonAdvisorQueue.update({
        where: { id: row.id },
        data: {
          status: out.status,
          diagnosis: out.diagnosis ?? null, rootCause: out.rootCause ?? null,
          expectedOutcome: out.expectedOutcome ?? null, confidence: out.confidence ?? null,
          actionsJson: out.actions ? JSON.stringify(out.actions) : null,
          actionsApplied: out.actionsApplied, result: out.result, processedAt: new Date(),
        },
      });
      processed++;
      actionsApplied += out.actionsApplied;
      if (out.status === "DONE") done++;
      else skipped++;
    } catch (err) {
      await prisma.amazonAdvisorQueue.update({
        where: { id: row.id },
        data: { status: "ERROR", error: (err as Error).message, processedAt: new Date() },
      });
      processed++;
      errored++;
    }
    await sleep(PACING_MS);
  }

  const remaining = await prisma.amazonAdvisorQueue.count({ where: { status: "REQUESTED" } });
  return { processed, done, skipped, errored, actionsApplied, remaining, durationMs: Date.now() - startedAt };
}

/** Re-read + re-score the SKU after writes so the worklist updates. */
async function rescore(prisma: PrismaClient, storeIndex: number, sellerId: string, sku: string): Promise<void> {
  const page = await listSkus(storeIndex, sellerId, { pageSize: 1, includedData: ["summaries", "issues"] });
  const raw = page.items.find((i) => i.sku === sku);
  if (!raw) return;
  const s = scoreListing(raw as unknown as Record<string, unknown>);
  const existing = await prisma.amazonListingHealthItem.findUnique({ where: { amazon_health_item_dedup: { storeIndex, sku } } });
  if (!existing) return;
  const components = {
    buyability: s.components.buyability, issues: s.components.issues, content: existing.contentScore,
    compliance: s.components.compliance, buyBox: existing.buyBoxScore, conversion: existing.conversionScore,
  };
  await prisma.amazonListingHealthItem.update({
    where: { amazon_health_item_dedup: { storeIndex, sku } },
    data: {
      itemName: s.itemName, buyabilityScore: s.components.buyability, issuesScore: s.components.issues,
      complianceScore: s.components.compliance, errorIssueCount: s.errorIssueCount, warningIssueCount: s.warningIssueCount,
      issuesSummary: JSON.stringify(s.issues), isSuppressed: s.isSuppressed, isDiscoverable: s.isDiscoverable,
      healthScore: computeHealthScore(components), topFixComponent: pickTopFix(components),
    },
  });
}
