import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

import {
  walmartListingIntegritySha256,
} from "../listing-integrity-audit.ts";
import {
  assertWalmartListingRepairLiveQualificationSourceRelease,
  qualifyWalmartListingRepairFreshLive,
} from "../listing-integrity-remediation-live-qualification.ts";
import type {
  SealedWalmartListingRepairPlan,
} from "../listing-integrity-remediation-qualification.ts";

const H = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const CURRENT_RELEASE =
  "7f418e7c108783882a302ea48a7777e63a712a663279b3afaeb3f9fcb63aaf81";
const URLS = [
  "https://i5.walmartimages.com/main.png",
  "https://i5.walmartimages.com/gallery-1.jpg",
  "https://i5.walmartimages.com/gallery-2.jpg",
];
const IMAGE_BYTES = [Buffer.from("main"), Buffer.from("gallery-1"), Buffer.from("gallery-2")];
const IMAGE_SHA = IMAGE_BYTES.map((value) => H(value.toString()));
const DESCRIPTION =
  "PACK OF 6: This listing includes six 14 oz bags of Pepperidge Farm Bakery Classics "
  + "Top Sliced Butter Hot Dog Buns. Each bag contains 8 buns, for 48 buns total.";
const BULLETS = [
  "QUALITY INGREDIENTS: Made with real butter",
  "PERFECT BUNS: Top Sliced Butter Hot Dog Buns",
  "PACK OF 6: Includes 6 bags; each 14 oz bag contains 8 buns",
];
const TITLE = "Pepperidge Farm Butter Hot Dog Buns, Top Sliced (Pack of 6)";

function plan(input: {
  changed_fields?: ["description", "bullets"] | ["description", "bullets", "main"]
    | ["description", "bullets", "main", "gallery"]
    | ["attributes"];
  main_url?: string;
  main_sha256?: string;
} = {}): SealedWalmartListingRepairPlan {
  const value = {
    schema_version: "walmart-listing-integrity-repair-plan/v2",
    plan_id: "plan-live-qualification",
    verifier_engine_release_sha256: CURRENT_RELEASE,
    apply_engine_release_sha256: CURRENT_RELEASE,
    listing: {
      channel: "WALMART_US",
      store_index: 1,
      sku: "SKU-1",
      listing_key: "walmart:1:SKU-1",
      item_id: "12345",
    },
    target: {
      surface: {
        title: TITLE,
        description: DESCRIPTION,
        bullets: BULLETS,
        attribute_claims: [
          { field_path: "review.brand", kind: "brand", text: "Pepperidge Farm" },
          {
            field_path: "review.product",
            kind: "product",
            text: "Bakery Classics Top Sliced Butter Hot Dog Buns",
          },
          { field_path: "review.variant", kind: "variant", text: "Butter, Top Sliced" },
          { field_path: "review.outer_units", kind: "outer_units", value: 6, unit: "count" },
          { field_path: "review.net", kind: "net_content", value: 14, unit: "oz" },
          { field_path: "review.inner", kind: "inner_item_count", value: 8, unit: "count" },
        ],
        unmapped_attributes: [],
      },
      images: [
        {
          slot: "main",
          source_url: input.main_url ?? URLS[0],
          sha256: input.main_sha256 ?? IMAGE_SHA[0],
        },
        { slot: "gallery-1", source_url: URLS[1], sha256: IMAGE_SHA[1] },
        { slot: "gallery-2", source_url: URLS[2], sha256: IMAGE_SHA[2] },
      ],
      target_sha256: H("target"),
    },
    changed_fields: input.changed_fields ?? ["description", "bullets"],
    body_sha256: H("plan"),
  };
  return value as unknown as SealedWalmartListingRepairPlan;
}

function attributePlan(): SealedWalmartListingRepairPlan {
  const value = structuredClone(plan({ changed_fields: ["attributes"] }));
  value.target.surface.attribute_claims = [
    {
      field_path: "product.specifications[0].Brand",
      kind: "brand",
      text: "Pepperidge Farm",
    },
    {
      field_path: "product.specifications[1].Flavor",
      kind: "variant",
      text: "Butter",
    },
    {
      field_path: "product.specifications[2].Count",
      kind: "inner_item_count",
      value: 6,
      unit: "count",
    },
    {
      field_path: "walmart.Visible.countPerPack",
      kind: "inner_item_count",
      value: 1,
      unit: "count",
    },
    {
      field_path: "walmart.Visible.multipackQuantity",
      kind: "outer_units",
      value: 6,
      unit: "count",
    },
  ];
  value.target.surface.unmapped_attributes = [{
    field_path: "product.specifications[4].Product net content parent",
    value_sha256: walmartListingIntegritySha256("14 Ounces"),
  }];
  return value as SealedWalmartListingRepairPlan;
}

async function fixture(input: {
  terminal_at?: string;
  captured_at?: string;
  description?: string;
  main_image_bytes?: Uint8Array;
  main_image_url?: string;
  gallery_image_bytes?: [Uint8Array, Uint8Array];
  gallery_image_urls?: [string, string];
  multipack_quantity?: number;
  seller_grouping_quantity?: number;
  flavor?: string;
  count?: number;
} = {}) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "walmart-live-qualification-")),
  );
  await mkdir(path.join(root, "assets"));
  const terminalAt = input.terminal_at ?? "2030-01-01T00:00:00.000Z";
  const capturedAt = input.captured_at ?? "2030-01-01T00:01:00.000Z";
  const buyer = {
    product: {
      item_id: "12345",
      product_url: "https://www.walmart.com/ip/example/12345",
      title: TITLE,
      description: input.description ?? DESCRIPTION,
      feature_bullets: BULLETS,
      main_image: input.main_image_url ?? URLS[0],
      images: [
        input.main_image_url ?? URLS[0],
        ...(input.gallery_image_urls ?? [URLS[1]!, URLS[2]!]),
      ],
      specifications: [
        { name: "Brand", value: "Pepperidge Farm" },
        { name: "Flavor", value: input.flavor ?? "Butter" },
        { name: "Count", value: String(input.count ?? 8) },
        {
          name: "Multipack quantity",
          value: String(input.multipack_quantity ?? 6),
        },
        { name: "Product net content parent", value: "14 Ounces" },
      ],
    },
  };
  const seller = {
    ItemResponse: [{
      mart: "WALMART_US",
      sku: "SKU-1",
      publishedStatus: "PUBLISHED",
      lifecycleStatus: "ACTIVE",
      variantGroupInfo: {
        groupingAttributes: [{
          name: "number_of_pieces",
          value: String(input.seller_grouping_quantity ?? 6),
        }],
      },
    }],
  };
  const catalog = { items: [{ itemId: "12345" }] };
  const mainImageBytes = Buffer.from(input.main_image_bytes ?? IMAGE_BYTES[0]);
  const fileValues = [
    ["buyer_pdp_payload", "buyer-pdp.json", Buffer.from(`${JSON.stringify(buyer)}\n`)],
    ["seller_item_payload", "seller-item.json", Buffer.from(`${JSON.stringify(seller)}\n`)],
    ["catalog_search_payload", "catalog-search.json", Buffer.from(`${JSON.stringify(catalog)}\n`)],
    ["buyer_image_main", "assets/main.png", mainImageBytes],
    [
      "buyer_image_gallery_1",
      "assets/gallery-1.jpg",
      Buffer.from(input.gallery_image_bytes?.[0] ?? IMAGE_BYTES[1]),
    ],
    [
      "buyer_image_gallery_2",
      "assets/gallery-2.jpg",
      Buffer.from(input.gallery_image_bytes?.[1] ?? IMAGE_BYTES[2]),
    ],
  ] as const;
  const files = [];
  for (const [role, relative, bytes] of fileValues) {
    await writeFile(path.join(root, relative), bytes);
    files.push({
      role,
      path: relative,
      file_sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
    });
  }
  const indexBody = {
    schema_version: "walmart-listing-single-intake-index/v1",
    created_at: capturedAt,
    listing_key: "walmart:1:SKU-1",
    status: "CAPTURED_SOURCE_REQUIRED",
    files,
  };
  const index = { ...indexBody, body_sha256: walmartListingIntegritySha256(indexBody) };
  await writeFile(path.join(root, "intake-index.json"), `${JSON.stringify(index)}\n`);
  const ledger = {
    state: "SUCCEEDED",
    terminal_sha256: H("terminal"),
    head_sha256: H("head"),
    receipt: {
      state: "SUCCEEDED",
      authorization_sha256: H("permit"),
      terminal_at: terminalAt,
      feed_id: "feed-1",
      request_payload_sha256: H("payload"),
      feed_status_payload_sha256: H("feed-status"),
    },
  };
  const custody = { inventory_sha256: H("inventory") };
  const capture = {
    status: "CAPTURED_SOURCE_REQUIRED",
    execution: {
      product_truth_reads: 1,
      walmart_logical_gets: 2,
      buyer_pdp_gets: 1,
      image_gets: 3,
      model_calls: 0,
      database_writes: 0,
      walmart_writes: 0,
    },
  };
  return { root, ledger, custody, capture, capturedAt };
}

test("fresh frozen live reread unblocks the next SKU only on exact target PASS", async () => {
  const fx = await fixture();
  const result = await qualifyWalmartListingRepairFreshLive({
    plan: plan(),
    permit_authorization_sha256: H("permit"),
    ledger_evidence: fx.ledger,
    artifact_custody_evidence: fx.custody,
    fresh_capture_directory: fx.root,
    capture_summary: fx.capture,
    evaluated_at: new Date("2030-01-01T00:02:00.000Z"),
  });
  assert.equal(result.verdict, "PASS");
  assert.equal(result.next_sku_unblocked, true);
  assert.equal(result.next_action, "ADVANCE_TO_NEXT_SKU");
  assert.deepEqual(Object.values(result.facets), Array(Object.keys(result.facets).length).fill("PASS"));
  assert.equal(result.external_effects.walmart_writes, 0);
});

test("a mismatch inside the propagation window remains no-write PENDING", async () => {
  const fx = await fixture({ description: "Old description without outer pack facts" });
  const result = await qualifyWalmartListingRepairFreshLive({
    plan: plan(),
    permit_authorization_sha256: H("permit"),
    ledger_evidence: fx.ledger,
    artifact_custody_evidence: fx.custody,
    fresh_capture_directory: fx.root,
    capture_summary: fx.capture,
    evaluated_at: new Date("2030-01-01T00:02:00.000Z"),
  });
  assert.equal(result.verdict, "PENDING_PROPAGATION");
  assert.equal(result.next_sku_unblocked, false);
  assert.equal(result.next_action, "RECHECK_SAME_SKU_NO_WRITE");
});

test("attribute-only live Qualification PASSes only after exact buyer-visible propagation", async () => {
  const fx = await fixture({ count: 6, multipack_quantity: 6 });
  const result = await qualifyWalmartListingRepairFreshLive({
    plan: attributePlan(),
    permit_authorization_sha256: H("permit"),
    ledger_evidence: fx.ledger,
    artifact_custody_evidence: fx.custody,
    fresh_capture_directory: fx.root,
    capture_summary: fx.capture,
    evaluated_at: new Date("2030-01-01T00:02:00.000Z"),
  });
  assert.equal(result.verdict, "PASS");
  assert.equal(result.facets.attributes, "PASS");
  assert.equal(result.facets.unchanged_fields_preserved, "PASS");
  assert.equal(result.next_sku_unblocked, true);
});

test("attribute-only live Qualification remains no-write PENDING on the stale buyer surface", async () => {
  const fx = await fixture({ count: 8, flavor: "qty 6", multipack_quantity: 6 });
  const result = await qualifyWalmartListingRepairFreshLive({
    plan: attributePlan(),
    permit_authorization_sha256: H("permit"),
    ledger_evidence: fx.ledger,
    artifact_custody_evidence: fx.custody,
    fresh_capture_directory: fx.root,
    capture_summary: fx.capture,
    evaluated_at: new Date("2030-01-01T00:02:00.000Z"),
  });
  assert.equal(result.verdict, "PENDING_PROPAGATION");
  assert.equal(result.facets.attributes, "FAIL");
  assert.equal(result.next_action, "RECHECK_SAME_SKU_NO_WRITE");
  assert.equal(result.external_effects.walmart_writes, 0);
});

test("a mismatched reread after the former two-hour window remains PENDING under Walmart's SLA", async () => {
  const fx = await fixture({
    captured_at: "2030-01-01T03:00:00.000Z",
    description: "Old description without outer pack facts",
  });
  const result = await qualifyWalmartListingRepairFreshLive({
    plan: plan(),
    permit_authorization_sha256: H("permit"),
    ledger_evidence: fx.ledger,
    artifact_custody_evidence: fx.custody,
    fresh_capture_directory: fx.root,
    capture_summary: fx.capture,
    evaluated_at: new Date("2030-01-01T03:01:00.000Z"),
  });
  assert.equal(result.verdict, "PENDING_PROPAGATION");
  assert.equal(result.next_sku_unblocked, false);
  assert.equal(result.next_action, "RECHECK_SAME_SKU_NO_WRITE");
});

test("a mismatched reread after the six-hour failure window halts on FAIL", async () => {
  const fx = await fixture({
    captured_at: "2030-01-01T06:01:00.000Z",
    description: "Old description without outer pack facts",
  });
  const result = await qualifyWalmartListingRepairFreshLive({
    plan: plan(),
    permit_authorization_sha256: H("permit"),
    ledger_evidence: fx.ledger,
    artifact_custody_evidence: fx.custody,
    fresh_capture_directory: fx.root,
    capture_summary: fx.capture,
    evaluated_at: new Date("2030-01-01T06:02:00.000Z"),
  });
  assert.equal(result.verdict, "FAIL");
  assert.equal(result.next_sku_unblocked, false);
  assert.equal(result.next_action, "OWNER_REVIEW_REPLAN");
});

test("reviewed MAIN accepts only a SHA-bound perceptually identical Walmart rehost", async () => {
  const candidate = await sharp({
    create: {
      width: 96,
      height: 96,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  }).composite([{
    input: Buffer.from(
      '<svg width="96" height="96"><rect x="10" y="18" width="30" height="60" fill="#1268b3"/><rect x="56" y="18" width="30" height="60" fill="#1268b3"/></svg>',
    ),
  }]).png({ compressionLevel: 0 }).toBuffer();
  const rehosted = await sharp(candidate).png({ compressionLevel: 9 }).toBuffer();
  assert.notEqual(H(candidate), H(rehosted));
  const fx = await fixture({
    main_image_bytes: rehosted,
    main_image_url: "https://i5.walmartimages.com/rehosted-main.png",
    multipack_quantity: 6,
    seller_grouping_quantity: 4,
  });
  const result = await qualifyWalmartListingRepairFreshLive({
    plan: plan({
      changed_fields: ["description", "bullets", "main"],
      main_url: "https://owner.example/exact-reviewed-main.png",
      main_sha256: H(candidate),
    }),
    permit_authorization_sha256: H("permit"),
    ledger_evidence: fx.ledger,
    artifact_custody_evidence: fx.custody,
    fresh_capture_directory: fx.root,
    capture_summary: fx.capture,
    evaluated_at: new Date("2030-01-01T00:02:00.000Z"),
    target_main_bytes: candidate,
  });
  assert.equal(result.verdict, "PASS");
  assert.equal(result.facets.main, "PASS");
  assert.equal(result.facets.gallery, "PASS");
  assert.equal(result.main_equivalence.mode, "WALMART_REHOSTED_EQUIVALENT");
  assert.equal(result.main_equivalence.dhash_distance, 0);
  assert.equal(result.main_equivalence.equivalent, true);
  assert.equal(result.quantity_evidence.buyer_multipack_quantity, 6);
  assert.equal(result.quantity_evidence.seller_grouping_number_of_pieces, 4);
  assert.equal(result.quantity_evidence.seller_grouping_used_as_offer_quantity, false);
  assert.equal(result.external_effects.target_main_gets, 1);
});

test("reviewed image-set Qualification accepts exact target MAIN and gallery", async () => {
  const main = await sharp({
    create: {
      width: 96,
      height: 96,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  }).png().toBuffer();
  const fx = await fixture({ main_image_bytes: main });
  const result = await qualifyWalmartListingRepairFreshLive({
    plan: plan({
      changed_fields: ["description", "bullets", "main", "gallery"],
      main_sha256: H(main),
    }),
    permit_authorization_sha256: H("permit"),
    ledger_evidence: fx.ledger,
    artifact_custody_evidence: fx.custody,
    fresh_capture_directory: fx.root,
    capture_summary: fx.capture,
    evaluated_at: new Date("2030-01-01T00:02:00.000Z"),
    target_main_bytes: main,
  });
  assert.equal(result.verdict, "PASS");
  assert.equal(result.facets.main, "PASS");
  assert.equal(result.facets.gallery, "PASS");
  assert.equal(result.facets.unchanged_fields_preserved, "PASS");
  assert.equal(result.next_sku_unblocked, true);
});

test("reviewed image-set Qualification rejects gallery drift", async () => {
  const main = await sharp({
    create: {
      width: 96,
      height: 96,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  }).png().toBuffer();
  const fx = await fixture({
    main_image_bytes: main,
    gallery_image_bytes: [Buffer.from("wrong-gallery"), IMAGE_BYTES[2]],
  });
  const result = await qualifyWalmartListingRepairFreshLive({
    plan: plan({
      changed_fields: ["description", "bullets", "main", "gallery"],
      main_sha256: H(main),
    }),
    permit_authorization_sha256: H("permit"),
    ledger_evidence: fx.ledger,
    artifact_custody_evidence: fx.custody,
    fresh_capture_directory: fx.root,
    capture_summary: fx.capture,
    evaluated_at: new Date("2030-01-01T00:02:00.000Z"),
    target_main_bytes: main,
  });
  assert.equal(result.verdict, "PENDING_PROPAGATION");
  assert.equal(result.facets.main, "PASS");
  assert.equal(result.facets.gallery, "FAIL");
  assert.equal(result.next_sku_unblocked, false);
});

test("reviewed MAIN does not accept a different image under a Walmart URL", async () => {
  const candidate = await sharp({
    create: {
      width: 96,
      height: 96,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  }).composite([{
    input: Buffer.from(
      '<svg width="96" height="96"><rect x="10" y="18" width="30" height="60" fill="#1268b3"/><rect x="56" y="18" width="30" height="60" fill="#1268b3"/></svg>',
    ),
  }]).png().toBuffer();
  const wrong = await sharp({
    create: {
      width: 96,
      height: 96,
      channels: 3,
      background: { r: 180, g: 20, b: 20 },
    },
  }).png().toBuffer();
  const fx = await fixture({
    main_image_bytes: wrong,
    main_image_url: "https://i5.walmartimages.com/wrong-main.png",
  });
  const result = await qualifyWalmartListingRepairFreshLive({
    plan: plan({
      changed_fields: ["description", "bullets", "main"],
      main_url: "https://owner.example/exact-reviewed-main.png",
      main_sha256: H(candidate),
    }),
    permit_authorization_sha256: H("permit"),
    ledger_evidence: fx.ledger,
    artifact_custody_evidence: fx.custody,
    fresh_capture_directory: fx.root,
    capture_summary: fx.capture,
    evaluated_at: new Date("2030-01-01T00:02:00.000Z"),
    target_main_bytes: candidate,
  });
  assert.equal(result.verdict, "PENDING_PROPAGATION");
  assert.equal(result.facets.main, "FAIL");
  assert.equal(result.main_equivalence.equivalent, false);
});

test("live Qualification rejects a source release outside current and exact predecessor", () => {
  const invalid = structuredClone(plan());
  invalid.verifier_engine_release_sha256 = "b".repeat(64);
  invalid.apply_engine_release_sha256 = "b".repeat(64);
  assert.throws(
    () => assertWalmartListingRepairLiveQualificationSourceRelease(invalid),
    /unpinned current\/predecessor source release/,
  );
});
