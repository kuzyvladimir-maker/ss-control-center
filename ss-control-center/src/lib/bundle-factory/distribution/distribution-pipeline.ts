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
 *   8. Walmart POST is fenced by a durable payload-bound claim before network.
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
  acceptWalmartSubmission,
  assertWalmartPublishLifecycleSchema,
  claimWalmartSubmission,
  hashWalmartPayload,
  recordWalmartSynchronousFailure,
  type WalmartPilotSubmissionPermit,
  WALMART_PILOT_MAX_APPLY_SKUS,
} from "./walmart-publish-lifecycle";
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
import { assertValidWalmartDistributionApproval } from "../walmart-listing-contract";
import {
  assertWalmartOwnerPermitSignature,
  walmartOwnerPermitTransportEnvironment,
} from "../walmart-owner-permit";

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
  walmartPilotPermit?: WalmartPilotSubmissionPermit;
  /** Engine-only mutation-adjacent guard. It runs after the durable claim and
   * immediately before Walmart POST /feeds. */
  beforeWalmartFeedPost?: () => void | Promise<void>;
}

export interface ChannelDistributionOutcome {
  sku_id: string;
  sku: string;
  channel: string;
  marketplace_kind: string;
  status:
    | "SUBMITTED"
    | "SUBMISSION_UNKNOWN"
    | "RETRYABLE"
    | "LIVE"
    | "FAILED"
    | "SKIPPED";
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

export interface RunWalmartPilotDistributionInput {
  bundle_draft_id: string;
  /** Defaults to false and therefore performs no DB or marketplace write. */
  apply?: boolean;
  actor?: string;
  walmartPilotPermit?: WalmartPilotSubmissionPermit;
  beforeWalmartFeedPost?: () => void | Promise<void>;
}

async function assertCurrentWalmartDistributionApproval(
  channelSkuId: string,
  expectedPublishableContentSha256: string,
  expectedMarketplacePayloadSha256: string,
): Promise<void> {
  const currentSku = await prisma.channelSKU.findUniqueOrThrow({
    where: { id: channelSkuId },
  });
  const currentApproval = assertValidWalmartDistributionApproval(currentSku);
  if (
    currentApproval.publishable_content_sha256 !==
      expectedPublishableContentSha256 ||
    currentApproval.marketplace_payload_sha256 !==
      expectedMarketplacePayloadSha256
  ) {
    throw new Error(
      "Walmart distribution approval was replaced after the durable submission claim",
    );
  }
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

  // Owner-gated pilot wave: a single invocation may create at most two real
  // Walmart submissions. Dry-runs remain unrestricted because they have no DB
  // or marketplace side effects.
  const walmartApplyCandidates = skus.filter((sku) => {
    const target = channelTarget(sku.channel);
    return (
      target.kind === "walmart" &&
      !target.skipReason &&
      !isColdBundle &&
      (sku.listing_status !== "LIVE" || input.republish === true) &&
      !["SUBMITTING", "SUBMITTED", "PENDING_REVIEW", "SUBMISSION_UNKNOWN"].includes(
        sku.listing_status,
      )
    );
  });
  if (apply && walmartApplyCandidates.length > WALMART_PILOT_MAX_APPLY_SKUS) {
    throw new Error(
      `Walmart publish pilot is capped at ${WALMART_PILOT_MAX_APPLY_SKUS} SKU per apply run; requested ${walmartApplyCandidates.length}.`,
    );
  }
  if (apply && walmartApplyCandidates.length > 0) {
    if (!input.walmartPilotPermit) {
      throw new Error(
        "Real Walmart distribution requires an external owner pilot permit",
      );
    }
    if (walmartApplyCandidates.length !== 1) {
      throw new Error(
        "One signed Walmart owner permit authorizes exactly one SKU submission",
      );
    }
    assertWalmartOwnerPermitSignature(input.walmartPilotPermit.signedPermit, {
      expectedEnvironment: walmartOwnerPermitTransportEnvironment(),
    });
    await assertWalmartPublishLifecycleSchema();
  }
  // Validate every sealed approval before changing the draft to PUBLISHING.
  // The same assertion runs again after the durable claim, immediately before
  // the network-bound submit, to catch content drift during orchestration.
  if (apply) {
    for (const sku of walmartApplyCandidates) {
      assertValidWalmartDistributionApproval(sku);
    }
  }
  const preparedWalmartPayloads = new Map<string, WalmartPublishResult>();
  if (apply) {
    for (const sku of walmartApplyCandidates) {
      const target = channelTarget(sku.channel);
      const prepared = await submitToWalmart({
        sku,
        storeIndex: target.storeIndex,
        brand: masterBundle?.brand,
        packCount: masterBundle?.pack_count,
        physicalPackageSpecs: verifiedPhysicalSpecs,
        dryRun: true,
      });
      if (!prepared.ok) {
        throw new Error(
          `Walmart payload preflight failed for ${sku.sku}: ${prepared.error ?? "unknown error"}`,
        );
      }
      const approval = assertValidWalmartDistributionApproval(sku);
      if (
        hashWalmartPayload(prepared.payload) !==
        approval.marketplace_payload_sha256
      ) {
        throw new Error(
          `Walmart payload for ${sku.sku} changed after distribution approval`,
        );
      }
      preparedWalmartPayloads.set(sku.id, prepared);
    }
    if (walmartApplyCandidates.length > 0) {
      const sku = walmartApplyCandidates[0]!;
      const prepared = preparedWalmartPayloads.get(sku.id)!;
      const target = channelTarget(sku.channel);
      const permit = input.walmartPilotPermit!;
      const body = permit.signedPermit.signed_body;
      if (
        body.channel_sku_id !== sku.id ||
        body.sku !== sku.sku ||
        body.upc !== sku.upc ||
        body.store_index !== target.storeIndex ||
        body.payload_sha256 !== hashWalmartPayload(prepared.payload) ||
        body.engine_release_sha256 !== permit.engineReleaseSha256 ||
        body.approval_sha256 !== permit.approvalSha256 ||
        body.seller_account_fingerprint_sha256 !==
          permit.sellerAccountFingerprintSha256
      ) {
        throw new Error("Signed Walmart owner permit does not bind the prepared SKU");
      }
    }
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
      if (
        target.kind === "walmart" &&
        ["SUBMITTING", "SUBMITTED", "PENDING_REVIEW", "SUBMISSION_UNKNOWN"].includes(
          sku.listing_status,
        )
      ) {
        per_sku.push({
          sku_id: sku.id,
          sku: sku.sku,
          channel: sku.channel,
          marketplace_kind: "walmart",
          status: "SKIPPED",
          submission_id: sku.submission_id,
          issues: [],
          marketplace_status: sku.listing_status,
          skip_reason: `${sku.listing_status} is already protected by the durable submission lifecycle`,
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
        // Build and validate the exact payload without network first. Its hash
        // becomes the stable idempotency boundary for the durable claim.
        const prepared: WalmartPublishResult =
          preparedWalmartPayloads.get(sku.id) ??
          (await submitToWalmart({
            sku,
            storeIndex: target.storeIndex,
            brand: masterBundle?.brand,
            packCount: masterBundle?.pack_count,
            physicalPackageSpecs: verifiedPhysicalSpecs,
            dryRun: true,
          }));
        if (!apply || !prepared.ok) {
          outcome = {
            sku_id: sku.id,
            sku: sku.sku,
            channel: sku.channel,
            marketplace_kind: "walmart",
            status: prepared.ok ? "SUBMITTED" : "FAILED",
            submission_id: null,
            issues: prepared.issues,
            marketplace_status: prepared.walmart_status,
            dry_run: true,
            payload: prepared.payload,
            error: prepared.error,
          };
        } else {
          const claim = await claimWalmartSubmission({
            channelSkuId: sku.id,
            payload: prepared.payload,
            pilotPermit: input.walmartPilotPermit!,
            allowLiveRepublish: input.republish === true,
          });
          if (!claim.claimed || !claim.attempt_id || !claim.claim_token) {
            outcome = {
              sku_id: sku.id,
              sku: sku.sku,
              channel: sku.channel,
              marketplace_kind: "walmart",
              status: "SKIPPED",
              submission_id: sku.submission_id,
              issues: [],
              marketplace_status: claim.prior_state ?? null,
              skip_reason: claim.reason ?? "durable Walmart claim not acquired",
              dry_run: false,
              payload: prepared.payload,
            };
          } else {
            let r: WalmartPublishResult | null = null;
            let submitError: string | undefined;
            try {
              // Final approval/content fingerprint fence. This is intentionally
              // adjacent to the network call and runs after the atomic claim.
              // Re-read the row so a revoked/resealed approval cannot pass via
              // the ChannelSKU snapshot loaded at orchestration start.
              const claimedApproval = assertValidWalmartDistributionApproval(sku);
              await assertCurrentWalmartDistributionApproval(
                sku.id,
                claimedApproval.publishable_content_sha256,
                claimedApproval.marketplace_payload_sha256,
              );
              r = await submitToWalmart({
                sku,
                storeIndex: target.storeIndex,
                brand: masterBundle?.brand,
                packCount: masterBundle?.pack_count,
                physicalPackageSpecs: verifiedPhysicalSpecs,
                dryRun: false,
                beforeFeedPost: async () => {
                  await assertCurrentWalmartDistributionApproval(
                    sku.id,
                    claimedApproval.publishable_content_sha256,
                    claimedApproval.marketplace_payload_sha256,
                  );
                  await input.beforeWalmartFeedPost?.();
                },
                ownerPermitAuthorization: {
                  signedPermit: input.walmartPilotPermit!.signedPermit,
                  engineReleaseSha256:
                    input.walmartPilotPermit!.engineReleaseSha256,
                  approvalSha256: input.walmartPilotPermit!.approvalSha256,
                  sellerAccountFingerprintSha256:
                    input.walmartPilotPermit!.sellerAccountFingerprintSha256,
                },
                lifecyclePostClaim: {
                  attemptId: claim.attempt_id,
                  claimToken: claim.claim_token,
                },
              });
              if (hashWalmartPayload(r.payload) !== claim.payload_hash) {
                submitError =
                  "Walmart POST payload hash changed after durable claim";
              } else if (!r.ok || !r.feed_id) {
                submitError = r.error ?? "Walmart submission returned no feedId";
              }
            } catch (error) {
              submitError = error instanceof Error ? error.message : String(error);
            }

            if (r?.ok && r.feed_id && !submitError) {
              await acceptWalmartSubmission({
                channelSkuId: sku.id,
                attemptId: claim.attempt_id,
                claimToken: claim.claim_token,
                feedId: r.feed_id,
                marketplaceStatus: r.walmart_status,
              });
              outcome = {
                sku_id: sku.id,
                sku: sku.sku,
                channel: sku.channel,
                marketplace_kind: "walmart",
                status: "SUBMITTED",
                submission_id: r.feed_id,
                issues: r.issues,
                marketplace_status: r.walmart_status,
                dry_run: false,
                payload: r.payload,
              };
            } else {
              const failure = await recordWalmartSynchronousFailure({
                channelSkuId: sku.id,
                attemptId: claim.attempt_id,
                claimToken: claim.claim_token,
                feedId: r?.feed_id,
                error: submitError,
              });
              outcome = {
                sku_id: sku.id,
                sku: sku.sku,
                channel: sku.channel,
                marketplace_kind: "walmart",
                status: failure.listingStatus,
                submission_id: r?.feed_id ?? null,
                issues: r?.issues ?? [
                  {
                    code: failure.listingStatus,
                    message: submitError,
                    severity: "WARNING",
                  },
                ],
                marketplace_status: r?.walmart_status ?? null,
                dry_run: false,
                payload: r?.payload ?? prepared.payload,
                error: submitError,
              };
            }
          }
        }
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
      if (
        outcome.status === "FAILED" ||
        outcome.status === "SUBMISSION_UNKNOWN" ||
        outcome.status === "RETRYABLE"
      ) {
        batchFailed++;
      }
      else if (outcome.status === "SUBMITTED" || outcome.status === "LIVE") batchSuccess++;

      // Real Walmart outcomes are already persisted atomically with their
      // durable attempt row. Legacy persistence remains for other channels;
      // dry-run is a no-op in either path.
      if (target.kind !== "walmart" || outcome.dry_run) {
        await persistOutcome(sku, outcome);
      }

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
    const recoveryPending = per_sku.filter(
      (s) => s.status === "SUBMISSION_UNKNOWN" || s.status === "RETRYABLE",
    ).length;
    if (live === per_sku.length && per_sku.length > 0) {
      nextStatus = "PUBLISHED";
    } else if (failed === per_sku.length && workingStatus === "PUBLISHING") {
      nextStatus = "ERROR";
    } else if (
      (live > 0 || submitted > 0 || recoveryPending > 0) &&
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
        reason: `Distribution finished — ${live} LIVE, ${submitted} SUBMITTED, ${recoveryPending} RECOVERY, ${failed} FAILED${aborted ? " (aborted)" : ""}`,
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

/** Engine-facing bounded entry point for the owner-gated 1–2 SKU pilot. */
export async function runWalmartPilotDistribution(
  input: RunWalmartPilotDistributionInput,
): Promise<RunDistributionResult> {
  return runDistribution({
    bundle_draft_id: input.bundle_draft_id,
    channels: ["WALMART"],
    apply: input.apply === true,
    batchSize: WALMART_PILOT_MAX_APPLY_SKUS,
    actor: input.actor ?? "walmart-pilot-engine",
    walmartPilotPermit: input.walmartPilotPermit,
    beforeWalmartFeedPost: input.beforeWalmartFeedPost,
  });
}
