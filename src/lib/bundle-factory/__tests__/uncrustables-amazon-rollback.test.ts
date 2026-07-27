// npx tsx --test src/lib/bundle-factory/__tests__/uncrustables-amazon-rollback.test.ts

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import type {
  ListingItem,
  ListingPatch,
} from "@/lib/amazon-sp-api/listings";
import { priceSchedule } from "@/lib/amazon-sp-api/pricing";
import {
  assertForwardApplyRollbackCoverage,
  assertForwardPatchRollbackCovered,
  buildLedgerBootstrapSnapshot,
  buildRollbackPlan,
  captureLivePreChangeSnapshot,
  executeRollbackPlan,
  ImmutableRollbackCheckpointStore,
  rollbackConfirmationToken,
  UNCRUSTABLES_AMAZON_SCOPE,
  type RollbackGateway,
  type SnapshotImageLoader,
  type UncrustablesPreChangeSnapshot,
} from "../repair/uncrustables-amazon-rollback";
import {
  applyPurchasableOfferMerge,
  buildActionPatches,
  buildRepairPlan,
  buildValidationPreviewPatchSet,
  CONTENT_STRUCTURED_MEDIA_ONLY_PROFILE,
  EXACT_PATH_SETTLEMENT_GUARD,
  ImmutableCheckpointStore,
  MEDIA_PATCH_PATHS,
  repairExecutionSelection,
  SELECTOR_REPLACE_SURROGATE_FOR_MERGE,
  sha256,
  stableJson,
  TEXT_STRUCTURED_ONLY_PROFILE,
  type RepairExecutionSelection,
  type UncrustablesRepairPlan,
} from "../repair/uncrustables-surgical";

function testCheckpointStore(
  root: string,
  planSha256: string,
): ImmutableCheckpointStore {
  return new ImmutableCheckpointStore(
    root,
    planSha256,
    path.join(root, "test-mutation-coordination"),
  );
}

function sku(index: number): string {
  return `UT-AS${String(index).padStart(3, "0")}-SAFE`;
}

function asin(index: number): string {
  return `B0${String(index).padStart(8, "0")}`;
}

function beforeListing(index: number): ListingItem {
  return {
    sku: sku(index),
    summaries: [
      {
        marketplaceId: MARKETPLACE_ID,
        asin: asin(index),
        productType: "GROCERY",
        status: ["BUYABLE", "DISCOVERABLE"],
        itemName: "Uncrustables Peanut Butter & Grape Jelly Sandwiches, Frozen, 24 Count",
      },
    ],
    attributes: {
      item_name: [
        {
          value:
            "Uncrustables Peanut Butter & Grape Jelly Sandwiches, Frozen, 24 Count",
          marketplace_id: MARKETPLACE_ID,
        },
      ],
      bullet_point: [
        "Includes 24 peanut butter and grape jelly sandwiches.",
        "Each sandwich is individually wrapped.",
        "Keep frozen until ready to use.",
        "Review each wrapper before use.",
        "Follow the handling directions on the wrapper.",
      ].map((value) => ({ value, marketplace_id: MARKETPLACE_ID })),
      product_description: [
        {
          value: "This listing contains 24 peanut butter and grape jelly sandwiches.",
          marketplace_id: MARKETPLACE_ID,
        },
      ],
      brand: [{ value: "Uncrustables", marketplace_id: MARKETPLACE_ID }],
      main_product_image_locator: [
        {
          media_location: "https://m.media-amazon.com/images/I/before-main.jpg",
          marketplace_id: MARKETPLACE_ID,
        },
      ],
      other_product_image_locator_1: [
        {
          media_location: "https://m.media-amazon.com/images/I/before-card.jpg",
          marketplace_id: MARKETPLACE_ID,
        },
      ],
      purchasable_offer: [
        {
          audience: "ALL",
          currency: "USD",
          our_price: priceSchedule(70),
          discounted_price: priceSchedule(65),
          minimum_seller_allowed_price: priceSchedule(60),
          maximum_seller_allowed_price: priceSchedule(80),
          marketplace_id: MARKETPLACE_ID,
        },
      ],
      list_price: [
        { marketplace_id: MARKETPLACE_ID, currency: "USD", value: 71.35 },
      ],
      unit_count: [
        {
          value: 24,
          type: { value: "Count", language_tag: "en_US" },
          marketplace_id: MARKETPLACE_ID,
        },
      ],
      number_of_items: [{ value: 24, marketplace_id: MARKETPLACE_ID }],
    },
    issues: [],
    offers: [
      {
        offerType: "B2B",
        audience: { value: "B2B" },
        price: { amount: "69.00", currency: "USD" },
      },
    ],
    fulfillmentAvailability: [
      { fulfillmentChannelCode: "DEFAULT", quantity: 12 },
    ],
    procurement: { cost: "sealed" },
  };
}

function fixtureBytes(count: number = UNCRUSTABLES_AMAZON_SCOPE): {
  ledgerBytes: Buffer;
  overridesBytes: Buffer;
} {
  const rows = Array.from({ length: count }, (_, offset) => {
    const index = offset + 1;
    const listing = beforeListing(index);
    return {
      sku: sku(index),
      asin: asin(index),
      store_index: 1,
      canonical: {
        total_units: 24,
        components: [
          {
            product_id: `grape-${index}`,
            product_name:
              "Smucker's Uncrustables Peanut Butter & Grape Jelly Sandwich",
            brand: "Uncrustables",
            flavor: "Peanut Butter & Grape Jelly",
            qty: 24,
            unit_price_cents: 100,
          },
        ],
        pricing: { suggested: 76.99, floor: 66.95 },
      },
      db: {
        draft: {
          brand: "Uncrustables",
          pack_count: 24,
          selected_variant: {
            name: "Grape 24",
            composition: [
              {
                product_id: `grape-${index}`,
                product_name:
                  "Smucker's Uncrustables Peanut Butter & Grape Jelly Sandwich",
                brand: "Uncrustables",
                flavor: "Peanut Butter & Grape Jelly",
                qty: 24,
                unit_price_cents: 100,
              },
            ],
          },
        },
      },
      live: {
        fetched: true,
        error: null,
        asin: asin(index),
        product_type: "GROCERY",
        amazon_statuses: ["BUYABLE", "DISCOVERABLE"],
        title:
          "Uncrustables Peanut Butter & Grape Jelly Sandwiches, Frozen, 24 Count",
        bullets: [
          "Includes 24 peanut butter and grape jelly sandwiches.",
          "Each sandwich is individually wrapped.",
          "Keep frozen until ready to use.",
          "Review each wrapper before use.",
          "Follow the handling directions on the wrapper.",
        ],
        description:
          "This listing contains 24 peanut butter and grape jelly sandwiches.",
        brand: "Uncrustables",
        gallery_image_urls: [
          "https://m.media-amazon.com/images/I/before-card.jpg",
        ],
        consumer_offer: {
          our_price: 70,
          discounted_price: 65,
          minimum_seller_allowed_price: 60,
          maximum_seller_allowed_price: 80,
        },
        business_offers: [{ audience: "B2B", our_price: 69 }],
        raw_attributes: listing.attributes,
        raw_offers: listing.offers,
        fulfillment_availability: listing.fulfillmentAvailability,
        procurement: listing.procurement,
        issues: [],
      },
      anomalies: [],
    };
  });
  const ledgerBytes = Buffer.from(
    JSON.stringify({
      schema_version: "uncrustables-ledger/v1.2",
      audit_id: "UL-ROLLBACK-TEST",
      complete: true,
      immutable: true,
      mode: "live",
      external_mutations: false,
      completed_at: "2026-07-18T00:00:00.000Z",
      marketplace_observed_at: "2026-07-18T00:00:00.000Z",
      rows,
    }),
  );
  const overridesBytes = Buffer.from(
    JSON.stringify({
      schema_version: "uncrustables-surgical-desired/v1",
      immutable: true,
      source_ledger_sha256: sha256(ledgerBytes),
      reviewed_at: "2026-07-18T00:01:00.000Z",
      repairs: [],
    }),
  );
  return { ledgerBytes, overridesBytes };
}

function bootstrap(): UncrustablesPreChangeSnapshot {
  const bytes = fixtureBytes();
  return buildLedgerBootstrapSnapshot({
    ledgerPath: "/tmp/ledger.json",
    ledgerBytes: bytes.ledgerBytes,
    overridesPath: "/tmp/overrides.json",
    overridesBytes: bytes.overridesBytes,
    createdAt: new Date("2026-07-18T00:02:00.000Z"),
  });
}

function repairPlan(): UncrustablesRepairPlan {
  const bytes = fixtureBytes();
  const manifest = JSON.parse(bytes.overridesBytes.toString("utf8"));
  return buildRepairPlan({
    ledgerPath: "/tmp/ledger.json",
    ledgerBytes: bytes.ledgerBytes,
    manifest,
    manifestSource: {
      path: "/tmp/overrides.json",
      bytes: bytes.overridesBytes,
    },
    createdAt: new Date("2026-07-18T00:03:00.000Z"),
  });
}

async function contentSelectionFixture(): Promise<{
  repair: UncrustablesRepairPlan;
  snapshot: UncrustablesPreChangeSnapshot;
  selection: RepairExecutionSelection;
  repairPlanPath: string;
  selectionPath: string;
}> {
  const bytes = fixtureBytes();
  const manifest = {
    schema_version: "uncrustables-surgical-desired/v1" as const,
    immutable: true as const,
    reviewed_at: "2026-07-18T00:01:00.000Z",
    source_ledger_sha256: sha256(bytes.ledgerBytes),
    repairs: [
      {
        sku: sku(1),
        review: {
          confidence: "HIGH" as const,
          rationale: "Test-only exact count repair.",
          evidence: ["Captured GROCERY before state."],
        },
        text_count: {
          unit_count: 24,
          unit_count_type: "Count" as const,
          number_of_items: 24,
          request_product_type: "GROCERY",
          expected_product_type: "GROCERY",
        },
      },
    ],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const manifestPath = "/tmp/content-selection-overrides.json";
  const repairPlanPath = "/tmp/content-selection-repair.json";
  const selectionPath = "/tmp/content-selection.json";
  const repair = buildRepairPlan({
    ledgerPath: "/tmp/ledger.json",
    ledgerBytes: bytes.ledgerBytes,
    manifest,
    manifestSource: { path: manifestPath, bytes: manifestBytes },
    createdAt: new Date("2026-07-18T00:03:00.000Z"),
  });
  const snapshot = await liveSnapshot({
    overridesBytes: manifestBytes,
    overridesPath: manifestPath,
  });
  const selection = repairExecutionSelection(repair, {
    sourcePlanPath: repairPlanPath,
    createdAt: new Date("2026-07-18T00:06:00.000Z"),
    actionKinds: ["TEXT_COUNT", "STRUCTURED_ATTRIBUTES", "MEDIA"],
  });
  return { repair, snapshot, selection, repairPlanPath, selectionPath };
}

async function liveSnapshot(options?: {
  overridesBytes?: Buffer;
  overridesPath?: string;
  listingFactory?: (index: number) => ListingItem;
}): Promise<UncrustablesPreChangeSnapshot> {
  const bytes = fixtureBytes();
  const imageLoader: SnapshotImageLoader = {
    load: async (url) => ({
      url,
      sha256: sha256(url),
      bytes: 123,
      content_type: "image/jpeg",
      local_path: `/tmp/${sha256(url)}.jpg`,
      error: null,
    }),
  };
  return captureLivePreChangeSnapshot({
    ledgerPath: "/tmp/ledger.json",
    ledgerBytes: bytes.ledgerBytes,
    overridesPath: options?.overridesPath ?? "/tmp/overrides.json",
    overridesBytes: options?.overridesBytes ?? bytes.overridesBytes,
    gateway: {
      getListing: async (_storeIndex, requestedSku) => {
        const index = Number(requestedSku.slice(5, 8));
        return options?.listingFactory?.(index) ?? beforeListing(index);
      },
    },
    imageLoader,
    requestDelayMs: 200,
    sleep: async () => undefined,
    createdAt: new Date("2026-07-18T00:04:00.000Z"),
    completedAt: new Date("2026-07-18T00:05:00.000Z"),
  });
}

test("bootstrap seals the exact 164 unique SKU/ASIN before states and is diagnostic-only", () => {
  const snapshot = bootstrap();
  assert.equal(snapshot.scope.captured, 164);
  assert.equal(snapshot.scope.unique_skus, 164);
  assert.equal(snapshot.scope.unique_asins, 164);
  assert.equal(snapshot.capture_mode, "SEALED_LEDGER_BOOTSTRAP");
  assert.equal(snapshot.apply_eligible, false);
  assert.equal(snapshot.entries[0].listing.offers != null, true);
  assert.equal(
    snapshot.entries[0].fields["/attributes/purchasable_offer"].present,
    true,
  );
  assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);
});

test("snapshot refuses incomplete scope and an override seal for another ledger", () => {
  const short = fixtureBytes(163);
  assert.throws(
    () =>
      buildLedgerBootstrapSnapshot({
        ledgerPath: "/tmp/ledger.json",
        ledgerBytes: short.ledgerBytes,
        overridesPath: "/tmp/overrides.json",
        overridesBytes: short.overridesBytes,
      }),
    /must be 164 unique/,
  );
  const exact = fixtureBytes();
  const overrides = JSON.parse(exact.overridesBytes.toString("utf8"));
  overrides.source_ledger_sha256 = "a".repeat(64);
  assert.throws(
    () =>
      buildLedgerBootstrapSnapshot({
        ledgerPath: "/tmp/ledger.json",
        ledgerBytes: exact.ledgerBytes,
        overridesPath: "/tmp/overrides.json",
        overridesBytes: Buffer.from(JSON.stringify(overrides)),
      }),
    /do not bind/,
  );
});

test("rollback preparation binds the exact reviewed desired-manifest bytes and path", () => {
  const bytes = fixtureBytes();
  const manifest = JSON.parse(
    bytes.overridesBytes.toString("utf8"),
  );
  const manifestPath = "/tmp/final-reviewed-manifest.json";
  const repair = buildRepairPlan({
    ledgerPath: "/tmp/ledger.json",
    ledgerBytes: bytes.ledgerBytes,
    manifest,
    manifestSource: { path: manifestPath, bytes: bytes.overridesBytes },
  });
  const wrongPathSnapshot = buildLedgerBootstrapSnapshot({
    ledgerPath: "/tmp/ledger.json",
    ledgerBytes: bytes.ledgerBytes,
    overridesPath: "/tmp/old-same-ledger-overrides.json",
    overridesBytes: bytes.overridesBytes,
  });
  assert.throws(
    () =>
      buildRollbackPlan({
        snapshotPath: "/tmp/snapshot.json",
        snapshot: wrongPathSnapshot,
        repairPlanPath: "/tmp/repair.json",
        repairPlan: repair,
      }),
    /exact reviewed manifest source/,
  );
  const exactSnapshot = buildLedgerBootstrapSnapshot({
    ledgerPath: "/tmp/ledger.json",
    ledgerBytes: bytes.ledgerBytes,
    overridesPath: manifestPath,
    overridesBytes: bytes.overridesBytes,
  });
  assert.doesNotThrow(() =>
    buildRollbackPlan({
      snapshotPath: "/tmp/snapshot.json",
      snapshot: exactSnapshot,
      repairPlanPath: "/tmp/repair.json",
      repairPlan: repair,
    }),
  );
});

test("a legacy repair plan without an exact desired-manifest source is diagnostic-only", async () => {
  const bytes = fixtureBytes();
  const legacyRepair = buildRepairPlan({
    ledgerPath: "/tmp/ledger.json",
    ledgerBytes: bytes.ledgerBytes,
  });
  const snapshot = await liveSnapshot();
  const rollback = buildRollbackPlan({
    snapshotPath: "/tmp/snapshot.json",
    snapshot,
    repairPlanPath: "/tmp/legacy-repair.json",
    repairPlan: legacyRepair,
  });
  assert.equal(rollback.apply_eligible, false);
  assert.throws(
    () =>
      assertForwardApplyRollbackCoverage({
        repairPlan: legacyRepair,
        snapshot,
        rollbackPlan: rollback,
        now: new Date("2026-07-18T00:06:00.000Z"),
      }),
    /not covered by an apply-eligible exact live rollback set/,
  );
});

test("live capture gets all 164 full listings and seals binary image evidence", async () => {
  const snapshot = await liveSnapshot();
  assert.equal(snapshot.capture_mode, "LIVE_SP_API");
  assert.equal(snapshot.apply_eligible, true);
  assert.equal(snapshot.entries.length, 164);
  assert.equal(snapshot.entries.every((entry) => entry.capture_source === "LIVE_SP_API"), true);
  assert.equal(snapshot.image_capture.unique_urls, 2);
  assert.equal(snapshot.image_capture.captured, 2);
  assert.equal(snapshot.image_capture.complete, true);
});

test("rollback plan restores exact before fields and selects deterministic action-covering canary", async () => {
  const snapshot = await liveSnapshot();
  const repair = repairPlan();
  const rollback = buildRollbackPlan({
    snapshotPath: "/tmp/snapshot.json",
    snapshot,
    repairPlanPath: "/tmp/repair.json",
    repairPlan: repair,
    canarySize: 3,
    createdAt: new Date("2026-07-18T00:06:00.000Z"),
  });
  assert.equal(rollback.apply_eligible, true);
  assert.equal(rollback.entries.length, 164);
  assert.equal(rollback.canary.skus.length, 3);
  assert.deepEqual(rollback.canary.covered_action_kinds, ["OFFER"]);
  const first = rollback.entries[0];
  const paths = first.operations.map((operation) => operation.path);
  assert.deepEqual(paths, [
    "/attributes/list_price",
    "/attributes/purchasable_offer",
  ]);
  assert.equal(
    first.operations.find((operation) => operation.path.endsWith("list_price"))
      ?.inverse_patch.op,
    "replace",
  );
  const offerOperation = first.operations.find(
    (operation) => operation.path.endsWith("purchasable_offer"),
  );
  assert.ok(offerOperation);
  assert.equal(offerOperation.forward_patch_op, "merge");
  assert.equal(offerOperation.inverse_patch.op, "merge");
  assert.ok(
    Array.isArray(offerOperation.before.value) &&
      offerOperation.before.value.some(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          (entry as Record<string, unknown>).audience === "B2B",
      ),
    "rollback before state must project marketplace-observed B2B even when attributes omit it",
  );
  const before = snapshot.entries.find((entry) => entry.sku === first.sku)?.listing;
  assert.ok(before);
  const repairEntry = repair.entries.find((entry) => entry.sku === first.sku);
  assert.ok(repairEntry);
  const forwardPatches = repairEntry.actions.flatMap((action) =>
    buildActionPatches(action, before),
  );
  assert.equal(
    forwardPatches.find(
      (patch) => patch.path === "/attributes/purchasable_offer",
    )?.op,
    "merge",
  );
  assert.doesNotThrow(() =>
    assertForwardPatchRollbackCovered({
      rollbackPlan: rollback,
      storeIndex: first.store_index,
      sku: first.sku,
      live: before,
      patches: forwardPatches,
    }),
  );
  const previewSurrogate = buildValidationPreviewPatchSet(
    forwardPatches,
    "FORWARD_OFFER",
  );
  assert.throws(
    () =>
      assertForwardPatchRollbackCovered({
        rollbackPlan: rollback,
        storeIndex: first.store_index,
        sku: first.sku,
        live: before,
        patches: previewSurrogate.preview_patches,
      }),
    /rollback covers only merge/,
    "rollback coverage must bind the actual merge, never the replace surrogate",
  );
  const drifted = structuredClone(before);
  drifted.attributes!.purchasable_offer = [{ third_party_drift: true }];
  assert.throws(
    () =>
      assertForwardPatchRollbackCovered({
        rollbackPlan: rollback,
        storeIndex: first.store_index,
        sku: first.sku,
        live: drifted,
        patches: forwardPatches,
      }),
    /compare-and-swap conflict/,
  );
});

test("selection-scoped rollback binds and covers exactly the content action subset", async () => {
  const {
    repair,
    snapshot,
    selection,
    repairPlanPath,
    selectionPath,
  } = await contentSelectionFixture();
  assert.equal(selection.profile, CONTENT_STRUCTURED_MEDIA_ONLY_PROFILE);
  assert.equal(selection.selected_actions, 1);

  const scoped = buildRollbackPlan({
    snapshotPath: "/tmp/content-selection-snapshot.json",
    snapshot,
    repairPlanPath,
    repairPlan: repair,
    executionSelectionPath: selectionPath,
    executionSelection: selection,
    canarySize: 1,
  });
  assert.equal(scoped.entries.length, 1);
  assert.deepEqual(
    scoped.entries.flatMap((entry) => entry.forward_action_ids),
    selection.selected_action_ids,
  );
  assert.equal(scoped.source_execution_selection?.path, selectionPath);
  assert.equal(scoped.source_execution_selection?.sha256, selection.sha256);
  assert.equal(
    scoped.entries.some((entry) =>
      entry.operations.some((operation) =>
        [
          "/attributes/purchasable_offer",
          "/attributes/list_price",
        ].includes(operation.path),
      ),
    ),
    false,
  );

  const oldestCapturedAt = Math.min(
    ...snapshot.entries.map((entry) => new Date(entry.captured_at).getTime()),
  );
  assert.doesNotThrow(() =>
    assertForwardApplyRollbackCoverage({
      repairPlan: repair,
      snapshot,
      rollbackPlan: scoped,
      executionSelection: selection,
      executionSelectionPath: selectionPath,
      now: new Date(oldestCapturedAt + 60_000),
    }),
  );

  const wholePlan = buildRollbackPlan({
    snapshotPath: "/tmp/content-selection-snapshot.json",
    snapshot,
    repairPlanPath,
    repairPlan: repair,
  });
  assert.throws(
    () =>
      assertForwardApplyRollbackCoverage({
        repairPlan: repair,
        snapshot,
        rollbackPlan: wholePlan,
        executionSelection: selection,
        executionSelectionPath: selectionPath,
        now: new Date(oldestCapturedAt + 60_000),
      }),
    /not covered by an apply-eligible exact live rollback set/,
  );
  assert.throws(
    () =>
      assertForwardApplyRollbackCoverage({
        repairPlan: repair,
        snapshot,
        rollbackPlan: scoped,
        now: new Date(oldestCapturedAt + 60_000),
      }),
    /not covered by an apply-eligible exact live rollback set/,
  );

  const textStructuredSelection = repairExecutionSelection(repair, {
    sourcePlanPath: repairPlanPath,
    createdAt: new Date("2026-07-18T00:07:00.000Z"),
    actionKinds: ["TEXT_COUNT", "STRUCTURED_ATTRIBUTES"],
  });
  assert.equal(
    textStructuredSelection.profile,
    TEXT_STRUCTURED_ONLY_PROFILE,
  );
  const textStructuredRollback = buildRollbackPlan({
    snapshotPath: "/tmp/content-selection-snapshot.json",
    snapshot,
    repairPlanPath,
    repairPlan: repair,
    executionSelectionPath: "/tmp/text-structured-selection.json",
    executionSelection: textStructuredSelection,
    canarySize: 1,
  });
  assert.equal(
    textStructuredRollback.entries.some((entry) =>
      entry.forward_action_kinds.includes("MEDIA") ||
      entry.forward_action_kinds.includes("OFFER") ||
      entry.operations.some((operation) =>
        (MEDIA_PATCH_PATHS as readonly string[]).includes(operation.path) ||
        [
          "/attributes/purchasable_offer",
          "/attributes/list_price",
        ].includes(operation.path)
      )
    ),
    false,
  );
});

test("rollback planning fails closed when an omitted attribute has no observed B2B before price", async () => {
  const snapshot = await liveSnapshot({
    listingFactory: (index) => {
      const listing = beforeListing(index);
      if (index === 1) listing.offers = [];
      return listing;
    },
  });
  assert.throws(
    () =>
      buildRollbackPlan({
        snapshotPath: "/tmp/snapshot-no-b2b.json",
        snapshot,
        repairPlanPath: "/tmp/repair.json",
        repairPlan: repairPlan(),
      }),
    /no marketplace-observed selector-level before value/,
  );
});

function applyPatches(listing: ListingItem, patches: ListingPatch[]): ListingItem {
  const next = structuredClone(listing);
  const attrs = next.attributes as Record<string, unknown>;
  for (const patch of patches) {
    const key = patch.path.replace("/attributes/", "");
    if (patch.op === "delete") delete attrs[key];
    else if (patch.op === "merge") {
      assert.equal(key, "purchasable_offer");
      const merged = applyPurchasableOfferMerge(attrs[key], patch.value);
      const updates = patch.value as Array<Record<string, unknown>>;
      const offers = Array.isArray(next.offers)
        ? structuredClone(next.offers) as Array<Record<string, unknown>>
        : [];
      for (const update of updates) {
        if (update.audience !== "B2B") continue;
        const blocks = update.our_price as Array<{
          schedule?: Array<{ value_with_tax?: number }>;
        }> | undefined;
        const amount = blocks?.[0]?.schedule?.[0]?.value_with_tax;
        if (amount == null) continue;
        let observed = offers.find(
          (offer) =>
            offer.offerType === "B2B" ||
            (offer.audience as { value?: unknown } | undefined)?.value === "B2B",
        );
        if (!observed) {
          observed = {
            offerType: "B2B",
            audience: { value: "B2B" },
            price: { currency: "USD" },
          };
          offers.push(observed);
        }
        observed.price = {
          ...(observed.price as Record<string, unknown> | undefined),
          amount: amount.toFixed(2),
        };
      }
      next.offers = offers;
      // Mirror the real 164-SKU GET representation: B2B is marketplace-observed
      // in top-level offers but omitted from attributes.purchasable_offer.
      attrs[key] = merged.filter((entry) => entry.audience !== "B2B");
    } else attrs[key] = structuredClone(patch.value);
  }
  return next;
}

test("rollback requires dual confirmation, is idempotent, and verifies readback", async () => {
  const snapshot = await liveSnapshot();
  const repair = repairPlan();
  const rollback = buildRollbackPlan({
    snapshotPath: "/tmp/snapshot.json",
    snapshot,
    repairPlanPath: "/tmp/repair.json",
    repairPlan: repair,
    canarySize: 1,
    createdAt: new Date("2026-07-18T00:06:00.000Z"),
  });
  const selected = rollback.entries.find(
    (entry) => entry.sku === rollback.canary.skus[0],
  );
  assert.ok(selected);
  const before = snapshot.entries.find((entry) => entry.sku === selected.sku)?.listing;
  assert.ok(before);
  const selectedRepair = repair.entries.find(
    (entry) => entry.sku === selected.sku,
  );
  assert.ok(selectedRepair);
  let current = selectedRepair.actions.reduce(
    (listing, action) => applyPatches(
      listing,
      buildActionPatches(action, listing),
    ),
    structuredClone(before),
  );
  let gets = 0;
  let previews = 0;
  let writes = 0;
  let previewSawReplaceSurrogate = false;
  let writeSawActualMerge = false;
  const gateway: RollbackGateway = {
    getListing: async () => {
      gets++;
      return structuredClone(current);
    },
    patchListing: async (
      _store,
      _sku,
      _pt,
      patches,
      preview,
      previewContext,
    ) => {
      const offerPatch = patches.find(
        (patch) => patch.path === "/attributes/purchasable_offer",
      );
      if (preview) {
        previews++;
        previewSawReplaceSurrogate =
          offerPatch?.op === "replace" &&
          previewContext?.strategy ===
            SELECTOR_REPLACE_SURROGATE_FOR_MERGE &&
          previewContext.actual_patches.find(
            (patch) => patch.path === "/attributes/purchasable_offer",
          )?.op === "merge";
        return { status: "VALID", issues: [] };
      }
      writes++;
      writeSawActualMerge = offerPatch?.op === "merge";
      current = applyPatches(current, patches);
      return { status: "ACCEPTED", submissionId: "sub-1", issues: [] };
    },
  };
  const checkpointRoot = path.join(
    tmpdir(),
    `uncr-rollback-${Date.now()}-${Math.random()}`,
  );
  const checkpoint = new ImmutableRollbackCheckpointStore(
    checkpointRoot,
    rollback.sha256,
  );
  const token = rollbackConfirmationToken(rollback);
  const forwardCheckpoint = testCheckpointStore(
    path.join(tmpdir(), `uncr-forward-guard-${Date.now()}-${Math.random()}`),
    repair.sha256,
  );
  const dry = await executeRollbackPlan(rollback, gateway, {
    apply: false,
    scope: "CANARY",
    checkpointStore: checkpoint,
  });
  assert.equal(dry.mode, "DRY_RUN");
  assert.equal(gets, 0);
  const partialDry = await executeRollbackPlan(rollback, gateway, {
    apply: false,
    skus: [selected.sku],
    checkpointStore: checkpoint,
  });
  assert.equal(partialDry.scope, "SKUS");
  assert.equal(partialDry.selected_entries, 1);
  assert.equal(gets, 0);
  const readiness = await executeRollbackPlan(rollback, gateway, {
    apply: false,
    validationOnly: true,
    skus: [selected.sku],
    checkpointStore: checkpoint,
    requestDelayMs: 200,
    sleep: async () => undefined,
  });
  assert.equal(readiness.mode, "VALIDATION_PREVIEW");
  assert.equal(readiness.preview_valid_entries, 1);
  assert.equal(previews, 1);
  assert.equal(writes, 0);
  const getsAfterReadiness = gets;
  await assert.rejects(
    executeRollbackPlan(rollback, gateway, {
      apply: true,
      scope: "CANARY",
      confirmation: token,
      environmentConfirmation: "WRONG",
      checkpointStore: checkpoint,
    }),
    /requires both/,
  );
  assert.equal(gets, getsAfterReadiness);
  const result = await executeRollbackPlan(rollback, gateway, {
    apply: true,
    scope: "CANARY",
    confirmation: token,
    environmentConfirmation: token,
    checkpointStore: checkpoint,
    forwardRepairPlan: repair,
    forwardCheckpointStore: forwardCheckpoint,
    requestDelayMs: 200,
    verifyAttempts: 2,
    verifyDelayMs: 1,
    settlementAttempts: 3,
    settlementDelayMs: 1,
    settlementStableReads: 2,
    sleep: async () => undefined,
  });
  assert.equal(result.verified_entries, 1);
  assert.equal(previews, 2);
  assert.equal(writes, 1);
  assert.equal(previewSawReplaceSurrogate, true);
  assert.equal(writeSawActualMerge, true);
  assert.ok(gets >= 3);
  const checkpointDir = path.join(
    checkpointRoot,
    rollback.sha256.slice(0, 20),
  );
  const checkpointEvents = await Promise.all(
    (await readdir(checkpointDir)).map(async (name) =>
      JSON.parse(await readFile(path.join(checkpointDir, name), "utf8")) as {
        status: string;
        detail: Record<string, unknown>;
      },
    ),
  );
  const previewEvidence = checkpointEvents.find(
    (event) =>
      event.status === "PREVIEW_VALID" &&
      event.detail.strategy === SELECTOR_REPLACE_SURROGATE_FOR_MERGE,
  )?.detail;
  assert.ok(previewEvidence);
  assert.match(String(previewEvidence.actual_merge_patch_sha256), /^[a-f0-9]{64}$/);
  assert.match(
    String(previewEvidence.preview_surrogate_patch_sha256),
    /^[a-f0-9]{64}$/,
  );
  assert.notEqual(
    previewEvidence.actual_merge_patch_sha256,
    previewEvidence.preview_surrogate_patch_sha256,
  );
  const submittedEvidence = checkpointEvents.find(
    (event) => event.status === "SUBMITTED",
  )?.detail;
  assert.equal(
    submittedEvidence?.actual_merge_patch_sha256,
    previewEvidence.actual_merge_patch_sha256,
  );

  const resumed = await executeRollbackPlan(rollback, gateway, {
    apply: true,
    scope: "CANARY",
    confirmation: token,
    environmentConfirmation: token,
    checkpointStore: checkpoint,
    forwardRepairPlan: repair,
    forwardCheckpointStore: forwardCheckpoint,
    requestDelayMs: 200,
    sleep: async () => undefined,
  });
  assert.equal(resumed.resumed_entries, 1);
  assert.equal(writes, 1);
});

test("rollback rejects an invalid inverse offer surrogate before any real merge", async () => {
  const snapshot = await liveSnapshot();
  const repair = repairPlan();
  const rollback = buildRollbackPlan({
    snapshotPath: "/tmp/snapshot-invalid-preview.json",
    snapshot,
    repairPlanPath: "/tmp/repair-invalid-preview.json",
    repairPlan: repair,
    canarySize: 1,
    createdAt: new Date("2026-07-18T00:06:30.000Z"),
  });
  const selected = rollback.entries.find(
    (entry) => entry.sku === rollback.canary.skus[0],
  );
  assert.ok(selected);
  const before = snapshot.entries.find(
    (entry) => entry.sku === selected.sku,
  )?.listing;
  const selectedRepair = repair.entries.find(
    (entry) => entry.sku === selected.sku,
  );
  assert.ok(before);
  assert.ok(selectedRepair);
  const current = selectedRepair.actions.reduce(
    (listing, action) =>
      applyPatches(listing, buildActionPatches(action, listing)),
    structuredClone(before),
  );
  let realWrites = 0;
  let sawSurrogate = false;
  const gateway: RollbackGateway = {
    getListing: async () => structuredClone(current),
    patchListing: async (
      _store,
      _sku,
      _type,
      patches,
      preview,
      previewContext,
    ) => {
      if (!preview) realWrites++;
      if (preview) {
        sawSurrogate =
          patches.find(
            (patch) => patch.path === "/attributes/purchasable_offer",
          )?.op === "replace" &&
          previewContext?.actual_patches.find(
            (patch) => patch.path === "/attributes/purchasable_offer",
          )?.op === "merge";
      }
      return { status: preview ? "INVALID" : "ACCEPTED", issues: [] };
    },
  };
  const token = rollbackConfirmationToken(rollback);
  const result = await executeRollbackPlan(rollback, gateway, {
    apply: true,
    skus: [selected.sku],
    confirmation: token,
    environmentConfirmation: token,
    checkpointStore: new ImmutableRollbackCheckpointStore(
      path.join(tmpdir(), `uncr-rollback-invalid-${Date.now()}`),
      rollback.sha256,
    ),
    forwardRepairPlan: repair,
    forwardCheckpointStore: testCheckpointStore(
      path.join(tmpdir(), `uncr-forward-invalid-${Date.now()}-${Math.random()}`),
      repair.sha256,
    ),
    requestDelayMs: 200,
    sleep: async () => undefined,
  });
  assert.equal(result.failed_entries, 1);
  assert.equal(sawSurrogate, true);
  assert.equal(realWrites, 0);
});

test("an unresolved accepted rollback is settled by readback without a duplicate inverse PATCH", async () => {
  const snapshot = await liveSnapshot();
  const repair = repairPlan();
  const rollback = buildRollbackPlan({
    snapshotPath: "/tmp/snapshot-late-rollback.json",
    snapshot,
    repairPlanPath: "/tmp/repair-late-rollback.json",
    repairPlan: repair,
    canarySize: 1,
    createdAt: new Date("2026-07-18T00:06:45.000Z"),
  });
  const selected = rollback.entries.find(
    (entry) => entry.sku === rollback.canary.skus[0],
  );
  assert.ok(selected);
  const before = snapshot.entries.find(
    (entry) => entry.sku === selected.sku,
  )?.listing;
  const selectedRepair = repair.entries.find(
    (entry) => entry.sku === selected.sku,
  );
  assert.ok(before);
  assert.ok(selectedRepair);
  const forward = selectedRepair.actions.reduce(
    (listing, action) =>
      applyPatches(listing, buildActionPatches(action, listing)),
    structuredClone(before),
  );
  const conflict = structuredClone(forward);
  const firstAttribute = selected.operations[0].path.replace(
    "/attributes/",
    "",
  );
  conflict.attributes = {
    ...conflict.attributes,
    [firstAttribute]: [{ unexpected: "intermediate-amazon-state" }],
  };
  let phase: "UNSETTLED" | "LATE_ROLLED_BACK" = "UNSETTLED";
  let afterSubmission = false;
  let settlementRead = 0;
  let realWrites = 0;
  const gateway: RollbackGateway = {
    getListing: async () => {
      if (phase === "LATE_ROLLED_BACK") return structuredClone(before);
      if (!afterSubmission) return structuredClone(forward);
      settlementRead++;
      return structuredClone(
        settlementRead % 2 === 1 ? forward : conflict,
      );
    },
    patchListing: async (_store, _sku, _type, _patches, preview) => {
      if (preview) return { status: "VALID", issues: [] };
      realWrites++;
      afterSubmission = true;
      return {
        status: "IN_PROGRESS",
        submissionId: "late-rollback-submission",
        issues: [],
      };
    },
  };
  const rollbackCheckpoint = new ImmutableRollbackCheckpointStore(
    path.join(tmpdir(), `uncr-late-rollback-${Date.now()}-${Math.random()}`),
    rollback.sha256,
  );
  const forwardCheckpoint = testCheckpointStore(
    path.join(tmpdir(), `uncr-late-forward-${Date.now()}-${Math.random()}`),
    repair.sha256,
  );
  const token = rollbackConfirmationToken(rollback);
  const first = await executeRollbackPlan(rollback, gateway, {
    apply: true,
    skus: [selected.sku],
    confirmation: token,
    environmentConfirmation: token,
    checkpointStore: rollbackCheckpoint,
    forwardRepairPlan: repair,
    forwardCheckpointStore: forwardCheckpoint,
    requestDelayMs: 200,
    verifyAttempts: 1,
    verifyDelayMs: 1,
    settlementAttempts: 3,
    settlementDelayMs: 1,
    settlementStableReads: 2,
    sleep: async () => undefined,
  });
  assert.equal(first.failed_entries, 1);
  assert.equal(first.stopped_early, true);
  assert.equal(first.unresolved_settlements, 1);
  assert.equal(realWrites, 1);
  assert.equal((await rollbackCheckpoint.pendingSubmissions()).size, 1);

  phase = "LATE_ROLLED_BACK";
  const recovered = await executeRollbackPlan(rollback, gateway, {
    apply: true,
    skus: [selected.sku],
    confirmation: token,
    environmentConfirmation: token,
    checkpointStore: rollbackCheckpoint,
    forwardRepairPlan: repair,
    forwardCheckpointStore: forwardCheckpoint,
    requestDelayMs: 200,
    settlementAttempts: 3,
    settlementDelayMs: 1,
    settlementStableReads: 2,
    sleep: async () => undefined,
  });
  assert.equal(recovered.recovered_pending_rollback_entries, 1);
  assert.equal(recovered.verified_entries, 1);
  assert.equal(recovered.failed_entries, 0);
  assert.equal(realWrites, 1, "rollback recovery must not duplicate the inverse PATCH");
  assert.equal((await rollbackCheckpoint.pendingSubmissions()).size, 0);
});

test("rollback never reports before-state as restored while a forward submission is open", async () => {
  const snapshot = await liveSnapshot();
  const repair = repairPlan();
  const rollback = buildRollbackPlan({
    snapshotPath: "/tmp/snapshot-open-forward.json",
    snapshot,
    repairPlanPath: "/tmp/repair-open-forward.json",
    repairPlan: repair,
    canarySize: 1,
  });
  const selected = rollback.entries.find(
    (entry) => entry.sku === rollback.canary.skus[0],
  );
  assert.ok(selected);
  const before = snapshot.entries.find(
    (entry) => entry.sku === selected.sku,
  )?.listing;
  const selectedRepair = repair.entries.find(
    (entry) => entry.sku === selected.sku,
  );
  assert.ok(before);
  assert.ok(selectedRepair);
  const forwardCheckpoint = testCheckpointStore(
    path.join(tmpdir(), `uncr-open-forward-${Date.now()}-${Math.random()}`),
    repair.sha256,
  );
  const forwardAction = selectedRepair.actions[0];
  await forwardCheckpoint.append({
    action_id: forwardAction.action_id,
    sku: selected.sku,
    kind: forwardAction.kind,
    status: "SUBMITTED",
    detail: {
      status: "IN_PROGRESS",
      submission_id: "open-forward-without-settlement-evidence",
    },
  });
  let writes = 0;
  const gateway: RollbackGateway = {
    getListing: async () => structuredClone(before),
    patchListing: async () => {
      writes++;
      return { status: "VALID", issues: [] };
    },
  };
  const token = rollbackConfirmationToken(rollback);
  const result = await executeRollbackPlan(rollback, gateway, {
    apply: true,
    skus: [selected.sku],
    confirmation: token,
    environmentConfirmation: token,
    checkpointStore: new ImmutableRollbackCheckpointStore(
      path.join(tmpdir(), `uncr-open-forward-rb-${Date.now()}-${Math.random()}`),
      rollback.sha256,
    ),
    forwardRepairPlan: repair,
    forwardCheckpointStore: forwardCheckpoint,
    requestDelayMs: 200,
    settlementAttempts: 3,
    settlementDelayMs: 1,
    settlementStableReads: 2,
    sleep: async () => undefined,
  });
  assert.equal(result.already_rolled_back_entries, 0);
  assert.equal(result.failed_entries, 1);
  assert.equal(result.stopped_early, true);
  assert.equal(result.unresolved_settlements, 1);
  assert.equal(writes, 0);
});

test("selection rollback quarantines a disjoint open OFFER and leaves its forward fence open", async () => {
  const {
    repair,
    snapshot,
    selection,
    repairPlanPath,
    selectionPath,
  } = await contentSelectionFixture();
  const rollback = buildRollbackPlan({
    snapshotPath: "/tmp/content-selection-snapshot.json",
    snapshot,
    repairPlanPath,
    repairPlan: repair,
    executionSelectionPath: selectionPath,
    executionSelection: selection,
    canarySize: 1,
  });
  const rollbackEntry = rollback.entries[0];
  const repairEntry = repair.entries.find(
    (entry) => entry.sku === rollbackEntry.sku,
  );
  const before = snapshot.entries.find(
    (entry) => entry.sku === rollbackEntry.sku,
  )?.listing;
  const offerAction = repairEntry?.actions.find(
    (action) => action.kind === "OFFER",
  );
  assert.ok(before);
  assert.ok(offerAction);

  const offerPatches = buildActionPatches(offerAction, before);
  const offerPaths = [...new Set(offerPatches.map((patch) => patch.path))].sort();
  const offerPatchSha = sha256(stableJson(offerPatches));
  const testRoot = path.join(
    tmpdir(),
    `uncr-selection-rollback-${Date.now()}-${Math.random()}`,
  );
  const coordinationDir = path.join(testRoot, "coordination");
  const forwardCheckpoint = new ImmutableCheckpointStore(
    path.join(testRoot, "forward"),
    repair.sha256,
    coordinationDir,
  );
  const pendingOffer = await forwardCheckpoint.append({
    action_id: offerAction.action_id,
    sku: rollbackEntry.sku,
    kind: "OFFER",
    status: "SUBMITTED",
    detail: {
      strategy: SELECTOR_REPLACE_SURROGATE_FOR_MERGE,
      actual_request_patch_sha256: offerPatchSha,
      actual_request_patch_paths: offerPaths,
      settlement_guard: {
        schema_version: EXACT_PATH_SETTLEMENT_GUARD,
        actual_patch_sha256: offerPatchSha,
        exact_action_paths: offerPaths,
        before_path_state_sha256: "a".repeat(64),
      },
    },
  });
  let gets = 0;
  let writes = 0;
  const gateway: RollbackGateway = {
    getListing: async () => {
      gets++;
      return structuredClone(before);
    },
    patchListing: async () => {
      writes++;
      throw new Error("already-restored content paths must not PATCH");
    },
  };
  const token = rollbackConfirmationToken(rollback);
  const result = await executeRollbackPlan(rollback, gateway, {
    apply: true,
    scope: "ALL",
    confirmation: token,
    environmentConfirmation: token,
    checkpointStore: new ImmutableRollbackCheckpointStore(
      path.join(testRoot, "rollback"),
      rollback.sha256,
      coordinationDir,
    ),
    forwardRepairPlan: repair,
    forwardExecutionSelection: selection,
    forwardExecutionSelectionPath: selectionPath,
    forwardCheckpointStore: forwardCheckpoint,
    requestDelayMs: 200,
    settlementAttempts: 3,
    settlementDelayMs: 1,
    settlementStableReads: 2,
    sleep: async () => undefined,
  });
  assert.equal(result.quarantined_pending_forward_actions, 1);
  assert.equal(result.recovered_pending_forward_actions, 0);
  assert.equal(result.already_rolled_back_entries, 1);
  assert.equal(result.failed_entries, 0);
  assert.equal(gets, 1);
  assert.equal(writes, 0);
  const pending = await forwardCheckpoint.pendingSubmissions();
  assert.equal(pending.size, 1);
  assert.equal(
    pending.get(offerAction.action_id)?.submitted_event_id,
    pendingOffer.event_id,
  );
  await readFile(
    path.join(coordinationDir, "pending-mutation-fence.json"),
    "utf8",
  );
});

test("compare-and-swap conflict blocks mutation and trips the one-error fuse", async () => {
  const snapshot = await liveSnapshot();
  const repair = repairPlan();
  const rollback = buildRollbackPlan({
    snapshotPath: "/tmp/snapshot.json",
    snapshot,
    repairPlanPath: "/tmp/repair.json",
    repairPlan: repair,
    canarySize: 1,
  });
  const selected = rollback.entries.find(
    (entry) => entry.sku === rollback.canary.skus[0],
  );
  assert.ok(selected);
  const before = snapshot.entries.find((entry) => entry.sku === selected.sku)?.listing;
  assert.ok(before);
  const conflicting = structuredClone(before);
  conflicting.attributes!.purchasable_offer = [{ unexpected: "third-party change" }];
  let writes = 0;
  const gateway: RollbackGateway = {
    getListing: async () => conflicting,
    patchListing: async () => {
      writes++;
      return { status: "VALID" };
    },
  };
  const checkpoint = new ImmutableRollbackCheckpointStore(
    path.join(tmpdir(), `uncr-conflict-${Date.now()}-${Math.random()}`),
    rollback.sha256,
  );
  const token = rollbackConfirmationToken(rollback);
  const result = await executeRollbackPlan(rollback, gateway, {
    apply: true,
    scope: "CANARY",
    confirmation: token,
    environmentConfirmation: token,
    checkpointStore: checkpoint,
    forwardRepairPlan: repair,
    forwardCheckpointStore: testCheckpointStore(
      path.join(tmpdir(), `uncr-forward-conflict-${Date.now()}-${Math.random()}`),
      repair.sha256,
    ),
    maxErrors: 1,
  });
  assert.equal(result.failed_entries, 1);
  assert.equal(result.stopped_early, true);
  assert.equal(writes, 0);
});

test("forward apply gate requires fresh live exact rollback coverage", async () => {
  const snapshot = await liveSnapshot();
  const oldestCapturedAt = Math.min(
    ...snapshot.entries.map((entry) => new Date(entry.captured_at).getTime()),
  );
  const repair = repairPlan();
  const rollback = buildRollbackPlan({
    snapshotPath: "/tmp/snapshot.json",
    snapshot,
    repairPlanPath: "/tmp/repair.json",
    repairPlan: repair,
    canarySize: 3,
    createdAt: new Date("2026-07-18T00:06:00.000Z"),
  });
  assert.doesNotThrow(() =>
    assertForwardApplyRollbackCoverage({
      repairPlan: repair,
      snapshot,
      rollbackPlan: rollback,
      selectedSkus: rollback.canary.skus,
      now: new Date(oldestCapturedAt + 30 * 60_000),
      maxSnapshotAgeMinutes: 60,
    }),
  );
  assert.throws(
    () =>
      assertForwardApplyRollbackCoverage({
        repairPlan: repair,
        snapshot,
        rollbackPlan: rollback,
        now: new Date(oldestCapturedAt + 120 * 60_000),
        maxSnapshotAgeMinutes: 60,
      }),
    /snapshot is stale/,
  );
});

test("forward apply blocks product-type transitions that attribute rollback cannot restore", async () => {
  const bytes = fixtureBytes();
  const manifest = {
    schema_version: "uncrustables-surgical-desired/v1" as const,
    immutable: true as const,
    reviewed_at: "2026-07-18T00:01:00.000Z",
    source_ledger_sha256: sha256(bytes.ledgerBytes),
    repairs: [
      {
        sku: sku(1),
        review: {
          confidence: "HIGH" as const,
          rationale: "Test-only attempted type transition.",
          evidence: ["Captured GROCERY before state."],
        },
        text_count: {
          unit_count: 68,
          unit_count_type: "Ounce" as const,
          number_of_items: 24,
          request_product_type: "PASTRY",
          expected_product_type: "PASTRY",
        },
      },
    ],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const manifestPath = "/tmp/type-transition-overrides.json";
  const repair = buildRepairPlan({
    ledgerPath: "/tmp/ledger.json",
    ledgerBytes: bytes.ledgerBytes,
    manifest,
    manifestSource: { path: manifestPath, bytes: manifestBytes },
  });
  const snapshot = await liveSnapshot({
    overridesBytes: manifestBytes,
    overridesPath: manifestPath,
  });
  const rollback = buildRollbackPlan({
    snapshotPath: "/tmp/snapshot.json",
    snapshot,
    repairPlanPath: "/tmp/repair.json",
    repairPlan: repair,
  });
  assert.throws(
    () =>
      assertForwardApplyRollbackCoverage({
        repairPlan: repair,
        snapshot,
        rollbackPlan: rollback,
        selectedSkus: [sku(1)],
        now: new Date(snapshot.completed_at),
      }),
    /product-type transition not covered/,
  );
});
