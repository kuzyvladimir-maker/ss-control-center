/**
 * Phase 2.5 Stage 7 — Distribution pipeline orchestrator.
 *
 * For every PASSED ChannelSKU of a draft, submit to the right
 * marketplace. Batch with rate-limit, abort on >max-error-rate, send
 * Telegram alerts on first-ever success and on every failure.
 *
 * Safety invariants (per spec — non-negotiable):
 *   1. DRY RUN by default. Real submission requires opts.apply=true.
 *   2. NEVER publish a ChannelSKU whose validation_status !== 'PASSED'.
 *   3. Skip channels with skipReason (SIRIUS no app, RETAILER suspended).
 *   4. Skip channels already LIVE (idempotent).
 *   5. Per-marketplace rate limit + sleep.
 *   6. Auto-abort if batch error rate exceeds threshold.
 *   7. PUT is idempotent — re-running on already-submitted SKU is safe.
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
    next.published_at = new Date();
  } else if (outcome.status === "FAILED") {
    next.listing_status = "FAILED";
    next.last_error_at = new Date();
  } else if (outcome.status === "SUBMITTED") {
    next.listing_status = "SUBMITTED";
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
      master_bundle_id: true,
    },
  });
  if (!draft) throw new Error(`BundleDraft ${input.bundle_draft_id} not found`);
  if (!draft.master_bundle_id) {
    throw new Error(
      `BundleDraft ${draft.id} has no MasterBundle yet — run validate first (which lazy-promotes).`,
    );
  }

  // Phase 5 — Walmart prohibits frozen/perishable cold-chain food, so frozen/
  // refrigerated sets are Amazon-only. Resolve the bundle's category once and
  // skip Walmart SKUs below when it's cold.
  const masterBundle = await prisma.masterBundle.findUnique({
    where: { id: draft.master_bundle_id },
    select: { category: true, brand: true, pack_count: true },
  });
  const isColdBundle = /FROZEN|REFRIGERATED/i.test(masterBundle?.category ?? "");

  // Load publishable SKUs, optionally filtered by channel set. Publishable =
  // PASSED or NEEDS_REVIEW (warnings only). Per Vladimir 2026-06-26, advisory
  // warnings (e.g. Veeqo stock unverifiable for a brand-new bundle) must NOT
  // block publishing — the operator confirms in the modal. FAILED (a hard
  // validator error) is still excluded.
  const skus = await prisma.channelSKU.findMany({
    where: {
      master_bundle_id: draft.master_bundle_id,
      validation_status: { in: ["PASSED", "NEEDS_REVIEW"] },
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

  // Draft → PUBLISHING (only when real apply; dry-run leaves state).
  if (apply && draft.status === "VALIDATED") {
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

      // Hard sanity check: never publish a FAILED SKU. We already filtered to
      // PASSED / NEEDS_REVIEW above, but a future refactor could break that
      // filter — this is the safety net. NEEDS_REVIEW (warnings only) is
      // allowed through by operator decision; FAILED (errors) is not.
      if (
        sku.validation_status !== "PASSED" &&
        sku.validation_status !== "NEEDS_REVIEW"
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
          skip_reason: `validation_status=${sku.validation_status} (must be PASSED or NEEDS_REVIEW)`,
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
      // Idempotency: already-LIVE rows aren't re-published.
      if (sku.listing_status === "LIVE") {
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
          dryRun: !apply,
          // On the very first attempt of a SKU we ALWAYS validation-preview
          // first; on retries we trust the operator already saw the
          // payload pass once.
          validatePreviewFirst:
            apply && sku.distribution_attempt_count === 0,
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
  let nextStatus = draft.status;
  if (apply) {
    const live = per_sku.filter((s) => s.status === "LIVE").length;
    const submitted = per_sku.filter((s) => s.status === "SUBMITTED").length;
    const failed = per_sku.filter((s) => s.status === "FAILED").length;
    if (live === per_sku.length && per_sku.length > 0) {
      nextStatus = "PUBLISHED";
    } else if (failed === per_sku.length && draft.status === "PUBLISHING") {
      nextStatus = "ERROR";
    } else if (
      (live > 0 || submitted > 0) &&
      draft.status === "PUBLISHING" &&
      !aborted
    ) {
      // Leave at PUBLISHING — poller will lift to PUBLISHED later.
      nextStatus = "PUBLISHING";
    }
    if (nextStatus !== draft.status) {
      await prisma.bundleDraft.update({
        where: { id: draft.id },
        data: { status: nextStatus },
      });
      await logLifecycle({
        entity_type: "BundleDraft",
        entity_id: draft.id,
        from_status: draft.status,
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
