/**
 * Phase 2.4 Stage 6 — Validation pipeline orchestrator.
 *
 * Runs the registered validators against one ChannelSKU (or every CAN_PUBLISH
 * ChannelSKU of a BundleDraft) and persists status onto each row.
 *
 * Aggregation rule:
 *   ANY validator returns severity='error' → FAILED
 *   else ANY validator returns severity='warning' → NEEDS_REVIEW
 *   else → PASSED
 *
 * Persistence is per-SKU:
 *   ChannelSKU.validation_status         = PASSED | NEEDS_REVIEW | FAILED
 *   ChannelSKU.validation_errors         = JSON of failed/warning results
 *   ChannelSKU.validated_at              = now
 *   ChannelSKU.validation_attempt_count  += 1
 *
 * Validators run sequentially (mostly fast checks; the only slow ones —
 * image fetch, vision check, Veeqo lookup — run async with timeouts).
 * Sequential keeps test determinism and lets us short-circuit on a
 * future revision without rewriting the loop.
 *
 * Draft-level transition:
 *   IMAGE_GENERATED → VALIDATING on entry
 *   → VALIDATED only when every CAN_PUBLISH SKU is PASSED
 *   → ERROR when zero publishable after the run (all FAILED) — operator
 *      handles the manual-review queue.
 *
 * Idempotent — re-runs replace validation_errors and bump attempt_count.
 */

import { prisma } from "@/lib/prisma";
import type { ChannelSKU } from "@/generated/prisma/client";

import { logLifecycle } from "@/lib/bundle-factory/lifecycle-log";
import type {
  ValidationOutcome,
  ValidatorFn,
  ValidatorInput,
  ValidatorResult,
} from "./types";

import { validatorTitle } from "./validators/validator-title";
import { validatorBullets } from "./validators/validator-bullets";
import { validatorDescription } from "./validators/validator-description";
import { validatorBrandField } from "./validators/validator-brand-field";
import { validatorComplianceRerun } from "./validators/validator-compliance-rerun";
import { validatorImageDimensions } from "./validators/validator-image-dimensions";
import { validatorImageFormat } from "./validators/validator-image-format";
import { validatorAmazonBrowseNode } from "./validators/validator-amazon-browse-node";
import { validatorWalmartItemType } from "./validators/validator-walmart-item-type";
import { validatorUpcFormat } from "./validators/validator-upc-format";
import { validatorSkuPattern } from "./validators/validator-sku-pattern";
import { validatorInventory } from "./validators/validator-inventory";
import { validatorPackagingDims } from "./validators/validator-packaging-dims";
import { validatorWeight } from "./validators/validator-weight";
import { validatorCountryOfOrigin } from "./validators/validator-country-of-origin";
import { validatorMarginFloor } from "./validators/validator-margin-floor";
import { validatorRecipeContent } from "./validators/validator-recipe-content";
import { validatorCanonicalPrice } from "./validators/validator-canonical-price";
import { getMarginFloorPct } from "../margin-config";
import { INVENTORY_MAX_AGE_MS } from "../inventory-policy";

/**
 * Public list — exported so tests and the UI can enumerate "which
 * validators run" without importing each one. Order is the run order.
 */
export const VALIDATORS: Array<{ id: string; fn: ValidatorFn }> = [
  { id: "validator-title",                fn: validatorTitle },
  { id: "validator-bullets",              fn: validatorBullets },
  { id: "validator-description",          fn: validatorDescription },
  { id: "validator-brand-field",          fn: validatorBrandField },
  { id: "validator-recipe-content",       fn: validatorRecipeContent },
  { id: "validator-compliance-rerun",     fn: validatorComplianceRerun },
  { id: "validator-image-dimensions",     fn: validatorImageDimensions },
  { id: "validator-image-format",         fn: validatorImageFormat },
  { id: "validator-amazon-browse-node",   fn: validatorAmazonBrowseNode },
  { id: "validator-walmart-item-type",    fn: validatorWalmartItemType },
  { id: "validator-upc-format",           fn: validatorUpcFormat },
  { id: "validator-sku-pattern",          fn: validatorSkuPattern },
  { id: "validator-inventory",            fn: validatorInventory },
  { id: "validator-packaging-dims",       fn: validatorPackagingDims },
  { id: "validator-weight",               fn: validatorWeight },
  { id: "validator-country-of-origin",    fn: validatorCountryOfOrigin },
  { id: "validator-margin-floor",         fn: validatorMarginFloor },
  { id: "validator-canonical-price",      fn: validatorCanonicalPrice },
];

/**
 * Run every validator against `sku`. Does NOT persist — caller is
 * responsible for writing the outcome to ChannelSKU (the API route +
 * runForDraft do this; tests typically don't want the side effects).
 */
export async function runValidation(
  sku: ChannelSKU,
  draftBrand: string,
): Promise<ValidationOutcome> {
  const startMs = Date.now();
  const masterBundle = await prisma.masterBundle.findUnique({
    where: { id: sku.master_bundle_id },
    select: {
      id: true,
      brand: true,
      category: true,
      packaging_spec: true,
      cost_breakdown: true,
      pack_count: true,
      suggested_price_cents: true,
      total_weight_oz: true,
      main_image_url: true,
      estimated_cost_cents: true,
      components: {
        select: {
          product_name: true,
          manufacturer_brand: true,
          manufacturer_upc: true,
          flavor: true,
          qty: true,
        },
      },
    },
  });

  // Resolve the per-run margin floor once (wizard override → Setting → default).
  // Per-run override threading lands with the Studio orchestrator; until then
  // this reads the global Setting `bundle_margin_floor_pct`.
  const marginFloorPct = await getMarginFloorPct();

  const input: ValidatorInput = {
    sku,
    margin_floor_pct: marginFloorPct,
    master_bundle: masterBundle
      ? {
          id: masterBundle.id,
          brand: masterBundle.brand,
          category: masterBundle.category,
          packaging_spec: masterBundle.packaging_spec,
          cost_breakdown: masterBundle.cost_breakdown,
          pack_count: masterBundle.pack_count,
          suggested_price_cents: masterBundle.suggested_price_cents,
          total_weight_oz: masterBundle.total_weight_oz,
          main_image_url: masterBundle.main_image_url,
          estimated_cost_cents: masterBundle.estimated_cost_cents,
        }
      : null,
    bundle_components: masterBundle?.components ?? [],
    draft_brand: draftBrand,
  };

  const results: ValidatorResult[] = [];
  for (const v of VALIDATORS) {
    try {
      results.push(await v.fn(input));
    } catch (e) {
      // Fail closed. An unavailable inventory/image/semantic check means the
      // listing has not been proven correct and cannot publish.
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[validation-pipeline] ${v.id} threw: ${message}`);
      results.push({
        validator_id: v.id,
        passed: false,
        severity: "error",
        message: `Validator threw: ${message}`,
      });
    }
  }

  const failed: string[] = [];
  const warnings: string[] = [];
  let hasError = false;
  let hasWarning = false;
  for (const r of results) {
    if (r.passed) continue;
    if (r.severity === "error") {
      failed.push(r.validator_id);
      hasError = true;
    } else if (r.severity === "warning") {
      warnings.push(r.validator_id);
      hasWarning = true;
    }
  }
  const status = hasError ? "FAILED" : hasWarning ? "NEEDS_REVIEW" : "PASSED";

  return {
    status,
    can_publish: status === "PASSED",
    results,
    failed,
    warnings,
    duration_ms: Date.now() - startMs,
  };
}

/**
 * Persist the outcome onto a ChannelSKU row. Bumps attempt_count.
 * Returns the new validation_status for caller convenience.
 */
export async function persistValidation(
  sku: ChannelSKU,
  outcome: ValidationOutcome,
): Promise<string> {
  const errorPayload = outcome.results
    .filter((r) => !r.passed)
    .map((r) => ({
      validator_id: r.validator_id,
      severity: r.severity ?? "error",
      message: r.message ?? "",
      details: r.details ?? null,
    }));
  const inventoryResult = outcome.results.find(
    (result) => result.validator_id === "validator-inventory",
  );
  const inventoryQuantity = Number(
    inventoryResult?.details?.bundle_available_quantity,
  );
  const availableQuantity =
    inventoryResult?.passed === true &&
    Number.isInteger(inventoryQuantity) &&
    inventoryQuantity > 0
      ? inventoryQuantity
      : null;

  await prisma.channelSKU.update({
    where: { id: sku.id },
    data: {
      validation_status: outcome.status,
      validation_errors: errorPayload.length ? JSON.stringify(errorPayload) : null,
      validated_at: new Date(),
      validation_attempt_count: { increment: 1 },
      available_quantity: availableQuantity,
      inventory_checked_at: new Date(),
      lifecycle_status: outcome.status === "PASSED" ? "VALIDATED" : "ERROR",
    },
  });

  await logLifecycle({
    entity_type: "ChannelSKU",
    entity_id: sku.id,
    from_status: sku.lifecycle_status,
    to_status: outcome.status === "PASSED" ? "VALIDATED" : "ERROR",
    reason: outcome.status === "PASSED"
      ? "All validators passed"
      : outcome.status === "NEEDS_REVIEW"
        ? `Warnings only: ${outcome.warnings.join(", ")}`
        : `Errors: ${outcome.failed.join(", ")}`,
    actor: "validation-pipeline",
    details: {
      duration_ms: outcome.duration_ms,
      failed_count: outcome.failed.length,
      warning_count: outcome.warnings.length,
    },
  });

  return outcome.status;
}

export interface RunForDraftInput {
  bundle_draft_id: string;
  /** Optional channel subset; default = every CAN_PUBLISH SKU on the
   *  draft's MasterBundle. */
  channels?: string[];
  actor?: string;
}

export interface RunForDraftResult {
  ok: boolean;
  bundle_draft_id: string;
  master_bundle_id: string | null;
  per_sku: Array<{
    sku_id: string;
    channel: string;
    status: string;
    failed: string[];
    warnings: string[];
    duration_ms: number;
    /** Full per-validator output. Lets clients (smoke tests, the UI,
     *  Jackie) inspect what each of the 15 validators reported without
     *  re-querying the SKU and JSON-parsing validation_errors. */
    results: ValidatorResult[];
  }>;
  draft_status: string;
  duration_ms: number;
  note?: string;
}

export async function runValidationForDraft(
  input: RunForDraftInput,
): Promise<RunForDraftResult> {
  const startMs = Date.now();
  const draft = await prisma.bundleDraft.findUnique({
    where: { id: input.bundle_draft_id },
    select: {
      id: true,
      brand: true,
      status: true,
      master_bundle_id: true,
    },
  });
  if (!draft) {
    throw new Error(`BundleDraft ${input.bundle_draft_id} not found`);
  }
  if (!draft.master_bundle_id) {
    return {
      ok: false,
      bundle_draft_id: draft.id,
      master_bundle_id: null,
      per_sku: [],
      draft_status: draft.status,
      duration_ms: Date.now() - startMs,
      note:
        "Draft has no MasterBundle yet — run promote-draft first (or POST without channels[] and the API will promote lazily).",
    };
  }
  const skus = await prisma.channelSKU.findMany({
    where: {
      master_bundle_id: draft.master_bundle_id,
      ...(input.channels && input.channels.length > 0
        ? { channel: { in: input.channels } }
        : {}),
    },
  });
  if (skus.length === 0) {
    return {
      ok: false,
      bundle_draft_id: draft.id,
      master_bundle_id: draft.master_bundle_id,
      per_sku: [],
      draft_status: draft.status,
      duration_ms: Date.now() - startMs,
      note: "No ChannelSKU rows match the filter — nothing to validate.",
    };
  }

  // Flip draft → VALIDATING.
  const fromStatus = draft.status;
  if (fromStatus === "IMAGE_GENERATED") {
    await prisma.bundleDraft.update({
      where: { id: draft.id },
      data: { status: "VALIDATING" },
    });
    await logLifecycle({
      entity_type: "BundleDraft",
      entity_id: draft.id,
      from_status: fromStatus,
      to_status: "VALIDATING",
      reason: `Validation started on ${skus.length} ChannelSKU(s)`,
      actor: input.actor ?? "system",
    });
  }

  const per_sku: RunForDraftResult["per_sku"] = [];
  for (const sku of skus) {
    const outcome = await runValidation(sku, draft.brand);
    await persistValidation(sku, outcome);
    per_sku.push({
      sku_id: sku.id,
      channel: sku.channel,
      status: outcome.status,
      failed: outcome.failed,
      warnings: outcome.warnings,
      duration_ms: outcome.duration_ms,
      results: outcome.results,
    });
  }

  const publishable = per_sku.filter((s) => s.status === "PASSED").length;
  const failed = per_sku.filter((s) => s.status === "FAILED").length;
  const [allSkuCount, allReadyCount] = await Promise.all([
    prisma.channelSKU.count({
      where: { master_bundle_id: draft.master_bundle_id },
    }),
    prisma.channelSKU.count({
      where: {
        master_bundle_id: draft.master_bundle_id,
        validation_status: "PASSED",
        available_quantity: { gt: 0 },
        inventory_checked_at: {
          gte: new Date(Date.now() - INVENTORY_MAX_AGE_MS),
        },
      },
    }),
  ]);

  let next = draft.status;
  if (allSkuCount > 0 && allReadyCount === allSkuCount) {
    next = "VALIDATED";
  } else {
    next = "ERROR";
  }
  if (next !== draft.status) {
    await prisma.bundleDraft.update({
      where: { id: draft.id },
      data: { status: next },
    });
    await logLifecycle({
      entity_type: "BundleDraft",
      entity_id: draft.id,
      from_status: draft.status,
      to_status: next,
      reason:
        next === "VALIDATED"
          ? `All ${allReadyCount}/${allSkuCount} ChannelSKUs passed every validator with verified inventory`
          : `Validation incomplete: ${allReadyCount}/${allSkuCount} total ChannelSKUs are fully ready (${failed}/${per_sku.length} checked SKUs failed)`,
      actor: input.actor ?? "system",
      details: { per_sku: per_sku.map((s) => ({ channel: s.channel, status: s.status })) },
    });
  }

  return {
    ok: allSkuCount > 0 && allReadyCount === allSkuCount,
    bundle_draft_id: draft.id,
    master_bundle_id: draft.master_bundle_id,
    per_sku,
    draft_status: next,
    duration_ms: Date.now() - startMs,
  };
}
