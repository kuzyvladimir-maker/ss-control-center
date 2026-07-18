// npx tsx --test src/lib/bundle-factory/__tests__/uncrustables-surgical.test.ts

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import type { ListingItem, ListingPatch } from "@/lib/amazon-sp-api/listings";
import { priceSchedule } from "@/lib/amazon-sp-api/pricing";
import { BRAND_CARD_COLD_CHAIN_URL } from "@/lib/bundle-factory/attributes/brand-assets";
import { priceFor } from "@/lib/pricing/cost-model";
import {
  applyPurchasableOfferMerge,
  ImmutableCheckpointStore,
  KNOWN_WRONG_SLOT_1_URL,
  SELECTOR_REPLACE_SURROGATE_FOR_MERGE,
  VERIFIED_BRAND_CARD_REHOST_URL,
  assertValidationPreviewSurrogateMatches,
  buildActionPatches,
  buildRepairPlan,
  buildValidationPreviewPatchSet,
  confirmationToken,
  executeRepairPlan,
  mergeCanonicalPurchasableOffer,
  sha256,
  stableJson,
  verifyRepairPlan,
  verifyActionState,
  writeImmutableChannelMaxArtifact,
  type DesiredOfferRepair,
  type DesiredRepairManifest,
  type RepairAmazonGateway,
  type UncrustablesRepairPlan,
} from "../repair/uncrustables-surgical";

function ledgerRow(overrides: Record<string, unknown> = {}) {
  return {
    sku: "AA-ASAA-AAAA",
    asin: "B000TEST001",
    store_index: 1,
    canonical: {
      total_units: 24,
      components: [
        {
          product_id: "grape",
          product_name: "Smucker's Uncrustables Peanut Butter & Grape Jelly Sandwich",
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
              product_name: "Smucker's Uncrustables Peanut Butter & Grape Jelly Sandwich",
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
      description: "This listing contains 24 peanut butter and grape jelly sandwiches.",
      brand: "Uncrustables",
      gallery_image_urls: [VERIFIED_BRAND_CARD_REHOST_URL],
      consumer_offer: {
        our_price: 76.99,
        minimum_seller_allowed_price: 66.95,
        maximum_seller_allowed_price: 76.99,
      },
      raw_offers: [
        { offerType: "B2C", price: { amount: "76.99" }, audience: { value: "ALL" } },
        { offerType: "B2B", price: { amount: "76.22" }, audience: { value: "B2B" } },
      ],
    },
    anomalies: [],
    ...overrides,
  };
}

function ledgerBytes(rows = [ledgerRow()]): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version: "uncrustables-ledger/v1.2",
      audit_id: "UL-TEST",
      complete: true,
      immutable: true,
      mode: "live",
      external_mutations: false,
      completed_at: "2026-07-17T00:00:00.000Z",
      rows,
    }),
  );
}

function build(rows = [ledgerRow()]): UncrustablesRepairPlan {
  const bytes = ledgerBytes(rows);
  return buildRepairPlan({
    ledgerPath: "/tmp/ledger.json",
    ledgerBytes: bytes,
    createdAt: new Date("2026-07-17T00:00:00.000Z"),
  });
}

const desiredOffer: DesiredOfferRepair = {
  currency: "USD",
  consumer_price: 76.99,
  business_price: 76.99,
  minimum_seller_allowed_price: 66.95,
  maximum_seller_allowed_price: 76.99,
  discounted_price_absent: true,
  list_price_absent: true,
};

test("plan repairs B2B drift and only the known wrong slot-1 image", () => {
  const row = ledgerRow();
  const plan = build([row]);
  assert.deepEqual(plan.entries[0].actions.map((action) => action.kind), ["OFFER"]);
  assert.equal(plan.semantic_audit.passed, 1);

  const wrong = structuredClone(row);
  wrong.live.gallery_image_urls = [KNOWN_WRONG_SLOT_1_URL];
  const mediaPlan = build([wrong]);
  assert.deepEqual(mediaPlan.entries[0].actions.map((action) => action.kind), ["MEDIA", "OFFER"]);
  const media = mediaPlan.entries[0].actions[0];
  assert.equal(media.desired.kind, "MEDIA");
  if (media.desired.kind === "MEDIA") {
    assert.deepEqual(media.desired.value.gallery_slots, [
      {
        slot: 1,
        url: "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/prod/brand/salutem-brand-card-v1.png",
      },
    ]);
  }
});

test("sealed legacy action order is rejected before execution", () => {
  const row = ledgerRow();
  row.live.gallery_image_urls = [KNOWN_WRONG_SLOT_1_URL];
  const plan = build([row]);
  const { sha256: _oldSha, ...body } = structuredClone(plan);
  body.entries[0].actions.reverse();
  const reordered: UncrustablesRepairPlan = {
    ...body,
    sha256: sha256(stableJson(body)),
  };
  assert.throws(
    () => verifyRepairPlan(reordered),
    /Unsafe repair action order/,
  );
});

test("explicit galleries accept only the two verified card locators and carry exact tail deletions", () => {
  const row = ledgerRow();
  const bytes = ledgerBytes([row]);
  const productUrls = Array.from(
    { length: 4 },
    (_, index) => `https://assets.example.com/exact-product-${index + 1}.jpg`,
  );
  const manifestFor = (cardUrl: string): DesiredRepairManifest => ({
    schema_version: "uncrustables-surgical-desired/v1",
    source_ledger_sha256: sha256(bytes),
    repairs: [
      {
        sku: row.sku,
        media: {
          gallery_image_urls: [cardUrl, ...productUrls],
          delete_gallery_slots: [6, 7, 8],
        },
      },
    ],
  });

  for (const cardUrl of [
    BRAND_CARD_COLD_CHAIN_URL,
    VERIFIED_BRAND_CARD_REHOST_URL,
  ]) {
    const plan = buildRepairPlan({
      ledgerPath: "/tmp/ledger.json",
      ledgerBytes: bytes,
      manifest: manifestFor(cardUrl),
      createdAt: new Date("2026-07-18T00:00:00.000Z"),
    });
    const action = plan.entries[0].actions.find(
      (candidate) => candidate.kind === "MEDIA",
    );
    assert.ok(action && action.desired.kind === "MEDIA");
    assert.deepEqual(action.desired.value.gallery_slots, [cardUrl, ...productUrls].map(
      (url, index) => ({ slot: index + 1, url }),
    ));
    assert.deepEqual(action.desired.value.delete_gallery_slots, [6, 7, 8]);

    const patches = buildActionPatches(
      action,
      {
        attributes: Object.fromEntries(
          Array.from({ length: 8 }, (_, index) => [
            `other_product_image_locator_${index + 1}`,
            [{
              media_location: `https://legacy.example.com/${index + 1}.jpg`,
              marketplace_id: MARKETPLACE_ID,
            }],
          ]),
        ),
      } as unknown as ListingItem,
    );
    assert.deepEqual(
      patches.map((patch) => ({ op: patch.op, path: patch.path })),
      [
        ...Array.from({ length: 5 }, (_, index) => ({
          op: "replace" as const,
          path: `/attributes/other_product_image_locator_${index + 1}`,
        })),
        ...[6, 7, 8].map((slot) => ({
          op: "delete" as const,
          path: `/attributes/other_product_image_locator_${slot}`,
        })),
      ],
    );
    assert.deepEqual(
      patches.slice(-3).map((patch) => patch.value),
      Array.from({ length: 3 }, () => [
        { marketplace_id: MARKETPLACE_ID },
      ]),
    );
  }

  assert.throws(
    () => buildRepairPlan({
      ledgerPath: "/tmp/ledger.json",
      ledgerBytes: bytes,
      manifest: manifestFor("https://m.media-amazon.com/images/I/lookalike.jpg"),
    }),
    /two byte-verified fixed brand-card locators/,
  );
  const incompleteTail = manifestFor(VERIFIED_BRAND_CARD_REHOST_URL);
  incompleteTail.repairs[0].media!.delete_gallery_slots = [6, 7];
  assert.throws(
    () => buildRepairPlan({
      ledgerPath: "/tmp/ledger.json",
      ledgerBytes: bytes,
      manifest: incompleteTail,
    }),
    /exact ordered tail \[6,7,8\]/,
  );
});

test("semantic failure gets deterministic recipe copy and exact count attributes", () => {
  const row = ledgerRow();
  row.live.title = "Uncrustables Grape, 4 ct - Pack of 6 (24 Total)";
  row.live.bullets = [
    "Six boxes contain four sandwiches each.",
    "Keep frozen.",
    "Individually wrapped.",
    "Follow wrapper directions.",
    "Grape jelly flavor.",
  ];
  row.live.description = "Six retail boxes total 24 sandwiches.";
  const plan = build([row]);
  assert.equal(plan.semantic_audit.failed, 1);
  assert.equal(plan.semantic_audit.repaired_deterministically, 1);
  assert.equal(plan.semantic_audit.blocked, 0);
  const text = plan.entries[0].actions.find((action) => action.kind === "TEXT_COUNT");
  assert.ok(text);
  assert.equal(text.desired.kind, "TEXT_COUNT");
  if (text.desired.kind === "TEXT_COUNT") {
    assert.equal(text.desired.value.unit_count, 24);
    assert.equal(text.desired.value.number_of_items, 24);
    assert.equal(text.desired.value.bullets?.length, 5);
    assert.doesNotMatch(text.desired.value.title ?? "", /pack of|4\s*ct/i);
  }
});

test("an exact 1536px style-approved hero still cannot enter a repair plan", () => {
  const row = ledgerRow();
  row.sku = "PB-ASAF-G2T6";
  row.asin = "B0H82K7Y7S";
  row.canonical.components[0] = {
    product_id: "peanut-butter",
    product_name: "Smucker's Uncrustables Frozen Peanut Butter Sandwich - 7.2oz/4ct",
    brand: "Uncrustables",
    flavor: "Peanut Butter",
    qty: 24,
    unit_price_cents: 100,
  };
  row.db.draft.selected_variant.composition[0] = structuredClone(
    row.canonical.components[0],
  );
  const bytes = ledgerBytes([row]);
  const hero = {
    schema_version: "uncrustables-hero-generation-manifest/v1.0",
    immutable: true,
    external_mutations: { r2_asset_uploads: 1, amazon_calls: 0, database_writes: 0 },
    run_id: "UHG-TEST",
    // Hero provenance can point at an older immutable resummary. Exact selected
    // SKU/ASIN matching and the sealed manifest SHA are the safety boundary.
    source_snapshot: { path: "/tmp/older-ledger.json", sha256: "b".repeat(64) },
    summary: { target: 1, succeeded: 1, failed: 0 },
    rows: [
      {
        sku: "PB-ASAF-G2T6",
        asin: "B0H82K7Y7S",
        status: "SUCCEEDED",
        gallery_image_urls: [1, 2, 3, 4].map(
          (index) => `https://assets.example.com/product-${index}.jpg`,
        ),
        result: {
          ok: true,
          image_url: "https://verified-assets.r2.dev/main-a.png",
          image_sha256:
            "4cdd7bec9ab5c1d5f97b5746d7569a4ffc891a36b8d1fb159168176f06e19076",
          total_units: 24,
          plan: [{ recipe_qty: 24, source_reviewed: true }],
          qa: { pass: true, verified: true },
          gallery_qa: { pass: true, verified: true },
        },
      },
    ],
  };
  assert.throws(
    () =>
      buildRepairPlan({
        ledgerPath: "/tmp/ledger.json",
        ledgerBytes: bytes,
        heroManifest: {
          path: "/tmp/heroes.json",
          bytes: Buffer.from(JSON.stringify(hero)),
        },
        createdAt: new Date("2026-07-17T00:00:00.000Z"),
      }),
    /APPROVAL_NOT_PRODUCTION_ELIGIBLE/,
  );
});

test("verified gallery manifest must match the exact current repair-ledger SHA", () => {
  const bytes = ledgerBytes();
  const hero = {
    schema_version: "uncrustables-hero-generation-manifest/v1.0",
    immutable: true,
    external_mutations: { r2_asset_uploads: 1, amazon_calls: 0, database_writes: 0 },
    run_id: "UHG-GALLERY-SHA-TEST",
    source_snapshot: { path: "/tmp/older-ledger.json", sha256: "b".repeat(64) },
    summary: { target: 1, succeeded: 1, failed: 0 },
    rows: [
      {
        sku: "AA-ASAA-AAAA",
        asin: "B000TEST001",
        status: "SUCCEEDED",
        result: {
          ok: true,
          image_url: "https://verified-assets.r2.dev/main-a.png",
          image_sha256: "a".repeat(64),
          total_units: 24,
          plan: [{ recipe_qty: 24, source_reviewed: true }],
          qa: { pass: true, verified: true },
        },
      },
    ],
  };
  const gallery = {
    schema_version: "uncrustables-product-gallery-manifest/v1.0",
    immutable: true,
    source_ledger_sha256: "c".repeat(64),
    summary: { target: 1, passed: 1, failed: 0 },
    rows: [
      {
        sku: "AA-ASAA-AAAA",
        asin: "B000TEST001",
        verified: true,
        image_urls: [1, 2, 3, 4].map(
          (index) => `https://assets.example.com/product-${index}.jpg`,
        ),
        evidence: [] as string[],
        assets: [] as Array<Record<string, unknown>>,
      },
    ],
  };
  const buildWithGallery = () => buildRepairPlan({
    ledgerPath: "/tmp/ledger.json",
    ledgerBytes: bytes,
    heroManifest: {
      path: "/tmp/heroes.json",
      bytes: Buffer.from(JSON.stringify(hero)),
    },
    galleryManifest: {
      path: "/tmp/gallery.json",
      bytes: Buffer.from(JSON.stringify(gallery)),
    },
    createdAt: new Date("2026-07-17T00:00:00.000Z"),
  });

  assert.throws(buildWithGallery, /exact repair ledger SHA-256/);
  gallery.source_ledger_sha256 = sha256(bytes);
  assert.throws(buildWithGallery, /one structured asset and evidence row per URL/);

  gallery.rows[0].assets = gallery.rows[0].image_urls.map((r2Url, index) => ({
    donor_id: `donor-${index}`,
    donor_title:
      "Smucker's Uncrustables Frozen Peanut Butter & Strawberry Jam Sandwich - 8oz/4ct",
    flavor: "Smucker's Uncrustables Peanut Butter & Grape Jelly Sandwich",
    source_url: `https://images.example.com/source-${index}.jpg`,
    source_sha256: String(index + 1).padStart(64, "0"),
    asset_sha256: String(index + 11).padStart(64, "0"),
    dimensions: { width: 2000, height: 2000 },
    r2_key: `uncrustables-product-gallery/v1/00/${String(index + 11).padStart(64, "0")}.jpg`,
    r2_url: r2Url,
  }));
  gallery.rows[0].evidence = gallery.rows[0].image_urls.map(() => "mismatched");
  assert.throws(buildWithGallery, /donor\/title mismatch/);
});

test("offer merge removes legacy sale price, preserves metadata, and updates ALL plus B2B", () => {
  const discounted = [{ schedule: [{ value_with_tax: 66.98, start_at: "2026-07-14" }] }];
  const quantityDiscounts = [{ quantity_tier: 3, value: 2 }];
  const existing = [
    {
      audience: "ALL",
      currency: "USD",
      our_price: priceSchedule(70),
      discounted_price: discounted,
      quantity_discounts: quantityDiscounts,
      custom_metadata: { keep: true },
      minimum_seller_allowed_price: priceSchedule(60),
      maximum_seller_allowed_price: priceSchedule(80),
    },
    {
      audience: "B2B",
      currency: "USD",
      our_price: priceSchedule(69.3),
      quantity_discounts: [{ quantity_tier: 10, value: 5 }],
      custom_b2b_metadata: "keep",
    },
    { audience: "SOME_FUTURE_AUDIENCE", untouched: true },
  ];
  const merged = mergeCanonicalPurchasableOffer(existing, desiredOffer);
  assert.equal(merged[0].discounted_price, undefined);
  assert.deepEqual(merged[0].quantity_discounts, quantityDiscounts);
  assert.deepEqual(merged[0].custom_metadata, { keep: true });
  assert.deepEqual(merged[1].quantity_discounts, [{ quantity_tier: 10, value: 5 }]);
  assert.equal(merged[1].custom_b2b_metadata, "keep");
  assert.deepEqual(merged[2], existing[2]);
  assert.equal(
    ((merged[0].our_price as ReturnType<typeof priceSchedule>)[0].schedule[0]).value_with_tax,
    76.99,
  );
  assert.equal(
    ((merged[1].our_price as ReturnType<typeof priceSchedule>)[0].schedule[0]).value_with_tax,
    76.99,
  );

});

test("offer patch uses selector merge and creates desired B2B when attributes omit it", async () => {
  const live = liveListing();
  const attrs = live.attributes as Record<string, unknown>;
  attrs.purchasable_offer = (
    attrs.purchasable_offer as Array<Record<string, unknown>>
  ).filter((entry) => entry.audience !== "B2B");
  delete attrs.business_price;
  const action = build().entries[0].actions.find(
    (candidate) => candidate.kind === "OFFER",
  );
  assert.ok(action);
  const patches = buildActionPatches(action, live);
  const offer = patches.find(
    (patch) => patch.path === "/attributes/purchasable_offer",
  );
  assert.ok(offer);
  assert.equal(offer.op, "merge");
  const submitted = offer.value as Array<Record<string, unknown>>;
  assert.deepEqual(
    submitted.map((entry) => entry.audience),
    ["ALL", "B2B"],
  );
  assert.equal(
    submitted.some(
      (entry) =>
        entry.audience === "B2B" &&
        entry.quantity_discounts !== undefined,
    ),
    false,
    "narrow B2B merge must not overwrite unreturned quantity discounts",
  );
  const after: ListingItem = {
    ...live,
    attributes: {
      ...live.attributes,
      // Mirror production: attributes still omit B2B after ingest.
      purchasable_offer: applyPurchasableOfferMerge(
        attrs.purchasable_offer,
        offer.value,
      ).filter((entry) => entry.audience !== "B2B"),
    },
    offers: [
      {
        offerType: "B2B",
        audience: { value: "B2B" },
        price: { amount: "76.99", currency: "USD" },
      },
    ],
  };
  delete (after.attributes as Record<string, unknown>).list_price;
  const verification = await verifyActionState(action, after);
  assert.equal(verification.ok, true);
});

test("OFFER preview uses a selector-replace surrogate while retaining the sealed merge", () => {
  const live = liveListing();
  const action = build().entries[0].actions.find(
    (candidate) => candidate.kind === "OFFER",
  );
  assert.ok(action);
  const actual = buildActionPatches(action, live);
  const set = buildValidationPreviewPatchSet(actual, action.kind);
  assert.equal(set.strategy, SELECTOR_REPLACE_SURROGATE_FOR_MERGE);
  assert.equal(set.actual_merge_patch?.op, "merge");
  assert.equal(set.preview_surrogate_patch?.op, "replace");
  assert.deepEqual(set.omitted_null_members, ["ALL.discounted_price"]);
  assert.deepEqual(set.actual_patches, actual);
  const previewOffer = set.preview_patches.find(
    (patch) => patch.path === "/attributes/purchasable_offer",
  );
  assert.ok(previewOffer);
  const previewEntries = previewOffer.value as Array<Record<string, unknown>>;
  assert.deepEqual(
    previewEntries.map((entry) => entry.audience),
    ["ALL", "B2B"],
  );
  assert.equal(
    previewEntries.some((entry) => "discounted_price" in entry),
    false,
  );
  const actualListDelete = actual.find(
    (patch) => patch.path === "/attributes/list_price",
  );
  const previewListDelete = set.preview_patches.find(
    (patch) => patch.path === "/attributes/list_price",
  );
  assert.deepEqual(previewListDelete, actualListDelete);

  const tampered = structuredClone(set.preview_patches);
  const tamperedOffer = tampered.find(
    (patch) => patch.path === "/attributes/purchasable_offer",
  );
  assert.ok(tamperedOffer);
  (tamperedOffer.value as Array<Record<string, unknown>>)[0].our_price =
    priceSchedule(1);
  assert.throws(
    () =>
      assertValidationPreviewSurrogateMatches({
        actualPatches: actual,
        previewPatches: tampered,
        context: "FORWARD_OFFER",
      }),
    /surrogate differs/,
  );
  assert.throws(
    () => buildValidationPreviewPatchSet(actual, "MEDIA"),
    /Non-OFFER MEDIA action/,
  );
});

test("non-offer preview remains exact and a null-only inverse selector fails closed", () => {
  const exactActual: ListingPatch[] = [
    {
      op: "replace",
      path: "/attributes/item_name",
      value: [
        {
          marketplace_id: MARKETPLACE_ID,
          language_tag: "en_US",
          value: "Exact title",
        },
      ],
    },
  ];
  const exact = buildValidationPreviewPatchSet(exactActual, "TEXT_COUNT");
  assert.equal(exact.strategy, "EXACT");
  assert.deepEqual(exact.preview_patches, exactActual);
  assert.notEqual(exact.preview_patches, exactActual);

  assert.throws(
    () =>
      buildValidationPreviewPatchSet(
        [
          {
            op: "merge",
            path: "/attributes/purchasable_offer",
            value: [
              {
                marketplace_id: MARKETPLACE_ID,
                currency: "USD",
                audience: "ALL",
                minimum_seller_allowed_price: null,
              },
            ],
          },
        ],
        "ROLLBACK_INVERSE_OFFER",
      ),
    /only null deletions/,
  );
});

function liveListing(price = 70, b2b = 69.3): ListingItem {
  return {
    sku: "AA-ASAA-AAAA",
    summaries: [
      {
        marketplaceId: MARKETPLACE_ID,
        asin: "B000TEST001",
        productType: "GROCERY",
        itemName: "Uncrustables Peanut Butter & Grape Jelly Sandwiches, 24 Count",
      },
    ],
    attributes: {
      purchasable_offer: [
        {
          audience: "ALL",
          currency: "USD",
          marketplace_id: MARKETPLACE_ID,
          our_price: priceSchedule(price),
          discounted_price: [{ schedule: [{ value_with_tax: 66.98 }] }],
          minimum_seller_allowed_price: priceSchedule(60),
          maximum_seller_allowed_price: priceSchedule(80),
        },
        {
          audience: "B2B",
          currency: "USD",
          marketplace_id: MARKETPLACE_ID,
          our_price: priceSchedule(b2b),
          quantity_discounts: [{ quantity_tier: 10, value: 5 }],
          custom_b2b_metadata: "preserve-me",
        },
      ],
      business_price: [
        { marketplace_id: MARKETPLACE_ID, currency: "USD", schedule: [{ value_with_tax: b2b }] },
      ],
      list_price: [
        { marketplace_id: MARKETPLACE_ID, currency: "USD", value: 71.35 },
      ],
    },
    offers: [
      { offerType: "B2B", audience: { value: "B2B" }, price: { amount: String(b2b) } },
    ],
  };
}

test("dry run and wrong confirmation make zero gateway calls", async () => {
  const plan = build();
  let calls = 0;
  const gateway: RepairAmazonGateway = {
    getListing: async () => { calls++; return liveListing(); },
    patchListing: async () => { calls++; return { status: "VALID" }; },
  };
  const dir = path.join(tmpdir(), `uncr-surgical-${Date.now()}-dry`);
  const store = new ImmutableCheckpointStore(dir, plan.sha256);
  const dry = await executeRepairPlan(plan, gateway, { apply: false, checkpointStore: store });
  assert.equal(dry.mode, "DRY_RUN");
  assert.equal(calls, 0);
  await assert.rejects(
    executeRepairPlan(plan, gateway, {
      apply: true,
      confirmation: "WRONG",
      checkpointStore: store,
    }),
    /requires --confirm/,
  );
  assert.equal(calls, 0);
});

test("executor revalidates a completed checkpoint and repairs subsequent live drift", async () => {
  const plan = build();
  let current = liveListing();
  const calls: string[] = [];
  const gateway: RepairAmazonGateway = {
    getListing: async () => {
      calls.push("GET");
      return structuredClone(current);
    },
    patchListing: async (
      _store,
      _sku,
      _productType,
      patches,
      preview,
      previewContext,
    ) => {
      calls.push(preview ? "PREVIEW" : "PATCH");
      const offer = patches.find((patch) => patch.path === "/attributes/purchasable_offer");
      if (preview) {
        assert.equal(offer?.op, "replace");
        assert.equal(
          previewContext?.strategy,
          SELECTOR_REPLACE_SURROGATE_FOR_MERGE,
        );
        assert.equal(
          previewContext?.actual_patches.find(
            (patch) => patch.path === "/attributes/purchasable_offer",
          )?.op,
          "merge",
        );
        assert.equal(
          (offer?.value as Array<Record<string, unknown>>).some(
            (entry) => entry.discounted_price === null,
          ),
          false,
        );
        return { status: "VALID", issues: [] };
      }
      const business = patches.find((patch) => patch.path === "/attributes/business_price");
      const listPriceDelete = patches.find((patch) => patch.path === "/attributes/list_price");
      assert.ok(offer);
      assert.equal(offer.op, "merge");
      assert.equal(business, undefined);
      assert.equal(listPriceDelete?.op, "delete");
      const submittedOffers = offer.value as Array<Record<string, unknown>>;
      const submittedB2b = submittedOffers.find((entry) => entry.audience === "B2B");
      assert.ok(submittedB2b);
      assert.equal(
        ((submittedB2b.our_price as ReturnType<typeof priceSchedule>)[0].schedule[0])
          .value_with_tax,
        76.99,
      );
      assert.equal(submittedB2b.custom_b2b_metadata, undefined);
      assert.equal(submittedB2b.quantity_discounts, undefined);
      const mergedOffers = applyPurchasableOfferMerge(
        (current.attributes as Record<string, unknown>).purchasable_offer,
        offer.value,
      );
      const mergedB2b = mergedOffers.find((entry) => entry.audience === "B2B");
      assert.equal(mergedB2b?.custom_b2b_metadata, "preserve-me");
      assert.deepEqual(mergedB2b?.quantity_discounts, [
        { quantity_tier: 10, value: 5 },
      ]);
      const nextAttributes = {
        ...current.attributes,
        purchasable_offer: mergedOffers,
      } as Record<string, unknown>;
      delete nextAttributes.list_price;
      current = {
        ...current,
        attributes: nextAttributes,
        offers: [
          { offerType: "B2B", audience: { value: "B2B" }, price: { amount: "76.99" } },
        ],
      } as ListingItem;
      return { status: "ACCEPTED", submissionId: "submission-1", issues: [] };
    },
  };
  const dir = path.join(tmpdir(), `uncr-surgical-${Date.now()}-apply`);
  const checkpointStore = new ImmutableCheckpointStore(dir, plan.sha256);
  await checkpointStore.append({
    action_id: plan.entries[0].actions[0].action_id,
    sku: plan.entries[0].sku,
    kind: plan.entries[0].actions[0].kind,
    status: "VERIFIED",
    detail: { test_fixture: "state later drifted" },
  });
  const result = await executeRepairPlan(plan, gateway, {
    apply: true,
    confirmation: confirmationToken(plan),
    checkpointStore,
    requestDelayMs: 200,
    verifyAttempts: 1,
    verifyDelayMs: 1,
    settlementAttempts: 3,
    settlementDelayMs: 1,
    settlementStableReads: 2,
    sleep: async () => {},
  });
  assert.equal(result.resumed_actions, 0);
  assert.equal(result.verified_actions, 1);
  assert.deepEqual(
    calls.filter((call) => call !== "GET"),
    ["PREVIEW", "PATCH"],
  );
  assert.ok(
    calls.filter((call) => call === "GET").length >= 5,
    "a fresh pre-write GET and stable post-write reads are mandatory",
  );
  const checkpointFiles = await readdir(
    path.join(dir, plan.sha256.slice(0, 20)),
  );
  const checkpointEvents = await Promise.all(
    checkpointFiles.map(async (name) =>
      JSON.parse(
        await readFile(path.join(dir, plan.sha256.slice(0, 20), name), "utf8"),
      ) as { status: string; detail: Record<string, unknown> },
    ),
  );
  const previewEvidence = checkpointEvents.find(
    (event) => event.status === "PREVIEW_VALID",
  )?.detail;
  assert.equal(
    previewEvidence?.strategy,
    SELECTOR_REPLACE_SURROGATE_FOR_MERGE,
  );
  assert.match(String(previewEvidence?.actual_merge_patch_sha256), /^[a-f0-9]{64}$/);
  assert.match(
    String(previewEvidence?.preview_surrogate_patch_sha256),
    /^[a-f0-9]{64}$/,
  );
  assert.notEqual(
    previewEvidence?.actual_merge_patch_sha256,
    previewEvidence?.preview_surrogate_patch_sha256,
  );
  assert.deepEqual(previewEvidence?.actual_request_patch_paths, [
    "/attributes/purchasable_offer",
    "/attributes/list_price",
  ]);
  assert.deepEqual(previewEvidence?.preview_surrogate_patch_paths, [
    "/attributes/purchasable_offer",
  ]);
  assert.deepEqual(previewEvidence?.preview_request_patch_paths, [
    "/attributes/purchasable_offer",
    "/attributes/list_price",
  ]);
  const submittedEvidence = checkpointEvents.find(
    (event) => event.status === "SUBMITTED",
  )?.detail;
  assert.equal(
    submittedEvidence?.actual_merge_patch_sha256,
    previewEvidence?.actual_merge_patch_sha256,
  );
  assert.deepEqual(
    (current.attributes as Record<string, unknown>).business_price,
    [
      {
        marketplace_id: MARKETPLACE_ID,
        currency: "USD",
        schedule: [{ value_with_tax: 69.3 }],
      },
    ],
    "ignored legacy business_price stays untouched while observed B2B verifies",
  );
});

test("executor resumes a completed action only after a fresh live verification", async () => {
  const plan = build();
  const current = liveListing(76.99, 76.99);
  const attrs = current.attributes as Record<string, unknown>;
  const consumer = (attrs.purchasable_offer as Array<Record<string, unknown>>)[0];
  delete consumer.discounted_price;
  consumer.minimum_seller_allowed_price = priceSchedule(66.95);
  consumer.maximum_seller_allowed_price = priceSchedule(76.99);
  delete attrs.list_price;
  let gets = 0;
  const gateway: RepairAmazonGateway = {
    getListing: async () => {
      gets++;
      return structuredClone(current);
    },
    patchListing: async () => {
      throw new Error("A freshly verified checkpoint must not PATCH.");
    },
  };
  const dir = path.join(tmpdir(), `uncr-surgical-${Date.now()}-resume`);
  const checkpointStore = new ImmutableCheckpointStore(dir, plan.sha256);
  await checkpointStore.append({
    action_id: plan.entries[0].actions[0].action_id,
    sku: plan.entries[0].sku,
    kind: plan.entries[0].actions[0].kind,
    status: "VERIFIED",
    detail: { test_fixture: "still current" },
  });
  const result = await executeRepairPlan(plan, gateway, {
    apply: true,
    confirmation: confirmationToken(plan),
    checkpointStore,
    requestDelayMs: 200,
    sleep: async () => {},
  });
  assert.equal(gets, 1);
  assert.equal(result.resumed_actions, 1);
  assert.equal(result.verified_actions, 0);
});

test("an unresolved accepted PATCH is recovered to stable desired state without a duplicate write", async () => {
  const plan = build();
  const before = liveListing();
  let phase: "UNSETTLED" | "LATE_DESIRED" = "UNSETTLED";
  let afterSubmission = false;
  let settlementRead = 0;
  let realWrites = 0;
  let desired = structuredClone(before);
  const gateway: RepairAmazonGateway = {
    getListing: async () => {
      if (!afterSubmission) return structuredClone(before);
      if (phase === "LATE_DESIRED") return structuredClone(desired);
      settlementRead++;
      if (settlementRead % 2 === 1) return structuredClone(before);
      const intermediate = liveListing(71, 71);
      return structuredClone(intermediate);
    },
    patchListing: async (_store, _sku, _type, patches, preview) => {
      if (preview) return { status: "VALID", issues: [] };
      realWrites++;
      const offer = patches.find(
        (patch) => patch.path === "/attributes/purchasable_offer",
      );
      assert.ok(offer);
      const attrs = structuredClone(before.attributes) as Record<string, unknown>;
      attrs.purchasable_offer = applyPurchasableOfferMerge(
        attrs.purchasable_offer,
        offer.value,
      );
      delete attrs.list_price;
      desired = {
        ...structuredClone(before),
        attributes: attrs,
        offers: [
          {
            offerType: "B2B",
            audience: { value: "B2B" },
            price: { amount: "76.99" },
          },
        ],
      } as ListingItem;
      afterSubmission = true;
      return {
        status: "IN_PROGRESS",
        submissionId: "late-forward-submission",
        issues: [],
      };
    },
  };
  const checkpoint = new ImmutableCheckpointStore(
    path.join(tmpdir(), `uncr-forward-settlement-${Date.now()}-${Math.random()}`),
    plan.sha256,
  );
  const first = await executeRepairPlan(plan, gateway, {
    apply: true,
    confirmation: confirmationToken(plan),
    checkpointStore: checkpoint,
    requestDelayMs: 200,
    verifyAttempts: 1,
    verifyDelayMs: 1,
    settlementAttempts: 3,
    settlementDelayMs: 1,
    settlementStableReads: 2,
    sleep: async () => {},
  });
  assert.equal(first.failed_actions, 1);
  assert.equal(first.stopped_early, true);
  assert.equal(first.unresolved_settlements, 1);
  assert.equal(realWrites, 1);
  assert.equal((await checkpoint.pendingSubmissions()).size, 1);

  phase = "LATE_DESIRED";
  const recovered = await executeRepairPlan(plan, gateway, {
    apply: true,
    confirmation: confirmationToken(plan),
    checkpointStore: checkpoint,
    requestDelayMs: 200,
    settlementAttempts: 3,
    settlementDelayMs: 1,
    settlementStableReads: 2,
    sleep: async () => {},
  });
  assert.equal(recovered.recovered_pending_actions, 1);
  assert.equal(recovered.resumed_actions, 1);
  assert.equal(recovered.failed_actions, 0);
  assert.equal(realWrites, 1, "recovery must never resubmit an open accepted PATCH");
  assert.equal((await checkpoint.pendingSubmissions()).size, 0);
});

test("validation-only mode calls VALIDATION_PREVIEW and never a real PATCH", async () => {
  const plan = build();
  const calls: string[] = [];
  const gateway: RepairAmazonGateway = {
    getListing: async () => {
      calls.push("GET");
      return liveListing();
    },
    patchListing: async (_store, _sku, _type, _patches, preview) => {
      calls.push(preview ? "PREVIEW" : "PATCH");
      return { status: preview ? "VALID" : "ACCEPTED", issues: [] };
    },
  };
  const dir = path.join(tmpdir(), `uncr-surgical-${Date.now()}-preview`);
  const result = await executeRepairPlan(plan, gateway, {
    apply: false,
    validationOnly: true,
    checkpointStore: new ImmutableCheckpointStore(dir, plan.sha256),
    requestDelayMs: 200,
    sleep: async () => {},
  });
  assert.equal(result.mode, "VALIDATION_PREVIEW");
  assert.equal(result.preview_valid_actions, 1);
  assert.deepEqual(calls, ["GET", "PREVIEW"]);
});

test("INVALID preview fails closed before a real PATCH", async () => {
  const plan = build();
  let realPatch = 0;
  let sawSurrogate = false;
  const gateway: RepairAmazonGateway = {
    getListing: async () => liveListing(),
    patchListing: async (_store, _sku, _type, patches, preview, context) => {
      if (!preview) realPatch++;
      if (preview) {
        sawSurrogate =
          patches.find(
            (patch) => patch.path === "/attributes/purchasable_offer",
          )?.op === "replace" &&
          context?.actual_patches.find(
            (patch) => patch.path === "/attributes/purchasable_offer",
          )?.op === "merge";
      }
      return { status: preview ? "INVALID" : "ACCEPTED", issues: [] };
    },
  };
  const dir = path.join(tmpdir(), `uncr-surgical-${Date.now()}-invalid`);
  const result = await executeRepairPlan(plan, gateway, {
    apply: true,
    confirmation: confirmationToken(plan),
    checkpointStore: new ImmutableCheckpointStore(dir, plan.sha256),
    requestDelayMs: 200,
    sleep: async () => {},
  });
  assert.equal(result.failed_actions, 1);
  assert.equal(sawSurrogate, true);
  assert.equal(realPatch, 0);
});

test("ignored-attribute warning 90000900 fails preview closed before a real PATCH", async () => {
  const plan = build();
  let realPatch = 0;
  const gateway: RepairAmazonGateway = {
    getListing: async () => liveListing(),
    patchListing: async (_store, _sku, _type, _patches, preview) => {
      if (!preview) realPatch++;
      return {
        status: preview ? "VALID" : "ACCEPTED",
        issues: preview
          ? [
              {
                code: "90000900",
                severity: "WARNING",
                message: "The submitted attribute has been ignored.",
              },
            ]
          : [],
      };
    },
  };
  const dir = path.join(tmpdir(), `uncr-surgical-${Date.now()}-ignored-preview`);
  const result = await executeRepairPlan(plan, gateway, {
    apply: true,
    confirmation: confirmationToken(plan),
    checkpointStore: new ImmutableCheckpointStore(dir, plan.sha256),
    requestDelayMs: 200,
    sleep: async () => {},
  });
  assert.equal(result.failed_actions, 1);
  assert.equal(realPatch, 0);
});

test("ignored-attribute warning 90000900 also rejects an accepted real PATCH", async () => {
  const plan = build();
  let realPatch = 0;
  const gateway: RepairAmazonGateway = {
    getListing: async () => liveListing(),
    patchListing: async (_store, _sku, _type, _patches, preview) => {
      if (preview) return { status: "VALID", issues: [] };
      realPatch++;
      return {
        status: "ACCEPTED",
        issues: [
          {
            code: 90000900,
            severity: "WARNING",
            message: "The submitted attribute has been ignored.",
          },
        ],
      };
    },
  };
  const dir = path.join(tmpdir(), `uncr-surgical-${Date.now()}-ignored-apply`);
  const result = await executeRepairPlan(plan, gateway, {
    apply: true,
    confirmation: confirmationToken(plan),
    checkpointStore: new ImmutableCheckpointStore(dir, plan.sha256),
    requestDelayMs: 200,
    sleep: async () => {},
  });
  assert.equal(result.failed_actions, 1);
  assert.equal(realPatch, 1);
});

test("unrelated VALID warning remains nonblocking and recorded", async () => {
  const plan = build();
  const gateway: RepairAmazonGateway = {
    getListing: async () => liveListing(),
    patchListing: async () => ({
      status: "VALID",
      issues: [
        {
          code: "NON_BLOCKING_TEST_WARNING",
          severity: "WARNING",
          message: "Informational warning.",
        },
      ],
    }),
  };
  const dir = path.join(tmpdir(), `uncr-surgical-${Date.now()}-warning`);
  const result = await executeRepairPlan(plan, gateway, {
    apply: false,
    validationOnly: true,
    checkpointStore: new ImmutableCheckpointStore(dir, plan.sha256),
    requestDelayMs: 200,
    sleep: async () => {},
  });
  assert.equal(result.failed_actions, 0);
  assert.equal(result.preview_valid_actions, 1);
});

test("KP fallback finishes PASTRY, then structured repair previews against fresh PASTRY", async () => {
  const row = ledgerRow();
  row.sku = "KP-ASYC-RN84";
  row.asin = "B0H83FYZR3";
  row.canonical.total_units = 90;
  row.canonical.components[0].qty = 90;
  row.db.draft.pack_count = 90;
  row.db.draft.selected_variant.composition[0].qty = 90;
  row.live.product_type = "PASTRY";
  row.live.title = "Uncrustables Peanut Butter & Grape Jelly Sandwiches, 90 Count";
  row.live.bullets[0] = "Includes 90 peanut butter and grape jelly sandwiches.";
  row.live.description = "This listing contains 90 peanut butter and grape jelly sandwiches.";
  const kpPricing = priceFor(90);
  assert.ok(kpPricing);
  row.live.consumer_offer = {
    our_price: kpPricing.suggested,
    minimum_seller_allowed_price: kpPricing.floor,
    maximum_seller_allowed_price: kpPricing.suggested,
  };
  row.live.raw_offers = [
    {
      offerType: "B2B",
      price: { amount: String(kpPricing.suggested) },
      audience: { value: "B2B" },
    },
  ];
  const bytes = ledgerBytes([row]);
  const basePlan = buildRepairPlan({
    ledgerPath: "/tmp/kp-ledger.json",
    ledgerBytes: bytes,
    createdAt: new Date("2026-07-17T00:00:00.000Z"),
    manifest: {
      schema_version: "uncrustables-surgical-desired/v1",
      source_ledger_sha256: sha256(bytes),
      repairs: [
        {
          sku: "KP-ASYC-RN84",
          review: {
            confidence: "HIGH",
            rationale: "GROCERY Count preview was valid; PASTRY requires ounces.",
            evidence: ["VALIDATION_PREVIEW returned VALID with zero issues."],
          },
          text_count: {
            unit_count: 90,
            unit_count_type: "Count",
            number_of_items: 90,
            request_product_type: "GROCERY",
            expected_product_type: "GROCERY",
            must_clear_issue_codes: ["90244"],
            fallback: {
              reason: "PASTRY schema fallback",
              unit_count: 252,
              unit_count_type: "Ounce",
              number_of_items: 90,
              request_product_type: "PASTRY",
              expected_product_type: "PASTRY",
              must_clear_issue_codes: ["90244"],
            },
          },
        },
      ],
    },
  });
  const { sha256: basePlanSha, ...baseBody } = basePlan;
  assert.ok(basePlanSha);
  const entries = structuredClone(baseBody.entries);
  entries[0].actions.splice(1, 0, {
    action_id: "KP-ASYC-RN84:structured_attributes",
    kind: "STRUCTURED_ATTRIBUTES",
    reasons: ["TEST_PINNED_MANUFACTURER_FACTS"],
    desired: {
      kind: "STRUCTURED_ATTRIBUTES",
      value: {
        ingredients: "Exact reviewed manufacturer ingredients.",
        ingredients_sha256: sha256("Exact reviewed manufacturer ingredients."),
        allergen_information: [
          "peanuts",
          "wheat",
          "milk_may_contain",
          "tree_nuts_may_contain",
        ],
        reviewed_allergens: {
          contains: ["Peanut", "Wheat"],
          may_contain: ["Milk", "Hazelnut"],
        },
        resolved_donor_ids: ["93263f2e-bff8-45f1-b50a-b1946a1da424"],
      },
    },
  });
  const sealedBody: Omit<UncrustablesRepairPlan, "sha256"> = {
    ...baseBody,
    structured_attribute_source: {
      donor_manifest: {
        path: "/tmp/reviewed-donors.json",
        sha256: "999348227982c169477ad13fb806ddba42fb15cb68397308e4289a9cbbcee9f9",
        schema_version: "bundle-factory.uncrustables-donor-enrichment/v2",
        reviewed_at: "2026-07-17",
        source_ledger_sha256: baseBody.source_ledger.sha256,
        donors: 16,
        aliases: 1,
      },
      ptd_proof: {
        path: "/tmp/ptd-proof.json",
        sha256: "98f65723cdb9fd4dedc63317e7ad08bd45e17c95917e3b0ee9e372956a1d0ec9",
        schema_version: "amazon-food-ptd-attribute-proof/v1",
        fetched_at: "2026-07-18T01:02:05.941Z",
        marketplace_id: MARKETPLACE_ID,
        product_types: ["FOOD", "GROCERY", "PASTRY"],
      },
    },
    scope: {
      ...baseBody.scope,
      actions: baseBody.scope.actions + 1,
    },
    entries,
  };
  const plan: UncrustablesRepairPlan = {
    ...sealedBody,
    sha256: sha256(stableJson(sealedBody)),
  };
  let current: ListingItem = {
    sku: "KP-ASYC-RN84",
    summaries: [{ marketplaceId: MARKETPLACE_ID, asin: "B0H83FYZR3", productType: "PASTRY" }],
    attributes: {
      unit_count: [{
        value: 90,
        type: { value: "Count", language_tag: "en_US" },
        marketplace_id: MARKETPLACE_ID,
      }],
      number_of_items: [{ value: 90, marketplace_id: MARKETPLACE_ID }],
    },
    issues: [{ code: "90244", severity: "ERROR" }],
  };
  const calls: string[] = [];
  const gateway: RepairAmazonGateway = {
    getListing: async () => {
      calls.push("GET");
      return structuredClone(current);
    },
    patchListing: async (
      _store,
      _sku,
      productType,
      patches,
      preview,
      previewContext,
    ) => {
      calls.push(`${preview ? "PREVIEW" : "PATCH"}:${productType}`);
      assert.equal(previewContext, undefined);
      assert.equal(patches.some((patch) => patch.op === "merge"), false);
      const unit = patches.find((patch) => patch.path === "/attributes/unit_count");
      const ingredients = patches.find(
        (patch) => patch.path === "/attributes/ingredients",
      );
      if (!preview && productType === "PASTRY" && unit) {
        const number = patches.find((patch) => patch.path === "/attributes/number_of_items");
        current = {
          ...current,
          attributes: {
            ...current.attributes,
            unit_count: unit?.value,
            number_of_items: number?.value,
          },
          issues: [],
        } as ListingItem;
      } else if (!preview && ingredients) {
        const allergens = patches.find(
          (patch) => patch.path === "/attributes/allergen_information",
        );
        current = {
          ...current,
          attributes: {
            ...current.attributes,
            ingredients: ingredients.value,
            allergen_information: allergens?.value,
          },
        } as ListingItem;
      }
      // The accepted GROCERY primary intentionally remains PASTRY + issue 90244,
      // forcing the reviewed post-verification fallback.
      return { status: preview ? "VALID" : "ACCEPTED", issues: [] };
    },
  };
  const dir = path.join(tmpdir(), `uncr-surgical-${Date.now()}-fallback`);
  const checkpointStore = new ImmutableCheckpointStore(dir, plan.sha256);
  const result = await executeRepairPlan(plan, gateway, {
    apply: true,
    confirmation: confirmationToken(plan),
    checkpointStore,
    requestDelayMs: 200,
    verifyAttempts: 1,
    verifyDelayMs: 1,
    settlementAttempts: 3,
    settlementDelayMs: 1,
    settlementStableReads: 2,
    sleep: async () => {},
  });
  assert.equal(result.verified_actions, 2);
  assert.equal(result.failed_actions, 0);
  assert.deepEqual(
    calls.filter((call) => call !== "GET"),
    [
      "PREVIEW:GROCERY",
      "PATCH:GROCERY",
      "PREVIEW:PASTRY",
      "PATCH:PASTRY",
      "PREVIEW:PASTRY",
      "PATCH:PASTRY",
    ],
  );
  const callsBeforeResume = calls.length;
  const resumed = await executeRepairPlan(plan, gateway, {
    apply: true,
    confirmation: confirmationToken(plan),
    checkpointStore,
    requestDelayMs: 200,
    verifyAttempts: 1,
    verifyDelayMs: 1,
    settlementAttempts: 3,
    settlementDelayMs: 1,
    settlementStableReads: 2,
    sleep: async () => {},
  });
  assert.equal(resumed.resumed_actions, 2);
  assert.equal(resumed.verified_actions, 0);
  assert.deepEqual(calls.slice(callsBeforeResume), ["GET", "GET"]);
});

test("direct PASTRY Ounce repair keeps 90 sandwiches as the semantic and price count", async () => {
  const ledgerPath =
    "data/audits/uncrustables-ledger-20260717T232140568Z-offline.json";
  const ledgerBytes = await readFile(ledgerPath);
  const reviewed = JSON.parse(
    await readFile(
      "data/repairs/uncrustables-reviewed-overrides-20260718-v2.json",
      "utf8",
    ),
  ) as DesiredRepairManifest;
  const source = reviewed.repairs.find((repair) => repair.sku === "KP-ASYC-RN84");
  assert.ok(source?.text_count);
  const direct = structuredClone(source);
  direct.text_count = {
    ...direct.text_count!,
    unit_count: 252,
    unit_count_type: "Ounce",
    number_of_items: 90,
    request_product_type: "PASTRY",
    expected_product_type: "PASTRY",
  };
  delete direct.text_count.fallback;
  const plan = buildRepairPlan({
    ledgerPath,
    ledgerBytes,
    manifest: {
      schema_version: "uncrustables-surgical-desired/v1",
      repairs: [direct],
    },
  });
  const entry = plan.entries.find((item) => item.sku === "KP-ASYC-RN84");
  const text = entry?.actions.find((action) => action.kind === "TEXT_COUNT");
  assert.ok(text?.desired.kind === "TEXT_COUNT");
  if (text?.desired.kind === "TEXT_COUNT") {
    assert.equal(text.desired.value.unit_count, 252);
    assert.equal(text.desired.value.unit_count_type, "Ounce");
    assert.equal(text.desired.value.number_of_items, 90);
    assert.equal(text.desired.value.request_product_type, "PASTRY");
    assert.equal(text.desired.value.fallback, undefined);
  }
  const offer = entry?.actions.find((action) => action.kind === "OFFER");
  assert.ok(offer?.desired.kind === "OFFER");
  if (offer?.desired.kind === "OFFER") {
    assert.equal(offer.desired.value.consumer_price, priceFor(90)?.suggested);
  }
});

test("real 164-ASIN plan seals all prices and emits a 164-row ChannelMAX artifact", async () => {
  const ledgerPath = "data/audits/uncrustables-ledger-20260717T232140568Z-offline.json";
  const manifestPath = "data/repairs/uncrustables-reviewed-overrides-20260717.json";
  const donorPath = "data/repairs/uncrustables-donor-enrichment-20260717.json";
  const ptdPath = "data/audits/amazon-food-ptd-attribute-proof-20260718T010205Z.json";
  const [bytes, manifestBytes, donorBytes, ptdBytes] = await Promise.all([
    readFile(ledgerPath),
    readFile(manifestPath, "utf8"),
    readFile(donorPath),
    readFile(ptdPath),
  ]);
  const plan = buildRepairPlan({
    ledgerPath,
    ledgerBytes: bytes,
    manifest: JSON.parse(manifestBytes),
    donorManifest: { path: donorPath, bytes: donorBytes },
    ptdProof: { path: ptdPath, bytes: ptdBytes },
    createdAt: new Date("2026-07-18T02:00:00.000Z"),
  });
  const canaryPlan = buildRepairPlan({
    ledgerPath,
    ledgerBytes: bytes,
    manifest: JSON.parse(manifestBytes),
    donorManifest: { path: donorPath, bytes: donorBytes },
    ptdProof: { path: ptdPath, bytes: ptdBytes },
    skus: ["SZ-ASPI-JFAT"],
    createdAt: new Date("2026-07-18T02:00:01.000Z"),
  });
  assert.deepEqual(canaryPlan.entries.map((entry) => entry.sku), ["SZ-ASPI-JFAT"]);
  assert.ok(
    canaryPlan.entries[0].actions.some(
      (action) => action.kind === "STRUCTURED_ATTRIBUTES",
    ),
  );
  const szOffer = canaryPlan.entries[0].actions.find(
    (action) => action.desired.kind === "OFFER",
  );
  assert.ok(szOffer && szOffer.desired.kind === "OFFER");
  assert.deepEqual(szOffer.desired.value, {
    currency: "USD",
    consumer_price: 76.99,
    business_price: 76.99,
    minimum_seller_allowed_price: 66.95,
    maximum_seller_allowed_price: 76.99,
    discounted_price_absent: true,
    list_price_absent: true,
  });

  // The reviewed 24-count decision, rather than stale canonical total=6,
  // remains the pricing source even if the redundant exact offer is omitted.
  const manifestWithoutSzOffer = JSON.parse(
    manifestBytes,
  ) as DesiredRepairManifest;
  const szRepair = manifestWithoutSzOffer.repairs.find(
    (repair) => repair.sku === "SZ-ASPI-JFAT",
  );
  assert.ok(szRepair);
  delete szRepair.offer;
  const derivedSzPlan = buildRepairPlan({
    ledgerPath,
    ledgerBytes: bytes,
    manifest: manifestWithoutSzOffer,
    donorManifest: { path: donorPath, bytes: donorBytes },
    ptdProof: { path: ptdPath, bytes: ptdBytes },
    skus: ["SZ-ASPI-JFAT"],
    createdAt: new Date("2026-07-18T02:00:02.000Z"),
  });
  const derivedSzOffer = derivedSzPlan.entries[0].actions.find(
    (action) => action.desired.kind === "OFFER",
  );
  assert.ok(derivedSzOffer && derivedSzOffer.desired.kind === "OFFER");
  assert.deepEqual(derivedSzOffer.desired.value, szOffer.desired.value);
  assert.deepEqual(derivedSzOffer.reasons, [
    "HIGH_REVIEWED_COUNT_PRICE_MODEL_MISMATCH",
  ]);
  assert.equal(
    plan.structured_attribute_source?.donor_manifest.sha256,
    "999348227982c169477ad13fb806ddba42fb15cb68397308e4289a9cbbcee9f9",
  );
  assert.equal(
    plan.structured_attribute_source?.ptd_proof.sha256,
    "98f65723cdb9fd4dedc63317e7ad08bd45e17c95917e3b0ee9e372956a1d0ec9",
  );
  assert.throws(
    () => buildRepairPlan({
      ledgerPath,
      ledgerBytes: bytes,
      manifest: JSON.parse(manifestBytes),
      donorManifest: {
        path: donorPath,
        bytes: Buffer.concat([donorBytes, Buffer.from("\n")]),
      },
      ptdProof: { path: ptdPath, bytes: ptdBytes },
    }),
    /Donor manifest SHA-256/,
  );
  assert.throws(
    () => buildRepairPlan({
      ledgerPath,
      ledgerBytes: bytes,
      manifest: JSON.parse(manifestBytes),
      donorManifest: { path: donorPath, bytes: donorBytes },
      ptdProof: {
        path: ptdPath,
        bytes: Buffer.concat([ptdBytes, Buffer.from("\n")]),
      },
    }),
    /PTD attribute proof SHA-256/,
  );
  assert.equal(plan.scope.entries, 164);
  assert.equal(plan.semantic_audit.checked, 164);
  assert.equal(plan.semantic_audit.failed, 2);
  assert.equal(plan.semantic_audit.blocked, 0);
  assert.equal(
    plan.entries.flatMap((entry) => entry.actions).filter((action) => action.kind === "OFFER").length,
    164,
  );
  assert.equal(
    plan.entries.flatMap((entry) => entry.actions).filter((action) => action.kind === "TEXT_COUNT").length,
    3,
  );
  const executionRank = new Map([
    ["TEXT_COUNT", 0],
    ["STRUCTURED_ATTRIBUTES", 1],
    ["MEDIA", 2],
    ["OFFER", 3],
  ]);
  for (const entry of plan.entries) {
    const ranks = entry.actions.map((action) => executionRank.get(action.kind));
    assert.deepEqual(
      ranks,
      [...ranks].sort((left, right) => (left ?? 99) - (right ?? 99)),
      `${entry.sku} actions must follow dependency-safe execution order`,
    );
  }
  const kp = plan.entries.find((entry) => entry.sku === "KP-ASYC-RN84");
  assert.ok(kp);
  assert.equal(kp.actions[0].kind, "TEXT_COUNT");
  assert.ok(kp.actions.some((action) => action.kind === "STRUCTURED_ATTRIBUTES"));
  assert.ok(kp.actions.some((action) => action.kind === "OFFER"));
  const structured = plan.entries.flatMap((entry) =>
    entry.actions.filter(
      (action) => action.desired.kind === "STRUCTURED_ATTRIBUTES",
    ),
  );
  assert.equal(structured.length, 164);
  const structuredValues = structured.map((action) => {
    assert.equal(action.desired.kind, "STRUCTURED_ATTRIBUTES");
    return action.desired.value;
  });
  assert.ok(structuredValues.every((value) => !value.allergen_information.includes("soy")));
  assert.ok(structuredValues.every((value) => value.each_unit_count == null));
  assert.ok(structuredValues.every((value) => value.item_package_quantity == null));
  const maxIngredientBytes = Math.max(
    ...structuredValues.map((value) => Buffer.byteLength(value.ingredients, "utf8")),
  );
  assert.equal(maxIngredientBytes, 1433);
  assert.ok(maxIngredientBytes < 6000);
  const shippingOverrides = plan.entries
    .flatMap((entry) => entry.actions.map((action) => ({ entry, action })))
    .filter(
      ({ action }) =>
        action.desired.kind === "STRUCTURED_ATTRIBUTES" &&
        action.desired.value.merchant_shipping_group != null,
    );
  assert.deepEqual(
    shippingOverrides.map(({ entry }) => entry.sku).sort(),
    ["AZ-ASMY-VEQ2", "SZ-ASPI-JFAT"],
  );
  for (const { action } of shippingOverrides) {
    assert.equal(action.desired.kind, "STRUCTURED_ATTRIBUTES");
    assert.equal(
      action.desired.value.merchant_shipping_group,
      "27fef112-3cf4-4f8f-b117-7c47254aa16c",
    );
  }
  assert.deepEqual(
    plan.entries
      .filter((entry) => entry.actions.some(
        (action) =>
          action.desired.kind === "STRUCTURED_ATTRIBUTES" &&
          action.desired.value.each_unit_count_absent === true,
      ))
      .map((entry) => entry.sku),
    ["VN-AS1A-D572"],
  );
  assert.deepEqual(
    plan.entries
      .filter((entry) => entry.actions.some(
        (action) =>
          action.desired.kind === "STRUCTURED_ATTRIBUTES" &&
          action.desired.value.is_expiration_dated_product === true,
      ))
      .map((entry) => entry.sku),
    ["SZ-ASPI-JFAT"],
  );
  const allergenShapes = structuredValues.reduce<Record<string, number>>(
    (counts, value) => {
      const key = value.allergen_information.join(",");
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    },
    {},
  );
  assert.equal(
    allergenShapes["hazelnut,milk,wheat,peanuts_may_contain"],
    5,
  );
  assert.equal(
    allergenShapes["hazelnut,milk,peanuts,wheat"],
    12,
  );
  assert.equal(
    allergenShapes["peanuts,wheat,milk_may_contain,tree_nuts_may_contain"],
    147,
  );
  const mixedIngredients = structuredValues.find(
    (value) => value.resolved_donor_ids.length === 2,
  );
  assert.ok(mixedIngredients);
  assert.match(mixedIngredients.ingredients, /: .* \| .*: /);
  for (const segment of mixedIngredients.ingredients.split(" | ")) {
    const label = segment.slice(0, segment.indexOf(": "));
    assert.doesNotMatch(label, /\b\d+(?:\.\d+)?\s*(?:ct|count|oz|ounce)\b/i);
  }
  const legacyAlias = plan.entries
    .find((entry) => entry.sku === "NS-ASSD-B3JJ")
    ?.actions.find((action) => action.desired.kind === "STRUCTURED_ATTRIBUTES");
  assert.ok(legacyAlias && legacyAlias.desired.kind === "STRUCTURED_ATTRIBUTES");
  assert.deepEqual(legacyAlias.desired.value.resolved_donor_ids, [
    "20d65340-4c9f-4361-a997-e839e26747ca",
  ]);

  const regularStructured = structured.find(
    (action) =>
      action.desired.kind === "STRUCTURED_ATTRIBUTES" &&
      action.desired.value.merchant_shipping_group == null,
  );
  assert.ok(regularStructured);
  const structuredPatches = buildActionPatches(
    regularStructured,
    { sku: "structured-test", attributes: {} },
  );
  assert.deepEqual(
    structuredPatches.map((patch) => patch.path),
    ["/attributes/ingredients", "/attributes/allergen_information"],
  );
  assert.ok(
    structuredPatches.every(
      (patch) =>
        !/shelf|inventory|nutrition|fulfillment/i.test(patch.path),
    ),
  );
  const postAttributes = Object.fromEntries(
    structuredPatches.map((patch) => [
      patch.path.replace("/attributes/", ""),
      patch.value,
    ]),
  );
  assert.equal(
    (await verifyActionState(regularStructured, {
      sku: "structured-test",
      attributes: postAttributes,
    })).ok,
    true,
  );
  const vnStructured = plan.entries
    .find((entry) => entry.sku === "VN-AS1A-D572")
    ?.actions.find((action) => action.desired.kind === "STRUCTURED_ATTRIBUTES");
  assert.ok(vnStructured);
  const vnPatches = buildActionPatches(vnStructured, {
    sku: "VN-AS1A-D572",
    attributes: {
      each_unit_count: [{ value: 4, marketplace_id: MARKETPLACE_ID }],
    },
  });
  assert.equal(
    vnPatches.find((patch) => patch.path === "/attributes/each_unit_count")?.op,
    "delete",
  );
  const szStructured = plan.entries
    .find((entry) => entry.sku === "SZ-ASPI-JFAT")
    ?.actions.find((action) => action.desired.kind === "STRUCTURED_ATTRIBUTES");
  assert.ok(szStructured);
  const szPaths = buildActionPatches(szStructured, {
    sku: "SZ-ASPI-JFAT",
    attributes: {},
  }).map((patch) => patch.path);
  assert.ok(szPaths.includes("/attributes/is_expiration_dated_product"));
  assert.ok(szPaths.includes("/attributes/merchant_shipping_group"));
  assert.ok(szPaths.every((path) => !/shelf_life|expiration_type/.test(path)));
  for (const entry of plan.entries) {
    const textAction = entry.actions.find((action) => action.kind === "TEXT_COUNT");
    if (!textAction || textAction.desired.kind !== "TEXT_COUNT") continue;
    const title = textAction.desired.value.title;
    if (!title) continue;
    const claims = [...title.matchAll(/\b(\d{1,4})\s*(?:ct|count)\b/gi)].map(
      (match) => Number(match[1]),
    );
    assert.deepEqual(
      claims,
      [textAction.desired.value.unit_count],
      `${entry.sku} must expose only its final individual count`,
    );
    assert.doesNotMatch(title, /\(\s*\)|\(\s*[,;]|[,;]\s*\)|,\s*,/);
  }
  const vn = plan.entries.find((entry) => entry.sku === "VN-AS1A-D572");
  const vnText = vn?.actions.find((action) => action.kind === "TEXT_COUNT");
  assert.ok(vnText && vnText.desired.kind === "TEXT_COUNT");
  if (vnText?.desired.kind === "TEXT_COUNT") {
    assert.equal(vnText.desired.value.unit_count, 45);
    assert.equal(vnText.desired.value.number_of_items, 45);
    assert.doesNotMatch(vnText.desired.value.title ?? "", /4\s*ct|pack of/i);
  }
  const out = path.join(tmpdir(), `uncr-channelmax-${Date.now()}`);
  const artifact = await writeImmutableChannelMaxArtifact(out, plan);
  assert.equal(artifact.manifest.rows, 164);
  const text = await readFile(artifact.tsvPath, "utf8");
  assert.equal(text.trim().split(/\r?\n/).length, 165);
  assert.match(text, /^SKU\tASIN\tSellingVenue\tMinSellingPrice\tMaxSellingPrice\r?\n/);
  assert.match(text, /SZ-ASPI-JFAT\tB0H776M5B5\tAmazonUS\t66\.95\t76\.99/);
});

test("text/count patches preserve the live unit shape while setting reviewed type", () => {
  const action = build().entries[0].actions[0];
  assert.equal(action.kind, "OFFER");
  const patches = buildActionPatches(action, liveListing());
  assert.equal(patches[0].op, "merge");
  assert.deepEqual(patches.map((patch: ListingPatch) => patch.path), [
    "/attributes/purchasable_offer",
    "/attributes/list_price",
  ]);
  assert.deepEqual(patches.at(-1), {
    op: "delete",
    path: "/attributes/list_price",
    value: [{ marketplace_id: MARKETPLACE_ID, currency: "USD" }],
  });
});
