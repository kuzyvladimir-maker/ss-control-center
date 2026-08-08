/**
 * A listing that holds several flavors.
 *
 * On 2026-08-06 the owner asked for "20 listings of 8 cans, 2 kinds of soup,
 * 4 cans of each". The request reached the builder as 20 × 8 and would have
 * produced twenty single-flavor eight-packs — the wrong product, at full cost,
 * discovered only after publication. These are the rules that make the mix
 * survive the trip.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWalmartStudioDraftWorkItems,
  parseWalmartStudioDraftWorkItem,
  WalmartStudioDraftContractError,
} from "../walmart-studio-draft-contract";
import { resolveWalmartStudioRequestIntent } from "../walmart-studio-request";
import { estimateWalmartStudioShippingPackage } from "../walmart-studio-listing";

const BASE = {
  storeIndex: 1,
  shippingTemplateId: "TPL-1",
  shippingTemplateSha256: "a".repeat(64),
  targetMarginBps: 5000,
  asOf: new Date("2026-08-06T00:00:00.000Z").toISOString(),
  priceMaxAgeMs: 86_400_000,
  zip: "33765",
};

function candidate(n: number) {
  return {
    ready: true,
    donor_product_id: `donor-${n}`,
    canonical_variant_id: `cpv1:${n}`,
    title: `Campbell's Soup Flavor ${n}`,
    candidate: {
      content_observation_id: `content-${n}`,
      price_observation_id: `price-${n}`,
    },
  } as never;
}

const pool = (count: number) => Array.from({ length: count }, (_, i) => candidate(i + 1));

test("two flavors of four fill one eight-can listing", () => {
  const items = buildWalmartStudioDraftWorkItems({
    ...BASE,
    candidates: pool(4),
    listingCount: 2,
    packCount: 8,
    flavorsPerListing: 2,
    unitsPerFlavor: 4,
  });
  assert.equal(items.length, 2);
  for (const item of items) {
    assert.equal(item.components.length, 2);
    assert.deepEqual(item.components.map((c) => c.quantity), [4, 4]);
    assert.equal(item.pack_count, 8);
    // The singular fields still describe the first component, so every reader
    // that predates mixed assortments keeps working.
    assert.equal(item.donor_product_id, item.components[0].donor_product_id);
  }
  // No variant is used twice across the run — that would be a duplicate listing.
  const used = items.flatMap((i) => i.components.map((c) => c.canonical_variant_id));
  assert.equal(new Set(used).size, used.length);
});

test("a plain multipack still produces one component", () => {
  const items = buildWalmartStudioDraftWorkItems({
    ...BASE, candidates: pool(3), listingCount: 3, packCount: 6,
  });
  assert.equal(items.length, 3);
  for (const item of items) {
    assert.equal(item.components.length, 1);
    assert.equal(item.components[0].quantity, 6);
  }
});

test("a mix needs flavors x listings distinct variants, and says so", () => {
  assert.throws(
    () => buildWalmartStudioDraftWorkItems({
      ...BASE, candidates: pool(5), listingCount: 3, packCount: 8,
      flavorsPerListing: 2, unitsPerFlavor: 4,
    }),
    (error: unknown) => {
      assert.ok(error instanceof WalmartStudioDraftContractError);
      assert.match(error.message, /6 are required/);
      assert.match(error.message, /3 listings x 2 flavors/);
      return true;
    },
  );
});

test("a composition that does not fill the pack is refused", () => {
  assert.throws(
    () => buildWalmartStudioDraftWorkItems({
      ...BASE, candidates: pool(6), listingCount: 2, packCount: 8,
      flavorsPerListing: 3, unitsPerFlavor: 5,
    }),
    (error: unknown) => {
      assert.ok(error instanceof WalmartStudioDraftContractError);
      assert.equal(error.code, "PACK_COMPOSITION_INVALID");
      return true;
    },
  );
});

test("a work item sealed before mixes existed still validates", () => {
  // The seal is over the bytes. If `components` entered the digest, every work
  // item sealed before today would fail as "bytes changed after admission" —
  // so a plain multipack must hash exactly as it did before the field existed.
  const [built] = buildWalmartStudioDraftWorkItems({
    ...BASE, candidates: pool(1), listingCount: 1, packCount: 8,
  });
  const legacyShaped = { ...built } as Record<string, unknown>;
  delete legacyShaped.components;

  const parsed = parseWalmartStudioDraftWorkItem(legacyShaped);
  assert.equal(parsed.work_item_sha256, built.work_item_sha256);
  assert.equal(parsed.components.length, 1);
  assert.equal(parsed.components[0].quantity, 8);
  assert.equal(parsed.components[0].canonical_variant_id, built.canonical_variant_id);
});

test("a mixed listing seals over its components and cannot be edited after", () => {
  const [mixed] = buildWalmartStudioDraftWorkItems({
    ...BASE, candidates: pool(2), listingCount: 1, packCount: 8,
    flavorsPerListing: 2, unitsPerFlavor: 4,
  });
  const tampered = {
    ...mixed,
    components: [
      { ...mixed.components[0], quantity: 6 },
      { ...mixed.components[1], quantity: 2 },
    ],
  };
  assert.throws(
    () => parseWalmartStudioDraftWorkItem(tampered),
    /bytes changed after admission/,
  );
});

test("components whose quantities miss the pack count are refused", () => {
  const item = {
    schema_version: "bundle-factory.walmart-draft-work-item/1.0.0",
    spec_index: 0,
    donor_product_id: "donor-1",
    canonical_variant_id: "cpv1:1",
    content_observation_id: "content-1",
    price_observation_id: "price-1",
    title_at_admission: "A",
    components: [
      { donor_product_id: "donor-1", canonical_variant_id: "cpv1:1", content_observation_id: "content-1", price_observation_id: "price-1", title_at_admission: "A", quantity: 4 },
      { donor_product_id: "donor-2", canonical_variant_id: "cpv1:2", content_observation_id: "content-2", price_observation_id: "price-2", title_at_admission: "B", quantity: 3 },
    ],
    pack_count: 8,
    store_index: 1,
    shipping_template_id: "TPL-1",
    shipping_template_sha256: "a".repeat(64),
    target_margin_bps: 5000,
    as_of: BASE.asOf,
    price_max_age_ms: 86_400_000,
    zip: "33765",
    marketplace_mutation_allowed: false,
    upc_reservation_allowed: false,
    work_item_sha256: "b".repeat(64),
  };
  assert.throws(
    () => parseWalmartStudioDraftWorkItem(item),
    /hold 7 units but pack_count says 8/,
  );
});

test("the same product twice in one listing is refused", () => {
  const dupe = {
    donor_product_id: "donor-1", canonical_variant_id: "cpv1:1",
    content_observation_id: "content-1", price_observation_id: "price-1",
    title_at_admission: "A", quantity: 4,
  };
  assert.throws(
    () => parseWalmartStudioDraftWorkItem({
      schema_version: "bundle-factory.walmart-draft-work-item/1.0.0",
      spec_index: 0,
      donor_product_id: "donor-1",
      canonical_variant_id: "cpv1:1",
      content_observation_id: "content-1",
      price_observation_id: "price-1",
      title_at_admission: "A",
      components: [dupe, { ...dupe }],
      pack_count: 8,
      store_index: 1,
      shipping_template_id: "TPL-1",
      shipping_template_sha256: "a".repeat(64),
      target_margin_bps: 5000,
      as_of: BASE.asOf,
      price_max_age_ms: 86_400_000,
      zip: "33765",
      marketplace_mutation_allowed: false,
      upc_reservation_allowed: false,
      work_item_sha256: "b".repeat(64),
    }),
    /appears twice in one listing/,
  );
});

// ── Reading the mix out of the operator's own words ─────────────────────────

test("the owner's actual 2026-08-06 brief is read as a mixed assortment", () => {
  const intent = resolveWalmartStudioRequestIntent({
    prompt:
      "Консервированные супы Campbell's по 10,5 унций. Надо, чтобы ты подготовил "
      + "20 новых листингов по 8 банок в каждом. И в каждом листинге должно быть "
      + "по 2 вида супа. Соответственно, по 4 банки каждого вкуса. Итого 8 банок "
      + "в каждом листинге.",
    listingCount: null,
    packCount: null,
  });
  assert.equal(intent.listing_count, 20);
  assert.equal(intent.pack_count, 8);
  assert.equal(intent.flavors_per_listing, 2);
  assert.equal(intent.units_per_flavor, 4);
  assert.deepEqual(intent.blockers, []);
});

test("English asks for a mix too", () => {
  const intent = resolveWalmartStudioRequestIntent({
    prompt: "build 10 listings, pack of 6, 3 flavors, 2 cans of each",
    listingCount: null,
    packCount: null,
  });
  assert.equal(intent.flavors_per_listing, 3);
  assert.equal(intent.units_per_flavor, 2);
});

test("a plain multipack reports one flavor filling the pack", () => {
  const intent = resolveWalmartStudioRequestIntent({
    prompt: "5 листингов по 8 банок",
    listingCount: null,
    packCount: null,
  });
  assert.equal(intent.flavors_per_listing, 1);
  assert.equal(intent.units_per_flavor, 8);
});

test("a mix that does not divide the pack is a blocker, never a silent fallback", () => {
  // The operator overrode Units to 9 while the prompt still says 2 kinds of 4.
  const intent = resolveWalmartStudioRequestIntent({
    prompt: "20 листингов по 8 банок, по 2 вида, по 4 банки каждого",
    listingCount: null,
    packCount: 9,
  });
  assert.equal(intent.flavors_per_listing, 1);
  assert.ok(intent.blockers.some((b) => b.code === "PACK_COMPOSITION_CONFLICT"));
});

test("swapping a sealed item's evidence for the same variant is refused", () => {
  // Independent review 2026-08-08: the seal skipped `components` for a plain
  // multipack and the parser only compared the canonical variant, so an
  // admitted item could have its donor and both observations replaced by a
  // different source that resolves to the same variant — and the old SHA still
  // verified. The engine reads the component fields, so that swapped the
  // actual source after admission.
  const [sealed] = buildWalmartStudioDraftWorkItems({
    ...BASE, candidates: pool(1), listingCount: 1, packCount: 8,
  });
  const swapped = {
    ...sealed,
    components: [{
      ...sealed.components[0],
      donor_product_id: "donor-impostor",
      content_observation_id: "content-impostor",
      price_observation_id: "price-impostor",
    }],
  };
  assert.throws(
    () => parseWalmartStudioDraftWorkItem(swapped),
    (error: unknown) => {
      assert.ok(error instanceof WalmartStudioDraftContractError);
      // Either gate is a correct refusal: the fields no longer agree with the
      // singular ones, and the bytes no longer match the seal.
      assert.match(error.message, /differs|bytes changed after admission/);
      return true;
    },
  );
});

// ── Shipping package: one box, one carton allowance ─────────────────────────

test("an assortment is boxed once, not once per flavor", () => {
  // Re-review 2026-08-08: estimating each flavor separately and adding the
  // results charged the 6 oz carton and the 15% retail tare once per flavor,
  // then chose a box sized for the largest single flavor. A live
  // 4 x 10.5 oz + 4 x 18.8 oz set came out 146.8 oz in a 9x6x6 instead of
  // 140.8 oz in a 10x8x6 — heavier than real, in a carton too small to hold it.
  const grams = (oz: number) => oz * 28.349523125;
  const mixed = estimateWalmartStudioShippingPackage({
    sizeDimension: "MASS",
    sizeBaseUnit: "g",
    sizeBaseAmount: grams(10.5),
    packCount: 4,
    additional: [{
      sizeDimension: "MASS",
      sizeBaseUnit: "g",
      sizeBaseAmount: grams(18.8),
      packCount: 4,
    }],
  });
  assert.equal(mixed.package_weight_oz, 140.8);
  assert.deepEqual(
    [mixed.package_length_in, mixed.package_width_in, mixed.package_height_in],
    [10, 8, 6],
  );

  // Adding the two separate estimates is what used to happen; it must not be
  // what the mixed estimate returns.
  const first = estimateWalmartStudioShippingPackage({
    sizeDimension: "MASS", sizeBaseUnit: "g", sizeBaseAmount: grams(10.5), packCount: 4,
  });
  const second = estimateWalmartStudioShippingPackage({
    sizeDimension: "MASS", sizeBaseUnit: "g", sizeBaseAmount: grams(18.8), packCount: 4,
  });
  assert.notEqual(
    mixed.package_weight_oz,
    first.package_weight_oz + second.package_weight_oz,
  );
});

test("a single-product pack is estimated exactly as before", () => {
  const grams = (oz: number) => oz * 28.349523125;
  const plain = estimateWalmartStudioShippingPackage({
    sizeDimension: "MASS", sizeBaseUnit: "g", sizeBaseAmount: grams(10.5), packCount: 8,
  });
  const stated = estimateWalmartStudioShippingPackage({
    sizeDimension: "MASS", sizeBaseUnit: "g", sizeBaseAmount: grams(10.5), packCount: 8,
    additional: [],
  });
  assert.deepEqual(stated, plain);
});

// ── One POST means one POST ─────────────────────────────────────────────────

test("a feed POST is never repeated by the transport", async () => {
  // Third review 2026-08-08: the client retried POST /feeds on 5xx, 429 and
  // network errors, so a single publish call could put the same item into
  // Walmart's catalog twice — the exact thing "one SKU, one POST, zero retry"
  // forbids. An unknown outcome is resolved by reading, never by resending.
  const { walmartRequestIsUnrepeatable } = await import("@/lib/walmart/client");
  assert.equal(walmartRequestIsUnrepeatable("POST", "/feeds", {}), true);
  assert.equal(walmartRequestIsUnrepeatable("POST", "feeds?feedType=MP_ITEM", {}), true);
  // Reading a feed is safe to retry — that is how an unknown outcome is settled.
  assert.equal(walmartRequestIsUnrepeatable("GET", "/feeds/abc", {}), false);
  // And any request can opt out explicitly.
  assert.equal(walmartRequestIsUnrepeatable("POST", "/items", { noRetry: true }), true);
  assert.equal(walmartRequestIsUnrepeatable("POST", "/items", {}), false);
});
