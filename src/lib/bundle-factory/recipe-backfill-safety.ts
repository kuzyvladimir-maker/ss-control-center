import { createHash } from "node:crypto";

type TemporalValue = Date | string | null;

type IdentifiedRow = Record<string, unknown> & { id: string };

export interface RecipeBackfillOptimisticSnapshot {
  draft: Record<string, unknown> & {
    id: string;
    generated_content?: IdentifiedRow[];
  };
  master:
    | (Record<string, unknown> & {
        id: string;
        components?: IdentifiedRow[];
        channel_skus?: IdentifiedRow[];
      })
    | null;
}

export interface RecipeBackfillPublicationSnapshot {
  draft: {
    id: string;
    master_bundle_id: string | null;
    status: string;
    published_at: TemporalValue;
  };
  master: {
    id: string;
    lifecycle_status: string;
    channel_skus: Array<{
      id: string;
      channel: string;
      sku: string;
      upc: string;
      asin: string | null;
      walmart_item_id: string | null;
      ebay_item_id: string | null;
      tiktok_product_id: string | null;
      lifecycle_status: string;
      listing_status: string;
      submission_id: string | null;
      submitted_at: TemporalValue;
      processing_at: TemporalValue;
      live_at: TemporalValue;
      live_url: string | null;
      published_at: TemporalValue;
      last_status_check_at: TemporalValue;
      distribution_attempt_count: number;
      distribution_errors: string | null;
      last_error_at: TemporalValue;
      errors: string | null;
    }>;
  } | null;
}

function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .filter((key) => row[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function sortRows<T extends { id: string }>(rows: T[] | undefined): T[] {
  return [...(rows ?? [])].sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Seal every row used to calculate a recipe repair. Relation arrays are sorted
 * because Prisma does not promise an implicit relation order.
 */
export function recipeBackfillOptimisticDigest(
  snapshot: RecipeBackfillOptimisticSnapshot,
): string {
  const draft = {
    ...snapshot.draft,
    generated_content: sortRows(snapshot.draft.generated_content),
  };
  const master = snapshot.master
    ? {
        ...snapshot.master,
        components: sortRows(snapshot.master.components),
        channel_skus: sortRows(snapshot.master.channel_skus),
      }
    : null;
  return digest({ draft, master });
}

/** Marketplace-observed identity and publication facts protected by backfill. */
export function recipeBackfillPublicationDigest(
  snapshot: RecipeBackfillPublicationSnapshot,
): string {
  const draft = snapshot.draft;
  return digest({
    draft: {
      id: draft.id,
      master_bundle_id: draft.master_bundle_id,
      status: draft.status,
      published_at: draft.published_at,
    },
    master: snapshot.master
      ? {
          id: snapshot.master.id,
          lifecycle_status: snapshot.master.lifecycle_status,
          channel_skus: sortRows(snapshot.master.channel_skus).map((sku) => ({
            id: sku.id,
            channel: sku.channel,
            sku: sku.sku,
            upc: sku.upc,
            asin: sku.asin,
            walmart_item_id: sku.walmart_item_id,
            ebay_item_id: sku.ebay_item_id,
            tiktok_product_id: sku.tiktok_product_id,
            lifecycle_status: sku.lifecycle_status,
            listing_status: sku.listing_status,
            submission_id: sku.submission_id,
            submitted_at: sku.submitted_at,
            processing_at: sku.processing_at,
            live_at: sku.live_at,
            live_url: sku.live_url,
            published_at: sku.published_at,
            last_status_check_at: sku.last_status_check_at,
            distribution_attempt_count: sku.distribution_attempt_count,
            distribution_errors: sku.distribution_errors,
            last_error_at: sku.last_error_at,
            errors: sku.errors,
          })),
        }
      : null,
  });
}

export function assertRecipeBackfillDigest(
  label: string,
  expected: string,
  actual: string,
): void {
  if (actual !== expected) {
    throw new Error(
      `${label} changed after the read-only plan; transaction rolled back ` +
        `(expected ${expected}, got ${actual})`,
    );
  }
}

/** A changed canonical recipe invalidates approval and draft-level compliance. */
export function recipeBackfillDraftInvalidation() {
  return {
    approved_at: null,
    approved_by: null,
    approval_notes: null,
    compliance_status: "PENDING",
    compliance_check_id: null,
    compliance_blocked_at: null,
    compliance_blocked_reasons: null,
  } as const;
}

/** A changed canonical recipe invalidates every downstream per-SKU gate. */
export function recipeBackfillChannelSkuInvalidation() {
  return {
    compliance_status: "PENDING",
    compliance_check_id: null,
    compliance_blocked_at: null,
    compliance_blocked_reasons: null,
    validation_status: "PENDING",
    validation_errors: null,
    validated_at: null,
    validation_check_id: null,
    available_quantity: null,
    inventory_checked_at: null,
  } as const;
}

/** Generated copy stays available, but its old compliance verdict is not reusable. */
export function recipeBackfillGeneratedContentInvalidation() {
  return {
    compliance_status: "PENDING",
    compliance_check_id: null,
    manual_review_required: false,
    failed_rule_ids: null,
  } as const;
}

export function recipeBackfillAuditEvent(input: {
  currentStatus: string;
  oldDraftSignature: string | null;
  oldMasterSignature: string | null;
  canonicalSignature: string;
  componentCount: number;
  packCount: number;
}) {
  return {
    from_status: input.currentStatus,
    to_status: input.currentStatus,
    trigger: "RECIPE_BACKFILLED",
    details: {
      event: "RECIPE_BACKFILLED",
      publication_state_preserved: true,
      approval_invalidated: true,
      compliance_invalidated: true,
      validation_invalidated: true,
      inventory_invalidated: true,
      old_draft_signature: input.oldDraftSignature,
      old_master_signature: input.oldMasterSignature,
      canonical_signature: input.canonicalSignature,
      component_count: input.componentCount,
      pack_count: input.packCount,
    },
  } as const;
}
