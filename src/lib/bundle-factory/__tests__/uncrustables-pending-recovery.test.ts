import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import type { ListingItem } from "@/lib/amazon-sp-api/listings";
import {
  EXACT_PATH_SETTLEMENT_GUARD,
  ImmutableCheckpointStore,
  VERIFIED_BRAND_CARD_REHOST_URL,
  buildActionPatches,
  buildRepairPlan,
  executeRepairPlan,
  readRepairExecutionSelection,
  readRepairPlan,
  repairExecutionSelection,
  sha256,
  stableJson,
  type CheckpointEvent,
  type PlannedRepairAction,
  type RepairAmazonGateway,
  type RepairExecutionSelection,
  type RepairPlanEntry,
  type UncrustablesRepairPlan,
} from "../repair/uncrustables-surgical";

const PRODUCT_URLS = Array.from(
  { length: 5 },
  (_, index) => `https://m.media-amazon.com/images/I/TESTPRODUCT${index + 1}.jpg`,
);
const DESIRED_GALLERY = [VERIFIED_BRAND_CARD_REHOST_URL, ...PRODUCT_URLS];
const BEFORE_GALLERY = Array.from(
  { length: 7 },
  (_, index) => `https://m.media-amazon.com/images/I/BEFORE${index + 1}.jpg`,
);

function uniqueRoot(label: string): string {
  return path.join(
    tmpdir(),
    `uncr-pending-recovery-${label}-${Date.now()}-${Math.random()}`,
  );
}

function checkpointStore(
  root: string,
  planSha256: string,
): ImmutableCheckpointStore {
  return new ImmutableCheckpointStore(
    root,
    planSha256,
    path.join(root, "coordination"),
  );
}

function ledgerRow(sku: string, asin: string) {
  return {
    sku,
    asin,
    store_index: 1,
    canonical: {
      total_units: 24,
      components: [
        {
          product_id: "grape",
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
              product_id: "grape",
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
      product_type: "GROCERY",
      title: "Uncrustables Peanut Butter & Grape Jelly Sandwiches, 24 Count",
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
      gallery_image_urls: [...BEFORE_GALLERY],
      consumer_offer: {
        our_price: 76.99,
        minimum_seller_allowed_price: 66.95,
        maximum_seller_allowed_price: 76.99,
      },
      raw_offers: [
        {
          offerType: "B2C",
          price: { amount: "76.99" },
          audience: { value: "ALL" },
        },
        {
          offerType: "B2B",
          price: { amount: "76.99" },
          audience: { value: "B2B" },
        },
      ],
    },
    anomalies: [],
  };
}

function buildMediaPlan(
  rows = [ledgerRow("AZ-ASMY-VEQ2", "B000TEST001")],
): UncrustablesRepairPlan {
  const ledger = Buffer.from(
    JSON.stringify({
      schema_version: "uncrustables-ledger/v1.2",
      audit_id: "UL-PENDING-RECOVERY-TEST",
      complete: true,
      immutable: true,
      mode: "live",
      external_mutations: false,
      completed_at: "2026-07-18T00:00:00.000Z",
      rows,
    }),
  );
  const manifest = {
    schema_version: "uncrustables-surgical-desired/v1" as const,
    source_ledger_sha256: sha256(ledger),
    repairs: rows.map((row) => ({
      sku: row.sku,
      media: {
        gallery_image_urls: [...DESIRED_GALLERY],
        delete_gallery_slots: [7, 8],
      },
    })),
  };
  return buildRepairPlan({
    ledgerPath: "/tmp/uncr-pending-recovery-ledger.json",
    ledgerBytes: ledger,
    manifest,
    createdAt: new Date("2026-07-18T00:00:00.000Z"),
  });
}

function buildMainPlan(): UncrustablesRepairPlan {
  const row = ledgerRow("LK-AS7X-K43B", "B000TEST001");
  const ledger = Buffer.from(JSON.stringify({
    schema_version: "uncrustables-ledger/v1.2",
    audit_id: "UL-PENDING-MAIN-RECOVERY-TEST",
    complete: true,
    immutable: true,
    mode: "live",
    external_mutations: false,
    completed_at: "2026-07-19T04:00:00.000Z",
    rows: [row],
  }));
  return buildRepairPlan({
    ledgerPath: "/tmp/uncr-pending-main-recovery-ledger.json",
    ledgerBytes: ledger,
    manifest: {
      schema_version: "uncrustables-surgical-desired/v1",
      source_ledger_sha256: sha256(ledger),
      repairs: [{
        sku: row.sku,
        media: {
          main_image_url:
            "https://pub-test.r2.dev/uncrustables/desired-main.png",
        },
      }],
    },
    createdAt: new Date("2026-07-19T04:00:00.000Z"),
  });
}

function mediaAction(entry: RepairPlanEntry): PlannedRepairAction {
  const action = entry.actions.find((candidate) => candidate.kind === "MEDIA");
  assert.ok(action && action.desired.kind === "MEDIA");
  return action;
}

function listing(
  entry: RepairPlanEntry,
  urls: readonly string[],
  marketplaceId = MARKETPLACE_ID,
): ListingItem {
  return {
    sku: entry.sku,
    summaries: [
      {
        marketplaceId,
        asin: entry.asin,
        productType: "GROCERY",
        itemName: "Uncrustables test listing",
      },
    ],
    attributes: Object.fromEntries(
      urls.map((url, index) => [
        `other_product_image_locator_${index + 1}`,
        [{ marketplace_id: marketplaceId, media_location: url }],
      ]),
    ),
  };
}

function mainListing(
  entry: RepairPlanEntry,
  buyerMain: string,
  attributeMain: string,
): ListingItem {
  return {
    sku: entry.sku,
    summaries: [{
      marketplaceId: MARKETPLACE_ID,
      asin: entry.asin,
      productType: "GROCERY",
      itemName: "Uncrustables test listing",
      mainImage: { link: buyerMain },
    }],
    attributes: {
      main_product_image_locator: [{
        marketplace_id: MARKETPLACE_ID,
        media_location: attributeMain,
      }],
    },
  };
}

function pathStateSha256(live: ListingItem, paths: readonly string[]): string {
  const attrs = (live.attributes ?? {}) as Record<string, unknown>;
  const states = [...new Set(paths)].sort().map((patchPath) => {
    const match = /^\/attributes\/([A-Za-z0-9_]+)$/.exec(patchPath);
    assert.ok(match);
    const attribute = match[1];
    const present = Object.prototype.hasOwnProperty.call(attrs, attribute);
    return {
      path: patchPath,
      present,
      value_sha256: sha256(stableJson(present ? attrs[attribute] : null)),
    };
  });
  return sha256(stableJson(states));
}

interface PendingOverrides {
  strategy?: unknown;
  armedStrategy?: unknown;
  armedEvidencePatchSha?: unknown;
  evidencePaths?: unknown[];
  patchSha?: unknown;
  patchPaths?: unknown;
  actualPatchSha?: unknown;
  actualPatchPaths?: unknown;
  omitArmedEventId?: boolean;
}

async function appendPending(
  store: ImmutableCheckpointStore,
  entry: RepairPlanEntry,
  action: PlannedRepairAction,
  before: ListingItem,
  overrides: PendingOverrides = {},
): Promise<CheckpointEvent> {
  const patches = buildActionPatches(action, before);
  const paths = [...new Set(patches.map((patch) => patch.path))].sort();
  const patchSha = sha256(stableJson(patches));
  const evidence = {
    schema_version: EXACT_PATH_SETTLEMENT_GUARD,
    actual_patch_sha256: patchSha,
    exact_action_paths: overrides.evidencePaths ?? paths,
    before_path_state_sha256: pathStateSha256(before, paths),
  };
  const strategy = overrides.strategy ?? "PRIMARY";
  const armedEvidence = Object.prototype.hasOwnProperty.call(
      overrides,
      "armedEvidencePatchSha",
    )
    ? {
        ...evidence,
        actual_patch_sha256: overrides.armedEvidencePatchSha,
      }
    : evidence;
  const armed = overrides.omitArmedEventId
    ? null
    : await store.append({
        action_id: action.action_id,
        sku: entry.sku,
        kind: action.kind,
        status: "SUBMISSION_ARMED",
        detail: {
          strategy: overrides.armedStrategy ?? strategy,
          crash_window_guard: true,
          settlement_guard: armedEvidence,
        },
      });
  const detail: Record<string, unknown> = {
    strategy,
    patch_sha256: overrides.patchSha ?? patchSha,
    patch_paths: overrides.patchPaths ?? patches.map((patch) => patch.path),
    settlement_guard: evidence,
    status: "ACCEPTED",
    submission_id: `submission-${entry.sku}`,
  };
  if (armed) {
    detail.armed_event_id = armed.event_id;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, "actualPatchSha")) {
    detail.actual_request_patch_sha256 = overrides.actualPatchSha;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, "actualPatchPaths")) {
    detail.actual_request_patch_paths = overrides.actualPatchPaths;
  }
  return store.append({
    action_id: action.action_id,
    sku: entry.sku,
    kind: action.kind,
    status: "SUBMITTED",
    detail,
  });
}

function selectionFor(
  plan: UncrustablesRepairPlan,
  skus: string[] | null = null,
): RepairExecutionSelection {
  return repairExecutionSelection(plan, {
    sourcePlanPath: "/tmp/uncr-pending-recovery-plan.json",
    createdAt: new Date("2026-07-18T14:00:00.000Z"),
    skus,
    actionKinds: ["MEDIA"],
  });
}

function policy(maxReadsPerSubmission: number, timeoutMs = 100) {
  return {
    horizonMs: 1_000,
    pollIntervalMs: 1,
    requestDelayMs: 1,
    observationTimeoutMs: timeoutMs,
    stableReads: 3,
    maxReadsPerSubmission,
  };
}

function recoveryOptions(
  store: ImmutableCheckpointStore,
  selection: RepairExecutionSelection,
  maxReadsPerSubmission: number,
  timeoutMs = 100,
) {
  return {
    apply: false,
    recoverPendingOnly: true,
    checkpointStore: store,
    executionSelection: selection,
    pendingRecoveryPolicy: policy(maxReadsPerSubmission, timeoutMs),
    sleep: async () => {},
  } as const;
}

test("PENDING_SETTLE_ONLY closes exact MEDIA submission after 3 new exact US reads and never PATCHes", async () => {
  const plan = buildMediaPlan();
  const entry = plan.entries[0];
  const action = mediaAction(entry);
  const selection = selectionFor(plan);
  const root = uniqueRoot("happy");
  const store = checkpointStore(root, plan.sha256);
  const submitted = await appendPending(
    store,
    entry,
    action,
    listing(entry, BEFORE_GALLERY),
  );
  const desired = listing(entry, DESIRED_GALLERY);
  const wrongMarketplace = listing(entry, DESIRED_GALLERY, "WRONG-MARKETPLACE");
  let gets = 0;
  let patches = 0;
  const signals: AbortSignal[] = [];
  const gateway: RepairAmazonGateway = {
    getListing: async (_store, _sku, signal) => {
      assert.ok(signal);
      signals.push(signal);
      gets++;
      return structuredClone(gets === 1 ? wrongMarketplace : desired);
    },
    patchListing: async () => {
      patches++;
      throw new Error("generic recovery must never PATCH");
    },
  };
  const result = await executeRepairPlan(
    plan,
    gateway,
    recoveryOptions(store, selection, 4),
  );
  assert.equal(result.mode, "PENDING_SETTLE_ONLY");
  assert.equal(result.verified_actions, 1);
  assert.equal(result.recovered_pending_actions, 1);
  assert.equal(result.unresolved_settlements, 0);
  assert.equal(gets, 4, "wrong-marketplace read must not count toward stable 3");
  assert.equal(patches, 0);
  assert.equal(signals.every((signal) => !signal.aborted), true);
  assert.equal((await store.pendingSubmissions()).size, 0);

  const events = await Promise.all(
    (await readdir(path.join(root, plan.sha256.slice(0, 20))))
      .filter((name) => name.endsWith(".json"))
      .map(async (name) =>
        JSON.parse(
          await readFile(path.join(root, plan.sha256.slice(0, 20), name), "utf8"),
        ) as CheckpointEvent
      ),
  );
  const verified = events.find(
    (event) =>
      event.status === "VERIFIED" &&
      event.detail.trigger === "PENDING_SETTLE_ONLY",
  );
  assert.equal(verified?.detail.submitted_event_id, submitted.event_id);
  assert.equal(verified?.detail.stable_post_write_reads, 3);
  assert.equal(verified?.detail.selection_sha256, selection.sha256);
  await assert.rejects(
    readFile(path.join(root, "coordination", "pending-mutation-fence.json")),
    /ENOENT/,
  );
  await assert.rejects(
    readFile(path.join(root, "coordination", "active-execution.lock")),
    /ENOENT/,
  );
});

test("PENDING_SETTLE_ONLY closes MAIN after 3 buyer-summary rehost reads while the authoring locator lags", async () => {
  const plan = buildMainPlan();
  const entry = plan.entries[0];
  const action = mediaAction(entry);
  assert.equal(action.desired.kind, "MEDIA");
  const desiredUrl = action.desired.value.main_image_url;
  assert.ok(desiredUrl);
  const selection = selectionFor(plan);
  const root = uniqueRoot("main-buyer-summary");
  const store = checkpointStore(root, plan.sha256);
  const oldAttribute =
    "https://m.media-amazon.com/images/I/OLD-AUTHORING.jpg";
  const oldBuyer = "https://m.media-amazon.com/images/I/OLD-BUYER.jpg";
  const newBuyer = "https://m.media-amazon.com/images/I/NEW-BUYER.jpg";
  await appendPending(
    store,
    entry,
    action,
    mainListing(entry, oldBuyer, oldAttribute),
  );
  let gets = 0;
  let patches = 0;
  const gateway: RepairAmazonGateway = {
    getListing: async () => {
      gets++;
      return mainListing(entry, newBuyer, oldAttribute);
    },
    patchListing: async () => {
      patches++;
      throw new Error("buyer-summary recovery must never PATCH");
    },
  };
  const result = await executeRepairPlan(plan, gateway, {
    ...recoveryOptions(store, selection, 3),
    mediaEquivalence: {
      equivalent: async (expected, actual) =>
        expected === desiredUrl && actual === newBuyer,
    },
  });
  assert.equal(result.verified_actions, 1);
  assert.equal(result.recovered_pending_actions, 1);
  assert.equal(result.unresolved_settlements, 0);
  assert.equal(gets, 3);
  assert.equal(patches, 0);
  assert.equal((await store.pendingSubmissions()).size, 0);
});

test("PENDING_SETTLE_ONLY fails before GET when exact selection omits canonical pending", async () => {
  const rows = [
    ledgerRow("AA-ASAA-AAAA", "B000TEST001"),
    ledgerRow("BB-ASBB-BBBB", "B000TEST002"),
  ];
  const plan = buildMediaPlan(rows);
  const root = uniqueRoot("selection-mismatch");
  const store = checkpointStore(root, plan.sha256);
  for (const entry of plan.entries) {
    await appendPending(
      store,
      entry,
      mediaAction(entry),
      listing(entry, BEFORE_GALLERY),
    );
  }
  const selection = selectionFor(plan, [plan.entries[0].sku]);
  let calls = 0;
  await assert.rejects(
    executeRepairPlan(
      plan,
      {
        getListing: async () => {
          calls++;
          return listing(plan.entries[0], DESIRED_GALLERY);
        },
        patchListing: async () => {
          calls++;
          return {};
        },
      },
      recoveryOptions(store, selection, 3),
    ),
    /canonical pending\/terminal state accounts for 2.*no Amazon call/i,
  );
  assert.equal(calls, 0);
  assert.equal((await store.pendingSubmissions()).size, 2);
  await readFile(path.join(root, "coordination", "pending-mutation-fence.json"));
  await assert.rejects(
    readFile(path.join(root, "coordination", "active-execution.lock")),
    /ENOENT/,
  );
});

test("PENDING_SETTLE_ONLY rejects strategy, boundary, and malformed newer evidence before GET", async (t) => {
  const cases: Array<{ label: string; overrides: PendingOverrides }> = [
    { label: "unknown strategy", overrides: { strategy: "UNKNOWN" } },
    {
      label: "gallery MAIN path",
      overrides: {
        evidencePaths: ["/attributes/main_product_image_locator"],
        patchPaths: ["/attributes/main_product_image_locator"],
      },
    },
    {
      label: "malformed newer SHA cannot fall back to legacy SHA",
      overrides: { actualPatchSha: 42 },
    },
    {
      label: "recorded path array cannot discard non-string members",
      overrides: {
        patchPaths: [
          "/attributes/other_product_image_locator_1",
          42,
        ],
      },
    },
    {
      label: "settlement evidence cannot discard non-string members",
      overrides: {
        evidencePaths: [
          "/attributes/other_product_image_locator_1",
          42,
        ],
      },
    },
    {
      label: "SUBMITTED requires exact armed-event lineage",
      overrides: { omitArmedEventId: true },
    },
    {
      label: "SUBMITTED strategy must match its armed event",
      overrides: { armedStrategy: "REVIEWED_FALLBACK" },
    },
    {
      label: "SUBMITTED settlement guard must match its armed event",
      overrides: { armedEvidencePatchSha: "0".repeat(64) },
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.label, async () => {
      const plan = buildMediaPlan();
      const entry = plan.entries[0];
      const root = uniqueRoot(`tamper-${scenario.label}`);
      const store = checkpointStore(root, plan.sha256);
      await appendPending(
        store,
        entry,
        mediaAction(entry),
        listing(entry, BEFORE_GALLERY),
        scenario.overrides,
      );
      let calls = 0;
      await assert.rejects(
        executeRepairPlan(
          plan,
          {
            getListing: async () => {
              calls++;
              return listing(entry, DESIRED_GALLERY);
            },
            patchListing: async () => {
              calls++;
              return {};
            },
          },
          recoveryOptions(store, selectionFor(plan), 3),
        ),
      );
      assert.equal(calls, 0);
      assert.equal((await store.pendingSubmissions()).size, 1);
    });
  }
});

test("PENDING_SETTLE_ONLY keeps stable BEFORE and NON_DESIRED states pending with fence", async (t) => {
  for (const classification of ["BEFORE", "NON_DESIRED"] as const) {
    await t.test(classification, async () => {
      const plan = buildMediaPlan();
      const entry = plan.entries[0];
      const root = uniqueRoot(classification.toLowerCase());
      const store = checkpointStore(root, plan.sha256);
      const before = listing(entry, BEFORE_GALLERY);
      await appendPending(store, entry, mediaAction(entry), before);
      const observed = classification === "BEFORE"
        ? before
        : listing(
            entry,
            BEFORE_GALLERY.map((url) => `${url}?non-desired=1`),
          );
      let patches = 0;
      const result = await executeRepairPlan(
        plan,
        {
          getListing: async () => structuredClone(observed),
          patchListing: async () => {
            patches++;
            return {};
          },
        },
        recoveryOptions(store, selectionFor(plan), 3),
      );
      assert.equal(result.verified_actions, 0);
      assert.equal(result.unresolved_settlements, 1);
      assert.equal(result.stopped_early, true);
      assert.equal(patches, 0);
      assert.equal((await store.pendingSubmissions()).size, 1);
      await readFile(path.join(root, "coordination", "pending-mutation-fence.json"));
    });
  }
});

test("PENDING_SETTLE_ONLY aborts every hung GET and preserves pending/fence", async () => {
  const plan = buildMediaPlan();
  const entry = plan.entries[0];
  const root = uniqueRoot("timeout");
  const store = checkpointStore(root, plan.sha256);
  await appendPending(
    store,
    entry,
    mediaAction(entry),
    listing(entry, BEFORE_GALLERY),
  );
  const signals: AbortSignal[] = [];
  let patches = 0;
  const result = await executeRepairPlan(
    plan,
    {
      getListing: async (_store, _sku, signal) => {
        assert.ok(signal);
        signals.push(signal);
        return new Promise<ListingItem>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
      patchListing: async () => {
        patches++;
        return {};
      },
    },
    recoveryOptions(store, selectionFor(plan), 3, 5),
  );
  assert.equal(signals.length, 3);
  assert.equal(signals.every((signal) => signal.aborted), true);
  assert.equal(patches, 0);
  assert.equal(result.unresolved_settlements, 1);
  assert.equal((await store.pendingSubmissions()).size, 1);
  await readFile(path.join(root, "coordination", "pending-mutation-fence.json"));
});

test("PENDING_SETTLE_ONLY polls multiple pending actions round-robin", async () => {
  const plan = buildMediaPlan([
    ledgerRow("AA-ASAA-AAAA", "B000TEST001"),
    ledgerRow("BB-ASBB-BBBB", "B000TEST002"),
  ]);
  const root = uniqueRoot("round-robin");
  const store = checkpointStore(root, plan.sha256);
  const entries = new Map(plan.entries.map((entry) => [entry.sku, entry]));
  for (const entry of plan.entries) {
    await appendPending(
      store,
      entry,
      mediaAction(entry),
      listing(entry, BEFORE_GALLERY),
    );
  }
  const order: string[] = [];
  let patches = 0;
  const result = await executeRepairPlan(
    plan,
    {
      getListing: async (_store, sku, signal) => {
        assert.ok(signal);
        order.push(sku);
        const entry = entries.get(sku);
        assert.ok(entry);
        return listing(entry, DESIRED_GALLERY);
      },
      patchListing: async () => {
        patches++;
        return {};
      },
    },
    recoveryOptions(store, selectionFor(plan), 3),
  );
  assert.equal(result.verified_actions, 2);
  assert.equal(patches, 0);
  assert.deepEqual(order, [
    "AA-ASAA-AAAA",
    "BB-ASBB-BBBB",
    "AA-ASAA-AAAA",
    "BB-ASBB-BBBB",
    "AA-ASAA-AAAA",
    "BB-ASBB-BBBB",
  ]);
});

test("PENDING_SETTLE_ONLY rejects slot 8 and resets stability when exact path digest changes", async () => {
  const plan = buildMediaPlan();
  const entry = plan.entries[0];
  const root = uniqueRoot("slot8-changing-digest");
  const store = checkpointStore(root, plan.sha256);
  await appendPending(
    store,
    entry,
    mediaAction(entry),
    listing(entry, BEFORE_GALLERY),
  );
  const desiredA = listing(entry, DESIRED_GALLERY);
  const withSlot8 = structuredClone(desiredA);
  (withSlot8.attributes as Record<string, unknown>)
    .other_product_image_locator_8 = [
      {
        marketplace_id: MARKETPLACE_ID,
        media_location:
          "https://m.media-amazon.com/images/I/UNEXPECTED-SLOT-8.jpg",
      },
    ];
  const desiredB = structuredClone(desiredA);
  const slot1 = (desiredB.attributes as Record<string, unknown>)
    .other_product_image_locator_1 as Array<Record<string, unknown>>;
  slot1[0].settlement_digest_probe = "same-visible-url-new-exact-state";
  const observations = [
    desiredA,
    withSlot8,
    desiredA,
    desiredB,
    desiredB,
    desiredB,
  ];
  let reads = 0;
  let patches = 0;
  const result = await executeRepairPlan(
    plan,
    {
      getListing: async () => structuredClone(observations[reads++]),
      patchListing: async () => {
        patches++;
        return {};
      },
    },
    recoveryOptions(store, selectionFor(plan), observations.length),
  );
  assert.equal(result.verified_actions, 1);
  assert.equal(reads, 6);
  assert.equal(patches, 0);
});

test("PENDING_SETTLE_ONLY restart requires 3 fresh DESIRED reads", async () => {
  const plan = buildMediaPlan();
  const entry = plan.entries[0];
  const root = uniqueRoot("restart");
  const store = checkpointStore(root, plan.sha256);
  await appendPending(
    store,
    entry,
    mediaAction(entry),
    listing(entry, BEFORE_GALLERY),
  );
  let firstReads = 0;
  const first = await executeRepairPlan(
    plan,
    {
      getListing: async () => {
        firstReads++;
        if (firstReads === 3) throw new Error("transient read failure");
        return listing(entry, DESIRED_GALLERY);
      },
      patchListing: async () => {
        throw new Error("no PATCH");
      },
    },
    recoveryOptions(store, selectionFor(plan), 3),
  );
  assert.equal(first.verified_actions, 0);
  assert.equal((await store.pendingSubmissions()).size, 1);

  let restartReads = 0;
  const second = await executeRepairPlan(
    plan,
    {
      getListing: async () => {
        restartReads++;
        return listing(entry, DESIRED_GALLERY);
      },
      patchListing: async () => {
        throw new Error("no PATCH");
      },
    },
    recoveryOptions(store, selectionFor(plan), 3),
  );
  assert.equal(second.verified_actions, 1);
  assert.equal(restartReads, 3);
});

test("PENDING_SETTLE_ONLY always releases lease and preserves fence when any global journal is pending", async () => {
  const currentPlan = buildMediaPlan();
  const otherPlan = buildMediaPlan([
    ledgerRow("ZZ-ASZZ-ZZZZ", "B000TEST999"),
  ]);
  const root = uniqueRoot("global-pending");
  const currentStore = checkpointStore(root, currentPlan.sha256);
  const otherStore = checkpointStore(root, otherPlan.sha256);
  const currentEntry = currentPlan.entries[0];
  const otherEntry = otherPlan.entries[0];
  await appendPending(
    currentStore,
    currentEntry,
    mediaAction(currentEntry),
    listing(currentEntry, BEFORE_GALLERY),
  );
  await appendPending(
    otherStore,
    otherEntry,
    mediaAction(otherEntry),
    listing(otherEntry, BEFORE_GALLERY),
  );
  const result = await executeRepairPlan(
    currentPlan,
    {
      getListing: async () => listing(currentEntry, DESIRED_GALLERY),
      patchListing: async () => {
        throw new Error("no PATCH");
      },
    },
    recoveryOptions(currentStore, selectionFor(currentPlan), 3),
  );
  assert.equal(result.verified_actions, 1);
  assert.equal((await currentStore.pendingSubmissions()).size, 0);
  assert.equal((await otherStore.pendingSubmissions()).size, 1);
  await readFile(path.join(root, "coordination", "pending-mutation-fence.json"));
  await assert.rejects(
    readFile(path.join(root, "coordination", "active-execution.lock")),
    /ENOENT/,
  );
});

test("PENDING_SETTLE_ONLY refuses an active execution lease before GET", async () => {
  const plan = buildMediaPlan();
  const entry = plan.entries[0];
  const root = uniqueRoot("active-lease");
  const store = checkpointStore(root, plan.sha256);
  await appendPending(
    store,
    entry,
    mediaAction(entry),
    listing(entry, BEFORE_GALLERY),
  );
  const release = await store.acquireExecutionLease("TEST_ACTIVE_OWNER");
  let calls = 0;
  await assert.rejects(
    executeRepairPlan(
      plan,
      {
        getListing: async () => {
          calls++;
          return listing(entry, DESIRED_GALLERY);
        },
        patchListing: async () => {
          calls++;
          return {};
        },
      },
      recoveryOptions(store, selectionFor(plan), 3),
    ),
    /execution lease already exists/i,
  );
  assert.equal(calls, 0);
  await release();
});

test("PENDING_SETTLE_ONLY current AZ plan/selection/submission shape is accepted entirely offline", async () => {
  const planPath =
    "data/repairs/generated/uncrustables-amazon-final-162-20260718-v8/URP-20260718T083203612Z-8badb989fc9b.json";
  const selectionPath =
    "data/repairs/execution-selections/uncrustables-gallery-media-remaining-118-20260718-v1/batch-01-canary-az/URES-20260718T125000000Z-9da5ddee4b99.json";
  const armedPath =
    "data/repairs/checkpoints/8badb989fc9bc5ee9c7c/20260718T130711570Z-AZ-ASMY-VEQ2_media-SUBMISSION_ARMED-911f6115-9f8c-4a26-b6f9-2fdcc40f7c17.json";
  const submittedPath =
    "data/repairs/checkpoints/8badb989fc9bc5ee9c7c/20260718T130711913Z-AZ-ASMY-VEQ2_media-SUBMITTED-5bb1992e-17aa-4bfd-86c7-5e0d15a376b6.json";
  const plan = await readRepairPlan(planPath);
  const selection = await readRepairExecutionSelection(selectionPath, plan);
  const entry = plan.entries.find((candidate) => candidate.sku === "AZ-ASMY-VEQ2");
  assert.ok(entry);
  const action = mediaAction(entry);
  const armedFixture = JSON.parse(await readFile(armedPath, "utf8")) as CheckpointEvent;
  const submittedFixture = JSON.parse(
    await readFile(submittedPath, "utf8"),
  ) as CheckpointEvent;
  const root = uniqueRoot("current-az");
  const store = checkpointStore(root, plan.sha256);
  const armed = await store.append({
    action_id: action.action_id,
    sku: entry.sku,
    kind: action.kind,
    status: "SUBMISSION_ARMED",
    detail: structuredClone(armedFixture.detail),
  });
  await store.append({
    action_id: action.action_id,
    sku: entry.sku,
    kind: action.kind,
    status: "SUBMITTED",
    detail: {
      ...structuredClone(submittedFixture.detail),
      armed_event_id: armed.event_id,
    },
  });
  assert.ok(action.desired.kind === "MEDIA");
  const desiredAttributes: Record<string, unknown> = {};
  for (const item of action.desired.value.gallery_slots) {
    desiredAttributes[`other_product_image_locator_${item.slot}`] = [
      { marketplace_id: MARKETPLACE_ID, media_location: item.url },
    ];
  }
  const desired: ListingItem = {
    sku: entry.sku,
    summaries: [
      {
        marketplaceId: MARKETPLACE_ID,
        asin: entry.asin,
        productType: "GROCERY",
      },
    ],
    attributes: desiredAttributes,
  };
  let patches = 0;
  const result = await executeRepairPlan(
    plan,
    {
      getListing: async (_store, _sku, signal) => {
        assert.ok(signal);
        return structuredClone(desired);
      },
      patchListing: async () => {
        patches++;
        return {};
      },
    },
    recoveryOptions(store, selection, 3),
  );
  assert.equal(result.verified_actions, 1);
  assert.equal(result.selection_sha256, selection.sha256);
  assert.equal(patches, 0);
});

test("PENDING_SETTLE_ONLY accepts the current QX OFFER surrogate lineage and never PATCHes", async () => {
  const planPath =
    "data/repairs/generated/uncrustables-amazon-final-162-20260718-v8/URP-20260718T083203612Z-8badb989fc9b.json";
  const selectionPath =
    "data/repairs/execution-selections/uncrustables-offer-canary-qx-20260718-v1/URES-20260718T150721047Z-b249fc715064.json";
  const armedPath =
    "data/repairs/checkpoints/8badb989fc9bc5ee9c7c/20260718T151330175Z-QX-AS89-H8YC_offer-SUBMISSION_ARMED-704900c2-dad7-4c0f-9353-e01160eb1430.json";
  const submittedPath =
    "data/repairs/checkpoints/8badb989fc9bc5ee9c7c/20260718T151330520Z-QX-AS89-H8YC_offer-SUBMITTED-f349faa9-366c-4dea-a9f1-678906ded957.json";
  const snapshotPath =
    "data/repairs/rollback/offer-canary-qx-v1-preapply-20260718T1511Z/UAPS-20260718T151233207Z-46a80e727880-8096129d8101.json";
  const plan = await readRepairPlan(planPath);
  const selection = await readRepairExecutionSelection(selectionPath, plan);
  const entry = plan.entries.find((candidate) => candidate.sku === "QX-AS89-H8YC");
  assert.ok(entry);
  const action = entry.actions.find((candidate) => candidate.kind === "OFFER");
  assert.ok(action);
  const armedFixture = JSON.parse(await readFile(armedPath, "utf8")) as CheckpointEvent;
  const submittedFixture = JSON.parse(
    await readFile(submittedPath, "utf8"),
  ) as CheckpointEvent;
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
    entries: Array<{ sku: string; listing: ListingItem }>;
  };
  const before = snapshot.entries.find((candidate) => candidate.sku === entry.sku);
  assert.ok(before);
  const root = uniqueRoot("current-qx-offer");
  const store = checkpointStore(root, plan.sha256);
  const armed = await store.append({
    action_id: action.action_id,
    sku: entry.sku,
    kind: action.kind,
    status: "SUBMISSION_ARMED",
    detail: structuredClone(armedFixture.detail),
  });
  await store.append({
    action_id: action.action_id,
    sku: entry.sku,
    kind: action.kind,
    status: "SUBMITTED",
    detail: {
      ...structuredClone(submittedFixture.detail),
      armed_event_id: armed.event_id,
    },
  });
  let gets = 0;
  let patches = 0;
  const result = await executeRepairPlan(
    plan,
    {
      getListing: async (_store, _sku, signal) => {
        assert.ok(signal);
        gets++;
        return structuredClone(before.listing);
      },
      patchListing: async () => {
        patches++;
        return {};
      },
    },
    recoveryOptions(store, selection, 3),
  );
  assert.equal(result.unresolved_settlements, 1);
  assert.equal(gets, 3);
  assert.equal(patches, 0);
});
