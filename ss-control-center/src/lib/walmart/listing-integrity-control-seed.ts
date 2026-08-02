import {
  createWalmartListingIntegrityQueuedState,
  walmartListingIntegrityControlSha256,
  type WalmartListingIntegrityControlState,
} from "./listing-integrity-control-plane";
import {
  verifyWalmartListingIntegrityControlledPool,
  type WalmartListingIntegrityControlledPool,
} from "./listing-integrity-operations";

export const WALMART_LISTING_INTEGRITY_CONTROL_SEED_SCHEMA =
  "walmart-listing-integrity-control-seed-plan/v1" as const;

export interface WalmartListingIntegrityControlSeedPlan {
  schema_version: typeof WALMART_LISTING_INTEGRITY_CONTROL_SEED_SCHEMA;
  run: {
    run_id: string;
    pool_body_sha256: string;
    release_id_sha256: string;
    manifest_sha256: string;
    runtime_stage: "OFF";
    status: "ACTIVE";
    created_at: string;
  };
  items: WalmartListingIntegrityControlState[];
  fences: {
    strict_sequence: true;
    maximum_apply_in_flight: 1;
    automatic_retry_allowed: false;
    automatic_replay_allowed: false;
    database_writes_authorized: false;
    walmart_writes_authorized: false;
  };
  external_active_listing_keys: string[];
  body_sha256: string;
}

const SHA256 = /^[a-f0-9]{64}$/u;

function fail(message: string): never {
  throw new Error(`WALMART_LISTING_INTEGRITY_CONTROL_SEED_INVALID: ${message}`);
}

function exactSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(`${label} must be lowercase SHA-256`);
  }
  return value;
}

function canonicalInstant(value: unknown): string {
  if (typeof value !== "string") fail("created_at must be canonical UTC");
  const parsed = new Date(value as string);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail("created_at must be canonical UTC");
  }
  return value as string;
}

function exactListingKey(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || !value
    || value.length > 768 || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("external active listing key must be bounded exact text");
  }
  return value;
}

export function buildWalmartListingIntegrityControlSeedPlan(input: {
  pool: WalmartListingIntegrityControlledPool;
  release_id_sha256: string;
  manifest_sha256: string;
  created_at: string;
  external_active_listing_keys?: readonly string[];
}): WalmartListingIntegrityControlSeedPlan {
  verifyWalmartListingIntegrityControlledPool(input.pool);
  const selectedItems = input.pool.items.length > 0
    ? input.pool.items
    : input.pool.sourceRequiredItems;
  if (selectedItems.length < 1) fail("controlled pool has no remaining items");
  const releaseIdSha256 = exactSha(input.release_id_sha256, "release_id_sha256");
  const manifestSha256 = exactSha(input.manifest_sha256, "manifest_sha256");
  const createdAt = canonicalInstant(input.created_at);
  const externalActiveListingKeys = [...new Set(
    (input.external_active_listing_keys ?? []).map(exactListingKey),
  )].sort((left, right) => left.localeCompare(right, "en"));
  const poolListingKeys = new Set(selectedItems.map((item) => item.listingKey));
  const collisions = externalActiveListingKeys.filter((key) => poolListingKeys.has(key));
  if (collisions.length > 0) {
    fail(`pool overlaps external active predecessor: ${collisions.join(",")}`);
  }

  const runIdentitySha = walmartListingIntegrityControlSha256({
    pool_body_sha256: input.pool.bodySha256,
    release_id_sha256: releaseIdSha256,
    manifest_sha256: manifestSha256,
    created_at: createdAt,
  });
  const runId = `wlirun-${runIdentitySha.slice(0, 24)}`;
  const items = selectedItems.map((item, index) => (
    createWalmartListingIntegrityQueuedState({
      identity: {
        run_id: runId,
        pool_body_sha256: input.pool.bodySha256,
        // Controlled-pool ordinals are zero-based; durable queue ordinals are
        // deliberately one-based for strict predecessor SQL checks.
        ordinal: index + 1,
        listing_key: item.listingKey,
        sku: item.sku,
        item_id: item.itemId,
        store_index: item.storeIndex,
      },
      created_at: createdAt,
      queue_evidence_sha256: walmartListingIntegrityControlSha256({
        pool_body_sha256: input.pool.bodySha256,
        source_ordinal: item.ordinal,
        listing_key: item.listingKey,
        sku: item.sku,
        item_id: item.itemId,
        store_index: item.storeIndex,
        stage: item.stage,
        next_action: item.nextAction,
      }),
    })
  ));
  const body = {
    schema_version: WALMART_LISTING_INTEGRITY_CONTROL_SEED_SCHEMA,
    run: {
      run_id: runId,
      pool_body_sha256: input.pool.bodySha256,
      release_id_sha256: releaseIdSha256,
      manifest_sha256: manifestSha256,
      runtime_stage: "OFF" as const,
      status: "ACTIVE" as const,
      created_at: createdAt,
    },
    items,
    fences: {
      strict_sequence: true as const,
      maximum_apply_in_flight: 1 as const,
      automatic_retry_allowed: false as const,
      automatic_replay_allowed: false as const,
      database_writes_authorized: false as const,
      walmart_writes_authorized: false as const,
    },
    external_active_listing_keys: externalActiveListingKeys,
  };
  return {
    ...body,
    body_sha256: walmartListingIntegrityControlSha256(body),
  };
}

export function verifyWalmartListingIntegrityControlSeedPlan(
  plan: WalmartListingIntegrityControlSeedPlan,
): void {
  const { body_sha256: claimed, ...body } = plan;
  if (claimed !== walmartListingIntegrityControlSha256(body)
    || plan.schema_version !== WALMART_LISTING_INTEGRITY_CONTROL_SEED_SCHEMA
    || plan.run.runtime_stage !== "OFF"
    || plan.fences.database_writes_authorized !== false
    || plan.fences.walmart_writes_authorized !== false
    || plan.fences.maximum_apply_in_flight !== 1
    || plan.items.length < 1
    || plan.items.some((item, index) => (
      item.state !== "QUEUED"
      || item.identity.run_id !== plan.run.run_id
      || item.identity.pool_body_sha256 !== plan.run.pool_body_sha256
      || item.identity.ordinal !== index + 1
    ))) {
    fail("seed plan seal or default-OFF policy differs");
  }
}
