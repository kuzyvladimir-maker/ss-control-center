// npx tsx --test src/lib/bundle-factory/__tests__/uncrustables-main-submit-only.test.ts

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import type { ListingItem } from "@/lib/amazon-sp-api/listings";
import {
  GALLERY_MEDIA_ONLY_PROFILE,
  ImmutableCheckpointStore,
  MAIN_MEDIA_ONLY_PROFILE,
  VERIFIED_BRAND_CARD_REHOST_URL,
  buildRepairPlan,
  executeRepairPlan,
  repairExecutionSelection,
  sha256,
  type RepairAmazonGateway,
  type UncrustablesRepairPlan,
} from "../repair/uncrustables-surgical";

function uniqueRoot(label: string): string {
  return path.join(
    tmpdir(),
    `uncr-main-submit-only-${label}-${Date.now()}-${Math.random()}`,
  );
}

function store(root: string, plan: UncrustablesRepairPlan) {
  return new ImmutableCheckpointStore(
    root,
    plan.sha256,
    path.join(root, "coordination"),
  );
}

function ledgerRow(index: number) {
  const code = String(index).padStart(4, "0");
  return {
    sku: `MAIN-AS-${code}`,
    asin: `B0${String(index).padStart(8, "0")}`,
    store_index: 1,
    canonical: {
      total_units: 24,
      components: [{
        product_id: "grape",
        product_name:
          "Smucker's Uncrustables Peanut Butter & Grape Jelly Sandwich",
        brand: "Uncrustables",
        flavor: "Peanut Butter & Grape Jelly",
        qty: 24,
        unit_price_cents: 100,
      }],
      pricing: { suggested: 76.99, floor: 66.95 },
    },
    db: {
      draft: {
        brand: "Uncrustables",
        pack_count: 24,
        selected_variant: {
          name: "Grape 24",
          composition: [{
            product_id: "grape",
            product_name:
              "Smucker's Uncrustables Peanut Butter & Grape Jelly Sandwich",
            brand: "Uncrustables",
            flavor: "Peanut Butter & Grape Jelly",
            qty: 24,
            unit_price_cents: 100,
          }],
        },
      },
    },
    live: {
      fetched: true,
      error: null,
      product_type: "GROCERY",
      title:
        "Uncrustables Peanut Butter & Grape Jelly Sandwiches, 24 Count",
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
      gallery_image_urls: [] as string[],
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

function ledgerBytes(rows: ReturnType<typeof ledgerRow>[]): Buffer {
  return Buffer.from(JSON.stringify({
    schema_version: "uncrustables-ledger/v1.2",
    audit_id: "UL-MAIN-SUBMIT-ONLY-TEST",
    complete: true,
    immutable: true,
    mode: "live",
    external_mutations: false,
    completed_at: "2026-07-19T05:00:00.000Z",
    rows,
  }));
}

function buildMainPlan(count: number): UncrustablesRepairPlan {
  const rows = Array.from({ length: count }, (_, index) => ledgerRow(index + 1));
  const ledger = ledgerBytes(rows);
  return buildRepairPlan({
    ledgerPath: "/tmp/uncr-main-submit-only-ledger.json",
    ledgerBytes: ledger,
    manifest: {
      schema_version: "uncrustables-surgical-desired/v1",
      source_ledger_sha256: sha256(ledger),
      repairs: rows.map((row, index) => ({
        sku: row.sku,
        media: {
          main_image_url:
            `https://assets.example.com/uncrustables/main-${index + 1}.png`,
        },
      })),
    },
    createdAt: new Date("2026-07-19T05:00:00.000Z"),
  });
}

function beforeMainListing(
  plan: UncrustablesRepairPlan,
  sku: string,
): ListingItem {
  const entry = plan.entries.find((candidate) => candidate.sku === sku);
  assert.ok(entry);
  return {
    sku,
    summaries: [{
      marketplaceId: MARKETPLACE_ID,
      asin: entry.asin,
      productType: "GROCERY",
      itemName: "Uncrustables test listing",
      mainImage: {
        link: `https://m.media-amazon.com/images/I/BEFORE-${sku}.jpg`,
      },
    }],
    attributes: {
      main_product_image_locator: [{
        marketplace_id: MARKETPLACE_ID,
        media_location:
          `https://m.media-amazon.com/images/I/BEFORE-${sku}.jpg`,
      }],
    },
  };
}

test("MAIN_MEDIA_ONLY submit-only sends a 20-action wave once, persists SUBMITTED, and performs no same-action post-write GET", async () => {
  const plan = buildMainPlan(20);
  const selection = repairExecutionSelection(plan, {
    sourcePlanPath: "/tmp/uncr-main-submit-only-plan.json",
    createdAt: new Date("2026-07-19T05:01:00.000Z"),
    actionKinds: ["MEDIA"],
  });
  assert.equal(selection.profile, MAIN_MEDIA_ONLY_PROFILE);
  assert.equal(selection.selected_actions, 20);

  const root = uniqueRoot("wave-20");
  const checkpointStore = store(root, plan);
  const events = new Map<string, string[]>();
  let previewCalls = 0;
  let writeCalls = 0;
  let physicalGuards = 0;
  const record = (sku: string, event: string) => {
    const current = events.get(sku) ?? [];
    current.push(event);
    events.set(sku, current);
  };
  const gateway: RepairAmazonGateway = {
    physicalMutationGuardContract: "CALL_IMMEDIATELY_BEFORE_REQUEST_V1",
    getListing: async (_storeIndex, sku) => {
      record(sku, "GET");
      return structuredClone(beforeMainListing(plan, sku));
    },
    patchListing: async (
      storeIndex,
      sku,
      _productType,
      _patches,
      validationPreview,
      _previewContext,
      beforeMutatingRequest,
    ) => {
      if (validationPreview) {
        previewCalls++;
        record(sku, "PREVIEW");
        return { status: "VALID", issues: [] };
      }
      writeCalls++;
      record(sku, "PATCH");
      beforeMutatingRequest?.({
        store_index: storeIndex,
        marketplace_id: MARKETPLACE_ID,
        amazon_merchant_id: "TEST-MERCHANT",
      });
      physicalGuards++;
      return { status: "ACCEPTED", issues: [] };
    },
  };

  const result = await executeRepairPlan(plan, gateway, {
    apply: true,
    executionPhase: "SUBMIT_ONLY",
    confirmation: selection.confirmation_token,
    checkpointStore,
    executionSelection: selection,
    requestDelayMs: 200,
    sleep: async () => {},
  });

  assert.equal(result.mode, "MEDIA_SUBMIT_ONLY");
  assert.equal(result.selected_actions, 20);
  assert.equal(result.submitted_actions, 20);
  assert.equal(result.verified_actions, 0);
  assert.equal(result.failed_actions, 0);
  assert.equal(previewCalls, 20);
  assert.equal(writeCalls, 20);
  assert.equal(physicalGuards, 20);
  for (const entry of plan.entries) {
    const skuEvents = events.get(entry.sku) ?? [];
    assert.deepEqual(skuEvents, ["GET", "PREVIEW", "GET", "GET", "PATCH"]);
    assert.equal(skuEvents.slice(skuEvents.lastIndexOf("PATCH") + 1).includes("GET"), false);
  }
  const pending = await checkpointStore.pendingSubmissions();
  assert.equal(pending.size, 20);
  assert.equal(
    [...pending.values()].every(
      (submission) =>
        submission.kind === "MEDIA" && submission.source_status === "SUBMITTED",
    ),
    true,
  );

  let restartCalls = 0;
  const restartGateway: RepairAmazonGateway = {
    getListing: async () => {
      restartCalls++;
      throw new Error("restart must fail before Amazon GET");
    },
    patchListing: async () => {
      restartCalls++;
      throw new Error("restart must fail before Amazon PATCH");
    },
  };
  await assert.rejects(
    executeRepairPlan(plan, restartGateway, {
      apply: true,
      executionPhase: "SUBMIT_ONLY",
      confirmation: selection.confirmation_token,
      checkpointStore,
      executionSelection: selection,
      requestDelayMs: 200,
      sleep: async () => {},
    }),
    /blocked by persistent pending action/,
  );
  assert.equal(restartCalls, 0);
  assert.equal((await checkpointStore.pendingSubmissions()).size, 20);
});

test("submit-only rejects a gallery MEDIA selection before every Amazon call", async () => {
  const row = ledgerRow(1);
  row.live.gallery_image_urls = [
    "https://m.media-amazon.com/images/I/WRONG-GALLERY.jpg",
  ];
  const ledger = ledgerBytes([row]);
  const plan = buildRepairPlan({
    ledgerPath: "/tmp/uncr-gallery-submit-only-ledger.json",
    ledgerBytes: ledger,
    manifest: {
      schema_version: "uncrustables-surgical-desired/v1",
      source_ledger_sha256: sha256(ledger),
      repairs: [{
        sku: row.sku,
        media: {
          gallery_image_urls: [
            VERIFIED_BRAND_CARD_REHOST_URL,
            "https://m.media-amazon.com/images/I/PRODUCT-1.jpg",
            "https://m.media-amazon.com/images/I/PRODUCT-2.jpg",
            "https://m.media-amazon.com/images/I/PRODUCT-3.jpg",
            "https://m.media-amazon.com/images/I/PRODUCT-4.jpg",
          ],
        },
      }],
    },
    createdAt: new Date("2026-07-19T05:02:00.000Z"),
  });
  const selection = repairExecutionSelection(plan, {
    sourcePlanPath: "/tmp/uncr-gallery-submit-only-plan.json",
    createdAt: new Date("2026-07-19T05:03:00.000Z"),
    actionKinds: ["MEDIA"],
  });
  assert.equal(selection.profile, GALLERY_MEDIA_ONLY_PROFILE);

  let gatewayCalls = 0;
  const gateway: RepairAmazonGateway = {
    getListing: async () => {
      gatewayCalls++;
      throw new Error("gallery submit-only must not GET");
    },
    patchListing: async () => {
      gatewayCalls++;
      throw new Error("gallery submit-only must not PATCH");
    },
  };
  await assert.rejects(
    executeRepairPlan(plan, gateway, {
      apply: true,
      executionPhase: "SUBMIT_ONLY",
      confirmation: selection.confirmation_token,
      checkpointStore: store(uniqueRoot("gallery-forbidden"), plan),
      executionSelection: selection,
      requestDelayMs: 200,
      sleep: async () => {},
    }),
    /SUBMIT_ONLY forbids profile GALLERY_MEDIA_ONLY_V1/,
  );
  assert.equal(gatewayCalls, 0);
});
