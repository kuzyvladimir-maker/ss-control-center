import assert from "node:assert/strict";
import { test } from "node:test";

import {
  POST_LIVE_RECONCILIATION_SCHEMA,
  TRUE_404_SKUS,
  assertDbSnapshotMatchesLedger,
  assertDbSnapshotMatchesPlan,
  assertFinalLedgerAfterRepair,
  assertPostLiveReconciliationOutcome,
  buildPostLiveReconciliationPlan,
  postLiveDbSnapshotDigest,
  postLiveReconciliationConfirmation,
  postLiveSha256,
  postLiveStableJson,
  sanitizePostLiveCachedAttributes,
  validateCompleteCheckpoints,
  validateFinalLiveLedger,
  validateSurgicalRepairEvidence,
  verifyPostLiveReconciliationPlan,
  type CheckpointArtifact,
  type FinalLiveLedgerLike,
  type PostLiveDbSnapshot,
  type PostLiveReconciliationPlan,
  type SurgicalRepairPlanLike,
} from "@/lib/bundle-factory/post-live-reconciliation";

const REPAIR_CREATED = "2026-07-18T00:00:00.000Z";
const LEDGER_STARTED = "2026-07-18T00:10:00.000Z";
const LEDGER_COMPLETED = "2026-07-18T00:12:00.000Z";
const NOW = new Date("2026-07-18T00:13:00.000Z");

function seal<T extends Record<string, unknown>>(body: T): T & { sha256: string } {
  return { ...body, sha256: postLiveSha256(postLiveStableJson(body)) };
}

function liveSku(index: number): string {
  if (index === 0) return "SZ-ASPI-JFAT";
  return `UC-AS${String(index).padStart(2, "0")}-${String(index).padStart(4, "0")}`;
}

function asin(index: number): string {
  if (index === 0) return "B0H776M5B5";
  return `B${String(index).padStart(9, "0")}`;
}

interface Fixture {
  ledger: FinalLiveLedgerLike;
  repair: SurgicalRepairPlanLike;
  checkpoints: CheckpointArtifact[];
  db: PostLiveDbSnapshot;
}

function fixture(): Fixture {
  const liveRows = Array.from({ length: 164 }, (_, index) => {
    const sku = liveSku(index);
    const draftId = `draft-${index}`;
    const jobId = `job-${index % 2}`;
    return {
      sku,
      asin: asin(index),
      channel: "AMAZON_SALUTEM",
      store_index: 1,
      canonical: {
        total_units: 24,
        component_qty_sum: 24,
        components: [{ product_name: `Selected product ${index}`, qty: 24 }],
        pricing: { suggested: 76.99, floor: 66.95 },
      },
      db: {
        channel_sku: {
          id: `channel-${index}`,
          sku,
          upc: String(700000000000 + index),
          asin: asin(index),
          listing_status: index % 3 === 0 ? "LIVE" : "FAILED",
          lifecycle_status: "DRAFT",
          published_at: index === 0 ? "2026-07-10T12:00:00.000Z" : null,
          live_at: index === 1 ? "2026-07-11T12:00:00.000Z" : null,
        },
        master: {
          id: `master-${index}`,
          lifecycle_status: "DRAFT",
          pack_count: 24,
        },
        draft: {
          id: draftId,
          generation_job_id: jobId,
          status: "PUBLISHING",
          pack_count: 24,
          components: [{ product_name: `Selected product ${index}`, qty: 24 }],
          selected_variant: {
            composition: [{ product_name: `Selected product ${index}`, qty: 24 }],
          },
        },
      },
      live: {
        fetched: true,
        error: null,
        asin: asin(index),
        amazon_statuses: index % 5 === 0 ? ["BUYABLE"] : ["DISCOVERABLE"],
        buyable: index % 5 === 0,
        discoverable: index % 5 !== 0,
        issues: [],
        title: `Uncrustables Selected Product ${index}, 24 Count`,
        unit_count: 24,
        number_of_items: 24,
        consumer_offer: {
          our_price: 76.99,
          discounted_price: null,
          minimum_seller_allowed_price: 66.95,
          maximum_seller_allowed_price: 76.99,
        },
        business_offers: [{ our_price: 76.99 }],
        separate_business_price: null,
        raw_attributes: {
          ...(sku === "SZ-ASPI-JFAT"
            ? {
                externally_assigned_product_identifier: [
                  { type: "upc", value: "664554043946" },
                ],
              }
            : {}),
        },
      },
      anomalies: [],
    };
  });
  const missingRows = TRUE_404_SKUS.map((sku, offset) => {
    const index = 164 + offset;
    const hasDraft = offset < 2;
    return {
      sku,
      asin: null,
      channel: "AMAZON_SALUTEM",
      store_index: 1,
      db: {
        channel_sku: {
          id: `channel-${index}`,
          sku,
          upc: String(700000000000 + index),
          asin: null,
          listing_status: offset === 0 ? "FAILED" : "PENDING",
          lifecycle_status: "DRAFT",
          published_at: null,
          live_at: null,
        },
        master: {
          id: `master-${index}`,
          lifecycle_status: "DRAFT",
          pack_count: 24,
        },
        draft: hasDraft
          ? {
              id: `draft-${index}`,
              generation_job_id: "job-0",
              status: "PUBLISHING",
              pack_count: 24,
              components: [{ product_name: `Missing product ${index}`, qty: 24 }],
              selected_variant: {
                composition: [{ product_name: `Missing product ${index}`, qty: 24 }],
              },
            }
          : null,
      },
      live: {
        fetched: false,
        error: `SP-API 404 NOT_FOUND: SKU '${sku}' not found`,
        asin: null,
        amazon_statuses: [],
        buyable: false,
        discoverable: false,
        issues: [],
      },
      anomalies: [{ code: "AMAZON_LISTING_NOT_FOUND", severity: "CRITICAL" }],
    };
  });
  const ledger: FinalLiveLedgerLike = {
    schema_version: "uncrustables-ledger/v1.1",
    audit_id: "UL-FINAL-TEST",
    mode: "live",
    started_at: LEDGER_STARTED,
    completed_at: LEDGER_COMPLETED,
    complete: true,
    immutable: true,
    external_mutations: false,
    summary: {
      rows: 167,
      live_fetch_succeeded: 164,
      live_fetch_failed: 3,
    },
    rows: [...liveRows, ...missingRows],
  };

  const actionsBySku = new Map<string, Array<Record<string, unknown>>>();
  for (const row of liveRows) {
    const actions = ["MEDIA", "OFFER", "STRUCTURED_ATTRIBUTES"].map((kind) => ({
      action_id: `${row.sku}:${kind}`,
      kind,
      reasons: ["test"],
      desired: { kind, value: {} },
    }));
    actionsBySku.set(row.sku, actions);
  }
  const repairBody = {
    schema_version: "uncrustables-surgical-repair/v2",
    immutable: true,
    plan_id: "URP-TEST",
    created_at: REPAIR_CREATED,
    source_ledger: {
      path: "/old-ledger.json",
      sha256: "1".repeat(64),
      audit_id: "UL-OLD",
      schema_version: "uncrustables-ledger/v1.1",
      completed_at: "2026-07-17T23:00:00.000Z",
    },
    media_asset_source: { rows: 164, qa_verified: true },
    structured_attribute_source: { donor_manifest: {}, ptd_proof: {} },
    policy: {
      patch_only: true,
      validation_preview_required: true,
      post_get_verification_required: true,
      shelf_life_mutation: false,
      inventory_mutation: false,
      nutrition_mutation: false,
    },
    scope: {
      requested_skus: null,
      limit: null,
      ledger_rows_considered: 167,
      entries: 164,
      actions: 164 * 3,
      blocked: 0,
    },
    semantic_audit: { blocked: 0 },
    entries: liveRows.map((row) => ({
      sku: row.sku,
      asin: row.asin,
      store_index: 1,
      audited_product_type: "GROCERY",
      actions: actionsBySku.get(row.sku),
    })),
    blockers: [],
  };
  const repair = seal(repairBody) as SurgicalRepairPlanLike;
  const checkpoints: CheckpointArtifact[] = [];
  let checkpointIndex = 0;
  for (const [sku, actions] of actionsBySku) {
    for (const action of actions) {
      const createdAt = new Date(
        Date.parse("2026-07-18T00:01:00.000Z") + checkpointIndex,
      ).toISOString();
      const event = seal({
        schema_version: "uncrustables-surgical-checkpoint/v1",
        immutable: true,
        event_id: `event-${checkpointIndex}`,
        created_at: createdAt,
        plan_sha256: repair.sha256,
        action_id: action.action_id,
        sku,
        kind: action.kind,
        status: "VERIFIED",
        detail: { checks: ["ok"] },
      });
      const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
      checkpoints.push({
        name: `${String(checkpointIndex).padStart(4, "0")}.json`,
        file_sha256: postLiveSha256(bytes),
        event,
      });
      checkpointIndex++;
    }
  }

  const channelSkus = [...liveRows, ...missingRows].map((row, index) => ({
    id: row.db.channel_sku.id,
    updated_at: "2026-07-17T23:30:00.000Z",
    master_bundle_id: row.db.master.id,
    channel: "AMAZON_SALUTEM",
    brand_account_id: "brand-account",
    sku: row.sku,
    upc: row.db.channel_sku.upc,
    upc_pool_id: row.sku === "SZ-ASPI-JFAT" ? "pool-linked-stale" : null,
    asin: row.asin,
    walmart_item_id: null,
    ebay_item_id: null,
    tiktok_product_id: null,
    lifecycle_status: row.db.channel_sku.lifecycle_status,
    listing_status: row.db.channel_sku.listing_status,
    submitted_at: "2026-07-10T10:00:00.000Z",
    processing_at: null,
    live_at: row.db.channel_sku.live_at,
    published_at: row.db.channel_sku.published_at,
    last_status_check_at: null,
    compliance_status: "PENDING",
    compliance_check_id: null,
    validation_status: "FAILED",
    validation_check_id: "validation-evidence",
    available_quantity: index === 0 ? null : 100,
    inventory_checked_at: null,
    price_cents: 12_345,
    business_price_cents: null,
    attributes: JSON.stringify({
      keep_me: [{ value: index }],
      list_price: [{ value: 123.45 }],
      purchasable_offer: [
        {
          audience: "ALL",
          discounted_price: [{ schedule: [{ value_with_tax: 99.99 }] }],
          quantity_discount_plan: [{ quantity_tier: 10 }],
        },
      ],
    }),
    approved_shadow: "must-not-change",
  }));
  const szChannel = channelSkus.find((row) => row.sku === "SZ-ASPI-JFAT")!;
  szChannel.upc = "742259000034";
  const masters = [...liveRows, ...missingRows].map((row) => ({
    id: row.db.master.id,
    updated_at: "2026-07-17T23:30:00.000Z",
    lifecycle_status: row.db.master.lifecycle_status,
    name: `Uncrustables ${row.sku}`,
    suggested_price_cents: 7699,
    pack_count: 24,
  }));
  const drafts: PostLiveDbSnapshot["bundle_drafts"] = [...liveRows, ...missingRows]
    .filter((row) => row.db.draft != null)
    .map((row) => ({
      id: row.db.draft!.id,
      updated_at: "2026-07-17T23:30:00.000Z",
      generation_job_id: row.db.draft!.generation_job_id,
      master_bundle_id: row.db.master.id,
      status: row.db.draft!.status,
      published_at: null,
      approved_at: null,
      approved_by: null,
      compliance_status: "PENDING",
      pack_count: 24,
      draft_components: JSON.stringify([
        {
          product_name:
            row.sku === "SZ-ASPI-JFAT"
              ? "Selected product 0"
              : `Selected product ${liveRows.indexOf(row as (typeof liveRows)[number])}`,
          qty: 24,
        },
      ]),
    }));
  drafts.push({
    id: "unrelated-draft-same-job",
    updated_at: "2026-07-17T23:30:00.000Z",
    generation_job_id: "job-1",
    master_bundle_id: null,
    status: "PUBLISHED",
    published_at: "2026-07-01T00:00:00.000Z",
    approved_at: "2026-06-30T00:00:00.000Z",
    approved_by: "operator",
    compliance_status: "CAN_PUBLISH",
    pack_count: 1,
    draft_components: "[]",
  });
  const db: PostLiveDbSnapshot = {
    channel_skus: channelSkus,
    master_bundles: masters,
    bundle_drafts: drafts,
    generation_jobs: [
      {
        id: "job-0",
        updated_at: "2026-07-17T23:30:00.000Z",
        bundles_published: 0,
        bundles_approved: 0,
      },
      {
        id: "job-1",
        updated_at: "2026-07-17T23:30:00.000Z",
        bundles_published: 1,
        bundles_approved: 17,
      },
    ],
    bundle_components: [
      {
        id: "component-sz",
        updated_at: "2026-07-17T23:30:00.000Z",
        master_bundle_id: szChannel.master_bundle_id,
        product_name: "Selected product 0",
        qty: 24,
        ingredients: "reviewed",
      },
    ],
    upc_pool_rows: [
      {
        id: "pool-linked-stale",
        updated_at: "2026-07-17T23:30:00.000Z",
        upc: "742259000027",
        status: "BURNED",
        assigned_to_id: null,
        reserved_for_id: null,
        reserved_at: null,
        reserved_until: null,
        notes: "prior collision",
      },
      {
        id: "pool-stale-upc",
        updated_at: "2026-07-17T23:30:00.000Z",
        upc: "742259000034",
        status: "ASSIGNED",
        assigned_to_id: szChannel.id,
        reserved_for_id: null,
        reserved_at: null,
        reserved_until: null,
        notes: null,
      },
      {
        id: "pool-live-upc",
        updated_at: "2026-07-17T23:30:00.000Z",
        upc: "664554043946",
        status: "AVAILABLE",
        assigned_to_id: null,
        reserved_for_id: null,
        reserved_at: null,
        reserved_until: null,
        notes: "verified free import",
      },
    ],
    sz_target_upc_owner: null,
  };
  return { ledger, repair, checkpoints, db };
}

function build(value = fixture()): PostLiveReconciliationPlan {
  return buildPostLiveReconciliationPlan({
    ledger: value.ledger,
    ledger_path: "/final-ledger.json",
    ledger_file_sha256: "a".repeat(64),
    repair_plan: value.repair,
    repair_plan_path: "/repair-plan.json",
    repair_plan_file_sha256: "b".repeat(64),
    checkpoint_root_dir: "/checkpoints",
    checkpoint_artifacts: value.checkpoints,
    db_snapshot: value.db,
    now: NOW,
  });
}

function expectedAfter(
  plan: PostLiveReconciliationPlan,
  before: PostLiveDbSnapshot,
): PostLiveDbSnapshot {
  const after = structuredClone(before);
  const channelById = new Map(after.channel_skus.map((row) => [row.id, row]));
  const masterById = new Map(after.master_bundles.map((row) => [row.id, row]));
  const draftById = new Map(after.bundle_drafts.map((row) => [row.id, row]));
  const jobById = new Map(after.generation_jobs.map((row) => [row.id, row]));
  for (const entry of plan.reconciliations) {
    Object.assign(channelById.get(entry.channel_sku_id)!, {
      lifecycle_status: entry.desired.channel_lifecycle_status,
      listing_status: entry.desired.channel_listing_status,
      live_at: entry.desired.channel_live_at,
      published_at: entry.desired.channel_published_at,
      price_cents: entry.desired.channel_price_cents,
      business_price_cents: entry.desired.channel_business_price_cents,
      attributes: entry.desired.channel_attributes,
      ...(entry.sku === "SZ-ASPI-JFAT"
        ? {
            upc: plan.reviewed_sz.upc_reconciliation.desired_upc,
            upc_pool_id:
              plan.reviewed_sz.upc_reconciliation.desired_upc_pool_id,
          }
        : {}),
      updated_at: "2026-07-18T00:14:00.000Z",
    });
    Object.assign(masterById.get(entry.master_bundle_id)!, {
      lifecycle_status: entry.desired.master_lifecycle_status,
      updated_at: "2026-07-18T00:14:00.000Z",
    });
    Object.assign(draftById.get(entry.bundle_draft_id)!, {
      status: entry.desired.draft_status,
      published_at: entry.desired.draft_published_at,
      updated_at: "2026-07-18T00:14:00.000Z",
    });
  }
  for (const job of plan.generation_jobs) {
    Object.assign(jobById.get(job.generation_job_id)!, {
      bundles_published: job.desired_bundles_published,
      updated_at: "2026-07-18T00:14:00.000Z",
    });
  }
  const poolById = new Map(after.upc_pool_rows.map((row) => [row.id, row]));
  for (const released of plan.reviewed_sz.upc_reconciliation.release_pool_rows) {
    Object.assign(poolById.get(released.id)!, {
      status: "BURNED",
      assigned_to_id: null,
      reserved_for_id: null,
      reserved_at: null,
      reserved_until: null,
      notes: released.desired_note,
      updated_at: "2026-07-18T00:14:00.000Z",
    });
  }
  Object.assign(
    poolById.get(plan.reviewed_sz.upc_reconciliation.target_pool_row_id)!,
    {
      status: "ASSIGNED",
      assigned_to_id:
        plan.reviewed_sz.upc_reconciliation.desired_target_assigned_to_id,
      reserved_for_id: null,
      reserved_at: null,
      reserved_until: null,
      updated_at: "2026-07-18T00:14:00.000Z",
    },
  );
  after.sz_target_upc_owner = structuredClone(
    channelById.get(plan.reviewed_sz.upc_reconciliation.channel_sku_id)!,
  );
  return after;
}

test("builds a sealed 164+3 DB-only reconciliation plan", () => {
  const value = fixture();
  const plan = build(value);
  assert.equal(plan.schema_version, POST_LIVE_RECONCILIATION_SCHEMA);
  assert.equal(plan.reconciliations.length, 164);
  assert.deepEqual(plan.scope.true_404_skus, [...TRUE_404_SKUS]);
  assert.equal(plan.true_404_preservation.length, 3);
  assert.equal(plan.sources.surgical_repair_plan.actions, 164 * 3);
  assert.equal(plan.sources.verified_checkpoints.terminal_actions, 164 * 3);
  assert.equal(plan.policy.amazon_mutation, false);
  assert.equal(plan.policy.approval_mutation, false);
  assert.equal(plan.policy.inventory_mutation, false);
  assert.equal(plan.generation_jobs.length, 2);
  assert.equal(
    plan.generation_jobs.find((job) => job.generation_job_id === "job-1")
      ?.desired_bundles_published,
    83,
    "82 reconciled live drafts plus the unrelated already-published draft",
  );
  assert.doesNotThrow(() => verifyPostLiveReconciliationPlan(plan));
  assert.match(
    postLiveReconciliationConfirmation(plan),
    /^RECONCILE-UNCRUSTABLES-[A-F0-9]{16}$/,
  );
});

test("preserves factual timestamps and fills only missing ones from live observation", () => {
  const plan = build();
  const first = plan.reconciliations.find((row) => row.sku === liveSku(0))!;
  const second = plan.reconciliations.find((row) => row.sku === liveSku(1))!;
  const third = plan.reconciliations.find((row) => row.sku === liveSku(2))!;
  assert.equal(first.desired.channel_published_at, "2026-07-10T12:00:00.000Z");
  assert.equal(first.desired.channel_live_at, "2026-07-10T12:00:00.000Z");
  assert.equal(second.desired.channel_live_at, "2026-07-11T12:00:00.000Z");
  assert.equal(second.desired.channel_published_at, "2026-07-11T12:00:00.000Z");
  assert.equal(third.desired.channel_live_at, LEDGER_COMPLETED);
  assert.equal(third.desired.channel_published_at, LEDGER_COMPLETED);
  assert.equal(third.desired.draft_published_at, LEDGER_COMPLETED);
});

test("seals canonical consumer/B2B prices, cached-attribute cleanup, and reviewed SZ UPC move", () => {
  const plan = build();
  for (const entry of plan.reconciliations) {
    assert.equal(entry.desired.channel_price_cents, 7_699);
    assert.equal(entry.desired.channel_business_price_cents, 7_699);
    assert.equal(
      postLiveSha256(entry.desired.channel_attributes),
      entry.desired.channel_attributes_sha256,
    );
    const attrs = JSON.parse(entry.desired.channel_attributes) as Record<string, unknown>;
    assert.equal("list_price" in attrs, false);
    const offer = (attrs.purchasable_offer as Array<Record<string, unknown>>)[0];
    assert.equal("discounted_price" in offer, false);
    assert.deepEqual(offer.quantity_discount_plan, [{ quantity_tier: 10 }]);
  }
  assert.equal(plan.reviewed_sz.recipe_guard.master_pack_count, 24);
  assert.equal(plan.reviewed_sz.recipe_guard.draft_pack_count, 24);
  assert.equal(plan.reviewed_sz.upc_reconciliation.current_upc, "742259000034");
  assert.equal(plan.reviewed_sz.upc_reconciliation.desired_upc, "664554043946");
  assert.equal(
    plan.reviewed_sz.upc_reconciliation.desired_upc_pool_id,
    "pool-live-upc",
  );
  assert.equal(plan.reviewed_sz.upc_reconciliation.target_change_required, true);
  assert.equal(plan.change_summary.upc_pool_rows, 2);
});

test("cached attribute sanitizer is narrow and idempotent", () => {
  const current = JSON.stringify({
    ingredients: [{ value: "keep" }],
    list_price: [{ value: 99 }],
    purchasable_offer: [
      {
        audience: "ALL",
        discounted_price: [{ value: 90 }],
        quantity_discount_plan: [{ quantity_tier: 5 }],
      },
    ],
  });
  const clean = sanitizePostLiveCachedAttributes("TEST", current);
  assert.equal(clean.changed, true);
  const parsed = JSON.parse(clean.value) as Record<string, unknown>;
  assert.deepEqual(parsed.ingredients, [{ value: "keep" }]);
  assert.deepEqual(
    (parsed.purchasable_offer as Array<Record<string, unknown>>)[0]
      .quantity_discount_plan,
    [{ quantity_tier: 5 }],
  );
  assert.deepEqual(sanitizePostLiveCachedAttributes("TEST", clean.value), {
    value: clean.value,
    changed: false,
  });
});

test("full DB digest is relation-order stable and catches any scalar drift", () => {
  const value = fixture();
  const expected = postLiveDbSnapshotDigest(value.db);
  const reordered = structuredClone(value.db);
  reordered.channel_skus.reverse();
  reordered.master_bundles.reverse();
  reordered.bundle_drafts.reverse();
  reordered.generation_jobs.reverse();
  assert.equal(postLiveDbSnapshotDigest(reordered), expected);
  reordered.channel_skus[0].validation_status = "PASSED";
  assert.notEqual(postLiveDbSnapshotDigest(reordered), expected);
});

test("final ledger fails closed when stale, non-live, incomplete, or still has Amazon ERROR", () => {
  const base = fixture();
  const cases: Array<[string, (ledger: FinalLiveLedgerLike) => void, RegExp]> = [
    ["offline", (ledger) => void (ledger.mode = "offline-resummarize"), /complete immutable/],
    ["mutable", (ledger) => void (ledger.immutable = false), /complete immutable/],
    ["mutating", (ledger) => void (ledger.external_mutations = true), /complete immutable/],
    [
      "error",
      (ledger) =>
        void (((ledger.rows as Array<Record<string, unknown>>)[0].live as {
          issues: unknown[];
        }).issues = [{ severity: "ERROR", code: "90220" }]),
      /Amazon ERROR/,
    ],
    [
      "neither live status",
      (ledger) => {
        const live = (ledger.rows as Array<Record<string, unknown>>)[0].live as Record<
          string,
          unknown
        >;
        live.amazon_statuses = [];
        live.buyable = false;
        live.discoverable = false;
      },
      /no authoritative live status/,
    ],
  ];
  for (const [label, mutate, expected] of cases) {
    const ledger = structuredClone(base.ledger);
    mutate(ledger);
    assert.throws(
      () => validateFinalLiveLedger(ledger, { now: NOW }),
      expected,
      label,
    );
  }
  assert.throws(
    () =>
      validateFinalLiveLedger(base.ledger, {
        now: new Date("2026-07-19T00:12:01.000Z"),
        max_age_ms: 60_000,
      }),
    /not fresh/,
  );
});

test("final ledger accepts only the exact three ASIN-less 404 rows", () => {
  const value = fixture();
  const ledger = structuredClone(value.ledger);
  const missing = (ledger.rows as Array<Record<string, unknown>>).find(
    (row) => row.sku === TRUE_404_SKUS[0],
  )!;
  (missing.live as Record<string, unknown>).error = "timeout";
  assert.throws(
    () => validateFinalLiveLedger(ledger, { now: NOW }),
    /not the exact ASIN-less NOT_FOUND\/404 state/,
  );

  const unexpected = structuredClone(value.ledger);
  const live = (unexpected.rows as Array<Record<string, unknown>>)[0];
  (live.live as Record<string, unknown>).fetched = false;
  (live.live as Record<string, unknown>).error = `404 NOT_FOUND ${live.sku}`;
  assert.throws(
    () => validateFinalLiveLedger(unexpected, { now: NOW }),
    /unexpected failed live fetch/,
  );
});

test("final ledger rejects stale price/B2B/discount and non-24 SZ evidence", () => {
  const value = fixture();
  const cases: Array<[string, (ledger: FinalLiveLedgerLike) => void, RegExp]> = [
    [
      "consumer",
      (ledger) => {
        const live = ((ledger.rows as Array<Record<string, unknown>>)[1].live as Record<
          string,
          unknown
        >).consumer_offer as Record<string, unknown>;
        live.our_price = 77;
      },
      /consumer offer/,
    ],
    [
      "discount",
      (ledger) => {
        const live = ((ledger.rows as Array<Record<string, unknown>>)[1].live as Record<
          string,
          unknown
        >).consumer_offer as Record<string, unknown>;
        live.discounted_price = 60;
      },
      /consumer offer/,
    ],
    [
      "b2b",
      (ledger) => {
        const live = (ledger.rows as Array<Record<string, unknown>>)[1].live as Record<
          string,
          unknown
        >;
        live.business_offers = [{ our_price: 70 }];
      },
      /B2B base price/,
    ],
    [
      "sz pack",
      (ledger) => {
        const row = (ledger.rows as Array<Record<string, unknown>>)[0];
        ((row.db as Record<string, unknown>).master as Record<string, unknown>).pack_count = 6;
      },
      /24-count draft/,
    ],
    [
      "sz upc",
      (ledger) => {
        const row = (ledger.rows as Array<Record<string, unknown>>)[0];
        const live = row.live as Record<string, unknown>;
        const raw = live.raw_attributes as Record<string, unknown>;
        raw.externally_assigned_product_identifier = [
          { type: "upc", value: "000000000000" },
        ];
      },
      /live UPC evidence/,
    ],
  ];
  for (const [label, mutate, expected] of cases) {
    const ledger = structuredClone(value.ledger);
    mutate(ledger);
    assert.throws(
      () => validateFinalLiveLedger(ledger, { now: NOW }),
      expected,
      label,
    );
  }
});

test("repair evidence requires full media, structured sources, required actions, and zero blockers", () => {
  const value = fixture();
  const ledger = validateFinalLiveLedger(value.ledger, { now: NOW });
  const valid = validateSurgicalRepairEvidence(value.repair, ledger);
  assert.equal(valid.action_count, 164 * 3);

  const missingAction = structuredClone(value.repair) as Record<string, unknown>;
  const entries = missingAction.entries as Array<{ actions: unknown[] }>;
  entries[0].actions.pop();
  const scope = missingAction.scope as Record<string, unknown>;
  scope.actions = Number(scope.actions) - 1;
  delete missingAction.sha256;
  const resealed = seal(missingAction);
  assert.throws(
    () => validateSurgicalRepairEvidence(resealed, ledger),
    /missing STRUCTURED_ATTRIBUTES/,
  );

  const blocked = structuredClone(value.repair) as Record<string, unknown>;
  blocked.blockers = [{ sku: liveSku(0) }];
  delete blocked.sha256;
  assert.throws(
    () => validateSurgicalRepairEvidence(seal(blocked), ledger),
    /still has blockers/,
  );
});

test("checkpoint validation rejects missing, unexpected, tampered, and later failed actions", () => {
  const value = fixture();
  const ledger = validateFinalLiveLedger(value.ledger, { now: NOW });
  const repair = validateSurgicalRepairEvidence(value.repair, ledger);
  const complete = validateCompleteCheckpoints(value.checkpoints, repair);
  assert.equal(complete.terminal_action_count, 164 * 3);

  assert.throws(
    () => validateCompleteCheckpoints(value.checkpoints.slice(1), repair),
    /Missing checkpoints/,
  );
  const tampered = structuredClone(value.checkpoints);
  tampered[0].event.status = "FAILED";
  assert.throws(
    () => validateCompleteCheckpoints(tampered, repair),
    /event SHA-256 mismatch/,
  );
  const laterFailed = structuredClone(value.checkpoints);
  const original = laterFailed[0].event;
  const failure = seal({
    schema_version: original.schema_version,
    immutable: true,
    event_id: "later-failure",
    created_at: "2026-07-18T00:09:00.000Z",
    plan_sha256: original.plan_sha256,
    action_id: original.action_id,
    sku: original.sku,
    kind: original.kind,
    status: "FAILED",
    detail: { error: "late" },
  });
  laterFailed.push({
    name: "later-failure.json",
    file_sha256: postLiveSha256(JSON.stringify(failure)),
    event: failure,
  });
  assert.throws(
    () => validateCompleteCheckpoints(laterFailed, repair),
    /latest checkpoint is FAILED/,
  );
});

test("final audit must start after the latest verified repair checkpoint", () => {
  const value = fixture();
  const ledgerValue = structuredClone(value.ledger);
  ledgerValue.started_at = "2026-07-18T00:01:00.100Z";
  const ledger = validateFinalLiveLedger(ledgerValue, { now: NOW });
  const repair = validateSurgicalRepairEvidence(value.repair, ledger);
  const checkpoints = validateCompleteCheckpoints(value.checkpoints, repair);
  assert.throws(
    () => assertFinalLedgerAfterRepair(ledger, repair, checkpoints),
    /did not start after every repair action/,
  );
});

test("DB scope guard rejects SKU, ASIN, lineage, missing, or unexpected row drift", () => {
  const value = fixture();
  const ledger = validateFinalLiveLedger(value.ledger, { now: NOW });
  assert.doesNotThrow(() => assertDbSnapshotMatchesLedger(value.db, ledger));
  const mutations: Array<(db: PostLiveDbSnapshot) => void> = [
    (db) => void (db.channel_skus[0].asin = "B999999999"),
    (db) => void (db.channel_skus[0].sku = "WRONG-SKU"),
    (db) => void (db.channel_skus[0].master_bundle_id = "master-wrong"),
    (db) => void db.channel_skus.pop(),
    (db) =>
      void db.bundle_drafts.push({
        ...db.bundle_drafts[0],
        id: "unexpected-cohort-draft",
      }),
  ];
  for (const mutate of mutations) {
    const db = structuredClone(value.db);
    mutate(db);
    assert.throws(() => assertDbSnapshotMatchesLedger(db, ledger));
  }
});

test("DB guard requires SZ recipe backfill and an unclaimed exact target UPC", () => {
  const value = fixture();
  const ledger = validateFinalLiveLedger(value.ledger, { now: NOW });
  const mutations: Array<[string, (db: PostLiveDbSnapshot) => void, RegExp]> = [
    [
      "master pack",
      (db) => {
        const sz = db.channel_skus.find((row) => row.sku === "SZ-ASPI-JFAT")!;
        db.master_bundles.find((row) => row.id === sz.master_bundle_id)!.pack_count = 6;
      },
      /recipe backfill to 24/,
    ],
    [
      "draft recipe",
      (db) => {
        const sz = db.channel_skus.find((row) => row.sku === "SZ-ASPI-JFAT")!;
        const draft = db.bundle_drafts.find(
          (row) => row.master_bundle_id === sz.master_bundle_id,
        )!;
        draft.draft_components = JSON.stringify([
          { product_name: "Selected product 0", qty: 6 },
        ]);
      },
      /canonical recipe/,
    ],
    [
      "master component",
      (db) => void (db.bundle_components[0].qty = 6),
      /canonical recipe/,
    ],
    [
      "claimed live UPC",
      (db) => {
        db.sz_target_upc_owner = { ...db.channel_skus[1], upc: "664554043946" };
      },
      /already owned by another/,
    ],
    [
      "reserved target",
      (db) => {
        const target = db.upc_pool_rows.find((row) => row.upc === "664554043946")!;
        target.status = "RESERVED";
        target.reserved_for_id = "someone";
      },
      /reassignment preconditions/,
    ],
  ];
  for (const [label, mutate, expected] of mutations) {
    const db = structuredClone(value.db);
    mutate(db);
    assert.throws(
      () => assertDbSnapshotMatchesLedger(db, ledger),
      expected,
      label,
    );
  }
});

test("sealed plan and full snapshot guard fail on tampering or concurrent DB changes", () => {
  const value = fixture();
  const plan = build(value);
  const tampered = structuredClone(plan);
  tampered.reconciliations[0].desired.channel_listing_status = "FAILED" as "LIVE";
  assert.throws(() => verifyPostLiveReconciliationPlan(tampered), /SHA-256 mismatch/);
  const drifted = structuredClone(value.db);
  drifted.channel_skus[0].updated_at = "2026-07-18T00:00:00.000Z";
  assert.throws(
    () => assertDbSnapshotMatchesPlan(plan, drifted),
    /Database snapshot drifted after planning/,
  );
});

test("post-apply verifier accepts only sealed lifecycle/timestamp/counter changes", () => {
  const value = fixture();
  const plan = build(value);
  const after = expectedAfter(plan, value.db);
  assert.doesNotThrow(() =>
    assertPostLiveReconciliationOutcome(plan, value.db, after),
  );

  const forbiddenMutations: Array<[string, (db: PostLiveDbSnapshot) => void]> = [
    ["ASIN", (db) => void (db.channel_skus[0].asin = "B999999999")],
    ["compliance", (db) => void (db.channel_skus[0].compliance_status = "CAN_PUBLISH")],
    ["validation", (db) => void (db.channel_skus[0].validation_status = "PASSED")],
    ["inventory", (db) => void (db.channel_skus[0].available_quantity = 777)],
    ["price", (db) => void (db.channel_skus[1].price_cents = 1)],
    ["business price", (db) => void (db.channel_skus[1].business_price_cents = 1)],
    ["cached attrs", (db) => void (db.channel_skus[1].attributes = "{}")],
    ["approval", (db) => void (db.bundle_drafts[0].approved_by = "invented")],
    [
      "existing timestamp",
      (db) => void (db.channel_skus[0].published_at = "2026-07-18T00:12:00.000Z"),
    ],
    [
      "true404",
      (db) => {
        const row = db.channel_skus.find((candidate) => candidate.sku === TRUE_404_SKUS[0])!;
        row.listing_status = "LIVE";
      },
    ],
    [
      "UPCPool",
      (db) => {
        const target = db.upc_pool_rows.find((row) => row.upc === "664554043946")!;
        target.status = "AVAILABLE";
      },
    ],
  ];
  for (const [label, mutate] of forbiddenMutations) {
    const invalid = structuredClone(after);
    mutate(invalid);
    assert.throws(
      () => assertPostLiveReconciliationOutcome(plan, value.db, invalid),
      label,
    );
  }
});

test("re-running against an already reconciled snapshot produces an idempotent no-op plan", () => {
  const firstFixture = fixture();
  const firstPlan = build(firstFixture);
  const reconciledDb = expectedAfter(firstPlan, firstFixture.db);
  const secondFixture = { ...firstFixture, db: reconciledDb };
  const secondPlan = buildPostLiveReconciliationPlan({
    ledger: secondFixture.ledger,
    ledger_path: "/final-ledger.json",
    ledger_file_sha256: "a".repeat(64),
    repair_plan: secondFixture.repair,
    repair_plan_path: "/repair-plan.json",
    repair_plan_file_sha256: "b".repeat(64),
    checkpoint_root_dir: "/checkpoints",
    checkpoint_artifacts: secondFixture.checkpoints,
    db_snapshot: secondFixture.db,
    now: new Date("2026-07-18T00:15:00.000Z"),
  });
  assert.equal(secondPlan.change_summary.total_rows, 0);
  assert.ok(secondPlan.generation_jobs.every((job) => !job.change_required));
});
