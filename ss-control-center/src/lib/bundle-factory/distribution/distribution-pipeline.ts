/**
 * Phase 2.5 Stage 7 — Distribution pipeline orchestrator.
 *
 * For every PASSED ChannelSKU of a draft, submit to the right
 * marketplace. Batch with rate-limit, abort on >max-error-rate, send
 * Telegram alerts on first-ever success and on every failure.
 *
 * Safety invariants (per spec — non-negotiable):
 *   1. DRY RUN by default. Real submission requires opts.apply=true.
 *   2. NEVER publish without explicit recorded human approval.
 *   3. NEVER publish a ChannelSKU whose validation_status !== 'PASSED' or
 *      whose derived available_quantity is unknown/zero.
 *   4. Skip channels with skipReason (SIRIUS no app, RETAILER suspended).
 *   5. Skip channels already LIVE (idempotent).
 *   6. Per-marketplace rate limit + sleep.
 *   7. Auto-abort if batch error rate exceeds threshold.
 *   8. PUT is idempotent — re-running on already-submitted SKU is safe.
 */

import { prisma } from "@/lib/prisma";
import type { ChannelSKU } from "@/generated/prisma/client";

import { logLifecycle } from "@/lib/bundle-factory/lifecycle-log";
import { sendTelegramMessage } from "@/lib/telegram";

import { channelTarget } from "./account-map";
import { productTypeForBundle } from "@/lib/bundle-factory/attributes";
import {
  submitToAmazon,
  type AmazonPublishResult,
} from "./amazon-publish";
import {
  submitToWalmart,
  type WalmartPublishResult,
} from "./walmart-publish";
import {
  INVENTORY_MAX_AGE_MS,
  inventoryIsFresh,
} from "../inventory-policy";
import { parseVerifiedPhysicalPackageSpecs } from "../physical-package-specs";
import { amazonAllergensFromStoredDeclarations } from "../allergen-declaration";
import { isOwnBrandPassthrough } from "../own-brand";
import {
  preflightProductionUncrustablesMain,
  type UncrustablesMainPublishPermit,
} from "../audit/uncrustables-main-production-preflight";

// Amazon SP-API Listings PUT: 5 req/sec per store; we use 4 to leave
// headroom. Walmart: 8 req/sec per store; we use 6.
const SLEEP_MS_AMAZON = 250;
const SLEEP_MS_WALMART = 170;

export interface RunDistributionInput {
  bundle_draft_id: string;
  /** Optional subset of channels to process; default = every PASSED SKU. */
  channels?: string[];
  /** Default false. true → real PUT/POST. false → dry run, prints
   *  payload only (no marketplace mutation, no Telegram). */
  apply?: boolean;
  /** Max per-batch error rate before auto-abort. Default 0.10. */
  maxErrorRate?: number;
  /** SKUs per batch (sleep MS between SKUs inside a batch; longer
   *  pause between batches handled outside). Default 5. */
  batchSize?: number;
  /** Optional override for the Amazon productType used in payload.
   *  Defaults to "PRODUCT". */
  amazonProductType?: string;
  /** Default false. When true, re-PUT rows that are already LIVE instead of
   *  skipping them — used to REPLACE the main image on a published listing
   *  (PUT is create-or-replace, so the new main_image_url overwrites the old).
   *  See scripts/_img_replace.ts (the composite image-replacement driver). */
  republish?: boolean;
  actor?: string;
}

export interface ChannelDistributionOutcome {
  sku_id: string;
  sku: string;
  channel: string;
  marketplace_kind: string;
  status: "SUBMITTED" | "LIVE" | "FAILED" | "SKIPPED";
  submission_id: string | null;
  issues: Array<{ code?: string; message?: string; severity?: string }>;
  marketplace_status: string | null;
  skip_reason?: string;
  dry_run: boolean;
  /** The exact payload we sent (or would have sent in dry-run). */
  payload: Record<string, unknown>;
  error?: string;
}

export interface RunDistributionResult {
  ok: boolean;
  bundle_draft_id: string;
  per_sku: ChannelDistributionOutcome[];
  draft_status: string;
  apply: boolean;
  aborted: boolean;
  aborted_reason?: string;
  duration_ms: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function persistOutcome(
  sku: ChannelSKU,
  outcome: ChannelDistributionOutcome,
): Promise<void> {
  if (outcome.dry_run) return; // dry-run doesn't mutate DB

  const next: Record<string, unknown> = {
    distribution_attempt_count: { increment: 1 },
    last_status_check_at: new Date(),
    distribution_errors: outcome.issues.length
      ? JSON.stringify(outcome.issues)
      : null,
  };
  if (outcome.submission_id) {
    next.submission_id = outcome.submission_id;
    next.submitted_at = new Date();
  }
  if (outcome.status === "LIVE") {
    next.listing_status = "LIVE";
    next.lifecycle_status = "LIVE";
    next.published_at = new Date();
  } else if (outcome.status === "FAILED") {
    next.listing_status = "FAILED";
    next.lifecycle_status = "ERROR";
    next.last_error_at = new Date();
  } else if (outcome.status === "SUBMITTED") {
    next.listing_status = "SUBMITTED";
    next.lifecycle_status = "SUBMITTED";
  }
  await prisma.channelSKU.update({
    where: { id: sku.id },
    data: next,
  });
  await logLifecycle({
    entity_type: "ChannelSKU",
    entity_id: sku.id,
    from_status: sku.listing_status,
    to_status: outcome.status,
    reason:
      outcome.status === "LIVE"
        ? `Published to ${outcome.marketplace_kind}`
        : outcome.status === "SUBMITTED"
          ? `Submitted to ${outcome.marketplace_kind} — awaiting terminal status`
          : outcome.status === "FAILED"
            ? `${outcome.marketplace_kind} rejected — ${outcome.issues.length} issue(s)`
            : "skipped",
    actor: "distribution-pipeline",
    details: {
      submission_id: outcome.submission_id,
      marketplace_status: outcome.marketplace_status,
      issues_count: outcome.issues.length,
    },
  });
}

async function sendSuccessAlert(
  draftId: string,
  outcome: ChannelDistributionOutcome,
): Promise<void> {
  // Bundle publish pings OFF by default (Vladimir 2026-06-08 — redundant with
  // the Bundle Factory UI). This also gates the "FIRST publish" milestone and
  // the failure alert below; flip TELEGRAM_BUNDLE_PUBLISH_ENABLED=true on Vercel
  // to restore them.
  if (process.env.TELEGRAM_BUNDLE_PUBLISH_ENABLED !== "true") return;
  // First-ever success for THIS account is the historic moment Vladimir
  // wants to know about. We approximate via "this draft × this channel
  // has no prior LIVE published_at".
  const prior = await prisma.channelSKU.count({
    where: {
      id: { not: outcome.sku_id },
      channel: outcome.channel,
      listing_status: "LIVE",
    },
  });
  const isFirstEver = prior === 0;
  const headline = isFirstEver
    ? `🎉 <b>FIRST ${outcome.channel} publish</b>`
    : `✓ ${outcome.channel} published`;
  await sendTelegramMessage(
    `${headline}\n` +
      `Draft: <code>${draftId}</code>\n` +
      `SKU: <code>${outcome.sku}</code>\n` +
      `Submission: <code>${outcome.submission_id ?? "n/a"}</code>`,
  );
}

async function sendFailureAlert(
  draftId: string,
  outcome: ChannelDistributionOutcome,
): Promise<void> {
  // Gated by the same flag as success/milestone pings (see sendSuccessAlert).
  if (process.env.TELEGRAM_BUNDLE_PUBLISH_ENABLED !== "true") return;
  const top = outcome.issues
    .slice(0, 3)
    .map((i) => `• ${i.code ?? ""} ${i.message ?? ""}`)
    .join("\n");
  await sendTelegramMessage(
    `❌ <b>${outcome.channel} publish FAILED</b>\n` +
      `Draft: <code>${draftId}</code>\n` +
      `SKU: <code>${outcome.sku}</code>\n` +
      `${top || outcome.error || "no issue text"}`,
  );
}

export async function runDistribution(
  input: RunDistributionInput,
): Promise<RunDistributionResult> {
  const startMs = Date.now();
  const apply = input.apply === true;
  const maxErrorRate = input.maxErrorRate ?? 0.1;
  const batchSize = input.batchSize ?? 5;

  const draft = await prisma.bundleDraft.findUnique({
    where: { id: input.bundle_draft_id },
    select: {
      id: true,
      status: true,
      approved_at: true,
      master_bundle_id: true,
    },
  });
  if (!draft) throw new Error(`BundleDraft ${input.bundle_draft_id} not found`);
  if (!draft.master_bundle_id) {
    throw new Error(
      `BundleDraft ${draft.id} has no MasterBundle yet — run validate first (which lazy-promotes).`,
    );
  }
  if (apply && !draft.approved_at) {
    throw new Error(
      `BundleDraft ${draft.id} has no recorded operator approval — approve it before real distribution.`,
    );
  }

  // Phase 5 — Walmart prohibits frozen/perishable cold-chain food, so frozen/
  // refrigerated sets are Amazon-only. Resolve the bundle's category once and
  // skip Walmart SKUs below when it's cold.
  const masterBundle = await prisma.masterBundle.findUnique({
    where: { id: draft.master_bundle_id },
    select: {
      category: true,
      brand: true,
      pack_count: true,
      packaging_spec: true,
      components: {
        select: {
          allergens: true,
          product_name: true,
          flavor: true,
          qty: true,
        },
      },
    },
  });
  const isColdBundle = /FROZEN|REFRIGERATED/i.test(masterBundle?.category ?? "");
  const isFoodBundle =
    isOwnBrandPassthrough(masterBundle?.brand) ||
    /FROZEN|REFRIGERATED|CHILLED|SHELF|GROCERY|FOOD|DRY/i.test(
      masterBundle?.category ?? "",
    );
  const verifiedPhysicalSpecs = parseVerifiedPhysicalPackageSpecs(
    masterBundle?.packaging_spec,
  );
  const verifiedAllergens = isFoodBundle
    ? amazonAllergensFromStoredDeclarations(
        masterBundle?.components.map((component) => component.allergens) ?? [],
      )
    : null;
  if (isFoodBundle && (masterBundle?.components.length ?? 0) === 0) {
    throw new Error(
      `MasterBundle ${draft.master_bundle_id} has no reviewed component allergen declarations`,
    );
  }

  // Fail closed: only fully PASSED SKUs with component-derived positive stock.
  const skus = await prisma.channelSKU.findMany({
    where: {
      master_bundle_id: draft.master_bundle_id,
      validation_status: "PASSED",
      available_quantity: { gt: 0 },
      inventory_checked_at: {
        gte: new Date(Date.now() - INVENTORY_MAX_AGE_MS),
      },
      ...(input.channels && input.channels.length > 0
        ? { channel: { in: input.channels } }
        : {}),
    },
  });
  if (skus.length === 0) {
    return {
      ok: false,
      bundle_draft_id: draft.id,
      per_sku: [],
      draft_status: draft.status,
      apply,
      aborted: false,
      duration_ms: Date.now() - startMs,
    };
  }

  // Fail closed before the first distribution mutation. For Uncrustables, a
  // generic image QA flag is insufficient: read the exact R2 MAIN bytes and
  // require a sealed owner approval for this SKU, hash, physical count, exact
  // flavor quantities, carton/wrapper mode, and retail package size. Already-
  // LIVE rows not being republished and administratively skipped accounts do
  // not enter the publish path and therefore do not need a permit.
  const uncrustablesMainPermits = new Map<string, UncrustablesMainPublishPermit>();
  if (isOwnBrandPassthrough(masterBundle?.brand)) {
    const candidates = skus.filter((sku) => {
      const target = channelTarget(sku.channel);
      return (
        target.kind === "amazon" &&
        !target.skipReason &&
        (sku.listing_status !== "LIVE" || input.republish === true)
      );
    });
    const checked = await Promise.all(
      candidates.map(async (sku) => ({
        sku,
        result: await preflightProductionUncrustablesMain({
          sku: sku.sku,
          main_image_url: sku.main_image_url ?? "",
          pack_count: masterBundle?.pack_count ?? 0,
          components:
            masterBundle?.components.map((component) => ({
              product_name: component.product_name,
              flavor: component.flavor,
              qty: component.qty,
            })) ?? [],
        }),
      })),
    );
    const blocked = checked.filter(({ result }) => !result.pass || !result.permit);
    if (blocked.length > 0) {
      const blockedById = new Map(blocked.map((item) => [item.sku.id, item.result]));
      return {
        ok: false,
        bundle_draft_id: draft.id,
        per_sku: candidates.map((sku) => {
          const result = blockedById.get(sku.id);
          const error = result
            ? result.findings
                .map((item) => `${item.code}: ${item.message}`)
                .join("; ")
            : "Batch held because another Uncrustables MAIN failed authenticity preflight";
          return {
            sku_id: sku.id,
            sku: sku.sku,
            channel: sku.channel,
            marketplace_kind: "amazon",
            status: result ? "FAILED" : "SKIPPED",
            submission_id: null,
            issues: result
              ? result.findings.map((item) => ({
                  code: item.code,
                  severity: "ERROR",
                  message: item.message,
                }))
              : [],
            marketplace_status: null,
            skip_reason: result ? undefined : error,
            dry_run: !apply,
            payload: {},
            error,
          } satisfies ChannelDistributionOutcome;
        }),
        draft_status: draft.status,
        apply,
        aborted: true,
        aborted_reason:
          "Uncrustables MAIN authenticity preflight blocked before any distribution mutation",
        duration_ms: Date.now() - startMs,
      };
    }
    for (const { sku, result } of checked) {
      uncrustablesMainPermits.set(sku.id, result.permit!);
    }
  }

  // Draft → PUBLISHING (only when real apply; dry-run leaves state).
  let workingStatus = draft.status;
  if (apply && draft.status !== "PUBLISHING") {
    await prisma.bundleDraft.update({
      where: { id: draft.id },
      data: { status: "PUBLISHING" },
    });
    await logLifecycle({
      entity_type: "BundleDraft",
      entity_id: draft.id,
      from_status: draft.status,
      to_status: "PUBLISHING",
      reason: `Distribution started for ${skus.length} ChannelSKU(s)`,
      actor: input.actor ?? "system",
    });
    workingStatus = "PUBLISHING";
    await prisma.masterBundle.update({
      where: { id: draft.master_bundle_id },
      data: { lifecycle_status: "PUBLISHING" },
    });
  }

  const per_sku: ChannelDistributionOutcome[] = [];
  let aborted = false;
  let abortedReason: string | undefined;

  for (let batchStart = 0; batchStart < skus.length; batchStart += batchSize) {
    const batch = skus.slice(batchStart, batchStart + batchSize);
    let batchSuccess = 0;
    let batchFailed = 0;
    for (const sku of batch) {
      const target = channelTarget(sku.channel);

      // Walmart channel gate: frozen/refrigerated food is prohibited on Walmart
      // Marketplace → skip cold SKUs there (frozen sets publish on Amazon only).
      if (isColdBundle && (target.kind === "walmart" || sku.channel === "WALMART")) {
        per_sku.push({
          sku_id: sku.id,
          sku: sku.sku,
          channel: sku.channel,
          marketplace_kind: target.kind,
          status: "SKIPPED",
          submission_id: null,
          issues: [],
          marketplace_status: null,
          skip_reason:
            "Walmart prohibits frozen/perishable food — frozen/refrigerated sets are Amazon-only",
          dry_run: !apply,
          payload: {},
        });
        continue;
      }

      // Defense in depth against a future query regression.
      if (
        sku.validation_status !== "PASSED" ||
        (sku.available_quantity ?? 0) <= 0 ||
        !inventoryIsFresh(sku.inventory_checked_at)
      ) {
        per_sku.push({
          sku_id: sku.id,
          sku: sku.sku,
          channel: sku.channel,
          marketplace_kind: target.kind,
          status: "SKIPPED",
          submission_id: null,
          issues: [],
          marketplace_status: null,
          skip_reason: `validation_status=${sku.validation_status}, available_quantity=${sku.available_quantity ?? "unknown"}, inventory_checked_at=${sku.inventory_checked_at?.toISOString() ?? "missing"} (must be PASSED with recent positive verified inventory)`,
          dry_run: !apply,
          payload: {},
        });
        continue;
      }
      // Skip accounts that are administratively unable to publish.
      if (target.skipReason) {
        per_sku.push({
          sku_id: sku.id,
          sku: sku.sku,
          channel: sku.channel,
          marketplace_kind: target.kind,
          status: "SKIPPED",
          submission_id: null,
          issues: [],
          marketplace_status: null,
          skip_reason: target.skipReason,
          dry_run: !apply,
          payload: {},
        });
        continue;
      }
      // Idempotency: already-LIVE rows aren't re-published — UNLESS republish is
      // set (image replacement: PUT create-or-replace overwrites the main image).
      if (sku.listing_status === "LIVE" && !input.republish) {
        per_sku.push({
          sku_id: sku.id,
          sku: sku.sku,
          channel: sku.channel,
          marketplace_kind: target.kind,
          status: "LIVE",
          submission_id: sku.submission_id,
          issues: [],
          marketplace_status: "ALREADY_LIVE",
          skip_reason: "already LIVE — PUT skipped (idempotent re-run)",
          dry_run: !apply,
          payload: {},
        });
        continue;
      }

      let outcome: ChannelDistributionOutcome;
      if (target.kind === "amazon") {
        const r: AmazonPublishResult = await submitToAmazon({
          sku,
          storeIndex: target.storeIndex,
          productType: input.amazonProductType ?? productTypeForBundle(),
          brand: masterBundle?.brand,
          category: masterBundle?.category,
          physicalPackageSpecs: verifiedPhysicalSpecs,
          verifiedAllergens,
          uncrustablesMainPermit: uncrustablesMainPermits.get(sku.id),
          dryRun: !apply,
          // Every real PUT is validation-previewed. submitToAmazon enforces
          // this independently as a second guard for retry/recovery callers.
          validatePreviewFirst: apply,
        });
        outcome = {
          sku_id: sku.id,
          sku: sku.sku,
          channel: sku.channel,
          marketplace_kind: "amazon",
          status: r.ok
            ? r.dry_run
              ? "SUBMITTED"
              : "SUBMITTED"
            : "FAILED",
          submission_id: r.submission_id,
          issues: r.issues,
          marketplace_status: r.amazon_status,
          dry_run: r.dry_run,
          payload: r.payload,
          error: r.error,
        };
        await sleep(SLEEP_MS_AMAZON);
      } else if (target.kind === "walmart") {
        const r: WalmartPublishResult = await submitToWalmart({
          sku,
          storeIndex: target.storeIndex,
          brand: masterBundle?.brand,
          packCount: masterBundle?.pack_count,
          physicalPackageSpecs: verifiedPhysicalSpecs,
          dryRun: !apply,
        });
        outcome = {
          sku_id: sku.id,
          sku: sku.sku,
          channel: sku.channel,
          marketplace_kind: "walmart",
          status: r.ok ? "SUBMITTED" : "FAILED",
          submission_id: r.feed_id,
          issues: r.issues,
          marketplace_status: r.walmart_status,
          dry_run: r.dry_run,
          payload: r.payload,
          error: r.error,
        };
        await sleep(SLEEP_MS_WALMART);
      } else {
        outcome = {
          sku_id: sku.id,
          sku: sku.sku,
          channel: sku.channel,
          marketplace_kind: target.kind,
          status: "SKIPPED",
          submission_id: null,
          issues: [],
          marketplace_status: null,
          skip_reason: `${target.kind} distribution not implemented`,
          dry_run: !apply,
          payload: {},
        };
      }

      per_sku.push(outcome);
      if (outcome.status === "FAILED") batchFailed++;
      else if (outcome.status === "SUBMITTED" || outcome.status === "LIVE") batchSuccess++;

      await persistOutcome(sku, outcome);

      if (apply && outcome.status === "SUBMITTED") {
        await sendSuccessAlert(draft.id, outcome).catch(() => {});
      } else if (apply && outcome.status === "FAILED") {
        await sendFailureAlert(draft.id, outcome).catch(() => {});
      }
    }
    const processed = batchSuccess + batchFailed;
    const rate = processed > 0 ? batchFailed / processed : 0;
    if (apply && rate > maxErrorRate && processed >= 3) {
      aborted = true;
      abortedReason = `Batch error rate ${(rate * 100).toFixed(0)}% > threshold ${(maxErrorRate * 100).toFixed(0)}%`;
      break;
    }
    // Long pause between batches as a courtesy to the marketplace.
    if (batchStart + batchSize < skus.length) await sleep(1000);
  }

  // Terminal draft transition.
  let nextStatus = workingStatus;
  if (apply) {
    const live = per_sku.filter((s) => s.status === "LIVE").length;
    const submitted = per_sku.filter((s) => s.status === "SUBMITTED").length;
    const failed = per_sku.filter((s) => s.status === "FAILED").length;
    if (live === per_sku.length && per_sku.length > 0) {
      nextStatus = "PUBLISHED";
    } else if (failed === per_sku.length && workingStatus === "PUBLISHING") {
      nextStatus = "ERROR";
    } else if (
      (live > 0 || submitted > 0) &&
      workingStatus === "PUBLISHING" &&
      !aborted
    ) {
      // Leave at PUBLISHING — poller will lift to PUBLISHED later.
      nextStatus = "PUBLISHING";
    }
    if (nextStatus !== workingStatus) {
      await prisma.bundleDraft.update({
        where: { id: draft.id },
        data: { status: nextStatus },
      });
      await logLifecycle({
        entity_type: "BundleDraft",
        entity_id: draft.id,
        from_status: workingStatus,
        to_status: nextStatus,
        reason: `Distribution finished — ${live} LIVE, ${submitted} SUBMITTED, ${failed} FAILED${aborted ? " (aborted)" : ""}`,
        actor: input.actor ?? "system",
      });
    }
  }

  return {
    ok: per_sku.some((s) => s.status === "SUBMITTED" || s.status === "LIVE"),
    bundle_draft_id: draft.id,
    per_sku,
    draft_status: nextStatus,
    apply,
    aborted,
    aborted_reason: abortedReason,
    duration_ms: Date.now() - startMs,
  };
}
