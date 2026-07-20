// EnrichmentJob queue helpers — the Reference Catalog work queue. Producers (the
// manual "vector" button, Bundle Factory on a miss, and an optional auto-seeder)
// enqueue targets here; the reference-enrichment-worker cron drains them.
// See docs/wiki/reference-catalog-engine.md.

import type { Client } from "@libsql/client";
import crypto from "crypto";

import { buildProductTruthListingScope } from "./product-truth-listing-scope";

export type EnrichTargetType = "brand" | "product" | "sku" | "query";
export type NonSkuEnrichTargetType = Exclude<EnrichTargetType, "sku">;
export type EnrichmentField = "identity" | "offers" | "content" | "cogs" | "availability" | "images" | "description" | "ingredients" | "nutrition" | "upc";

export const DEFAULT_ENRICHMENT_FIELDS: readonly EnrichmentField[] = ["identity", "offers", "content", "cogs"];

export function normalizeEnrichmentTarget(targetType: EnrichTargetType, value: string): string {
  if (targetType === "sku") {
    if (!value || value !== value.trim()) {
      throw new Error("SKU enrichment target must be an exact non-empty raw SKU without surrounding whitespace");
    }
    return value;
  }
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (!normalized) throw new Error("empty enrichment target");
  return normalized.replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function normalizeEnrichmentFields(fields: readonly EnrichmentField[] | undefined): EnrichmentField[] {
  const values = fields?.length ? fields : DEFAULT_ENRICHMENT_FIELDS;
  return [...new Set(values)].sort();
}

export function enrichmentIdempotencyKey(input: {
  targetType: EnrichTargetType;
  normalizedTarget: string;
  requestedFields: readonly EnrichmentField[];
  listingKey?: string | null;
}): string {
  if (input.targetType === "sku") {
    if (!input.listingKey) throw new Error("SKU enrichment idempotency requires listingKey");
    return crypto.createHash("sha256")
      .update(`enrichment-job/v3\n${input.targetType}\n${input.listingKey}\n${input.normalizedTarget}\n${input.requestedFields.join(",")}`)
      .digest("hex");
  }
  if (input.listingKey != null) {
    throw new Error("non-SKU enrichment idempotency must not include listingKey");
  }
  // Non-SKU work has no listing scope. Keep its v2 key stable so an active
  // pre-v3 brand/product/query job remains the same idempotency boundary.
  return crypto.createHash("sha256")
    .update(`enrichment-job/v2\n${input.targetType}\n${input.normalizedTarget}\n${input.requestedFields.join(",")}`)
    .digest("hex");
}

const QUEUE_V3_TRIGGERS = [
  "EnrichmentJob_queue_v3_quiescence_guard",
  "EnrichmentJob_listing_scope_contract_insert",
  "EnrichmentJob_listing_scope_identity_immutable",
  "EnrichmentJob_listing_scope_contract_update",
] as const;
const ENRICH_TARGET_TYPES: readonly EnrichTargetType[] = ["brand", "product", "sku", "query"];

async function hasQueueV3(db: Client): Promise<boolean> {
  try {
    const info = await db.execute(`PRAGMA table_info("EnrichmentJob")`);
    const columns = new Set(info.rows.map((row) => String(row.name)));
    if (!["idempotencyKey", "normalizedTarget", "requestedFields", "listingKey"]
      .every((column) => columns.has(column))) return false;

    const scopeInfo = await db.execute(`PRAGMA table_info("ProductTruthListingScope")`);
    const scopeColumns = new Set(scopeInfo.rows.map((row) => String(row.name)));
    if (!["listingKey", "channel", "storeIndex", "sku"]
      .every((column) => scopeColumns.has(column))) return false;

    const guards = await db.execute({
      sql: `SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (?,?,?,?)`,
      args: [...QUEUE_V3_TRIGGERS],
    });
    if (new Set(guards.rows.map((row) => String(row.name))).size !== QUEUE_V3_TRIGGERS.length) {
      return false;
    }
    const intentIndex = await db.execute(
      `SELECT 1 FROM sqlite_master
       WHERE type='index' AND name='EnrichmentJob_one_active_listing_intent' LIMIT 1`,
    );
    if (intentIndex.rows.length !== 1) return false;

    const foreignKeys = await db.execute(`PRAGMA foreign_key_list("EnrichmentJob")`);
    return foreignKeys.rows.some((row) =>
      String(row.table) === "ProductTruthListingScope"
      && String(row.from) === "listingKey"
      && String(row.to) === "listingKey");
  } catch {
    return false;
  }
}

interface CommonEnqueueEnrichmentOptions {
  target: string;
  source?: string;
  priority?: number;
  requestedBy?: string | null;
  requestedFields?: EnrichmentField[];
  runId?: string | null;
  approvalId?: string | null;
  estimatedSpendUnits?: number;
}

export type EnqueueEnrichmentOptions = CommonEnqueueEnrichmentOptions & (
  | {
      targetType: "sku";
      channel: string;
      storeIndex: number;
    }
  | {
      targetType: NonSkuEnrichTargetType;
      channel?: never;
      storeIndex?: never;
    }
);

// Enqueue one enrichment target. Dedup: if an identical target is already
// queued/running, return that job instead of piling up duplicates.
export async function enqueueEnrichment(
  db: Client,
  opts: EnqueueEnrichmentOptions,
): Promise<{
  created: boolean;
  id: string;
  contractVersion: "v3";
  idempotencyKey: string;
  listingKey: string | null;
}> {
  if (!ENRICH_TARGET_TYPES.includes(opts.targetType)) {
    throw new Error("invalid enrichment targetType");
  }
  const target = opts.targetType === "sku" ? opts.target : opts.target.trim();
  if (!target) throw new Error("empty enrichment target");

  if (!(await hasQueueV3(db))) {
    throw new Error("PRODUCT_TRUTH_QUEUE_V3_REQUIRED: apply and verify the queue listing-scope migration before enqueueing work");
  }

  let listingKey: string | null = null;
  if (opts.targetType === "sku") {
    const listingScope = buildProductTruthListingScope({
      channel: opts.channel,
      storeIndex: opts.storeIndex,
      sku: target,
    });
    if (listingScope.channel !== "amazon" && listingScope.channel !== "walmart") {
      throw new Error("SKU enrichment channel must be amazon or walmart");
    }
    const registered = await db.execute({
      sql: `SELECT listingKey FROM "ProductTruthListingScope"
            WHERE listingKey=? AND channel=? AND storeIndex=? AND sku=? LIMIT 1`,
      args: [
        listingScope.listingKey,
        listingScope.channel,
        listingScope.storeIndex,
        listingScope.sku,
      ],
    });
    if (registered.rows.length !== 1) {
      throw new Error(`PRODUCT_TRUTH_LISTING_SCOPE_NOT_REGISTERED: ${listingScope.listingKey}`);
    }
    listingKey = listingScope.listingKey;
  } else {
    const unsafe = opts as EnqueueEnrichmentOptions & {
      channel?: unknown;
      storeIndex?: unknown;
    };
    if (unsafe.channel !== undefined || unsafe.storeIndex !== undefined) {
      throw new Error("non-SKU enrichment work must not carry channel/storeIndex scope");
    }
  }

  const normalizedTarget = normalizeEnrichmentTarget(opts.targetType, target);
  const requestedFields = normalizeEnrichmentFields(opts.requestedFields);
  const idempotencyKey = enrichmentIdempotencyKey({
    targetType: opts.targetType,
    normalizedTarget,
    requestedFields,
    listingKey,
  });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const estimatedSpendUnits = opts.estimatedSpendUnits ?? 0;
  if (!Number.isFinite(estimatedSpendUnits) || estimatedSpendUnits < 0) {
    throw new Error("estimatedSpendUnits must be a non-negative finite number");
  }

  const inserted = await db.execute({
    sql: `INSERT OR IGNORE INTO "EnrichmentJob"
          (id, targetType, target, normalizedTarget, listingKey, idempotencyKey, requestedFields,
           status, source, priority, requestedBy, attempts, runId, approvalId,
           estimatedSpendUnits, actualSpendUnits, nextEligibleAt, queuedAt, createdAt, updatedAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      id, opts.targetType, target, normalizedTarget, listingKey, idempotencyKey,
      JSON.stringify(requestedFields), "queued", opts.source ?? "manual",
      opts.priority ?? 0, opts.requestedBy ?? null, 0, opts.runId ?? null,
      opts.approvalId ?? null, estimatedSpendUnits, 0, now, now, now, now,
    ],
  });
  const created = inserted.rowsAffected > 0;
  if (!created) {
    await db.execute({
      sql: `UPDATE "EnrichmentJob" SET priority=MAX(priority,?), updatedAt=?
            WHERE idempotencyKey=? AND status IN ('queued','running','retry_wait')
              AND targetType=? AND normalizedTarget=? AND listingKey IS ?`,
      args: [
        opts.priority ?? 0,
        now,
        idempotencyKey,
        opts.targetType,
        normalizedTarget,
        listingKey,
      ],
    });
  }
  const active = await db.execute({
    sql: `SELECT id,targetType,normalizedTarget,listingKey FROM "EnrichmentJob"
          WHERE idempotencyKey=? AND status IN ('queued','running','retry_wait')
          ORDER BY queuedAt ASC LIMIT 1`,
    args: [idempotencyKey],
  });
  const activeRow = active.rows[0];
  if (!activeRow?.id
      || String(activeRow.targetType) !== opts.targetType
      || String(activeRow.normalizedTarget) !== normalizedTarget
      || (activeRow.listingKey == null ? null : String(activeRow.listingKey)) !== listingKey) {
    throw new Error("queue v3 insert/dedup scope invariant failed");
  }
  return {
    created,
    id: String(activeRow.id),
    contractVersion: "v3",
    idempotencyKey,
    listingKey,
  };
}
