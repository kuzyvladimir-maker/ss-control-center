import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import sharp from "sharp";

import {
  classifyWalmartSingleDiagnostic,
  diagnoseWalmartSingleListing,
  projectProductTruthForWalmartSingleListing,
} from "../listing-integrity-single-pipeline.ts";
import {
  captureWalmartBuyerSnapshot,
  writeImmutableWalmartBuyerSnapshot,
} from "../buyer-facing-snapshot.ts";
import { resolveExactWalmartItemCandidate } from "../exact-item-resolution.ts";
import { walmartListingIntegrityImageId } from "../listing-integrity-audit.ts";
import type { BlindObservation } from "../catalog-visual-audit.ts";
import type { ProductTruthSnapshot } from "../../sourcing/product-truth-read-contract.ts";
import {
  executeLiveWalmartListingSingleObservation,
  executeWalmartListingSingleProcess,
  parseWalmartListingSingleProcessArgs,
} from "../../../../scripts/walmart-listing-integrity-process.ts";
import {
  captureWalmartListingSingleIntake,
  writeWalmartListingSingleIntake,
} from "../listing-integrity-single-intake.ts";
import { projectWalmartPublicBuyerPdpHtml } from "../public-buyer-pdp.ts";
import {
  WALMART_LISTING_SINGLE_OBSERVER_WORKER_CONTRACT,
  buildWalmartListingSingleObserverPlan,
  buildWalmartListingSingleObserverRequest,
  verifyWalmartListingSingleWorkerResponse,
} from "../listing-integrity-single-observer.ts";
import {
  compileWalmartListingDeclaredConsistency,
} from "../listing-integrity-declared-consistency.ts";

const require = createRequire(import.meta.url);
const visionContract = require("../../../../ops/codex-image-worker/vision-contract.js");

function snapshot(overrides: {
  qty?: number;
  donorOuter?: number;
  ready?: boolean;
  content?: boolean;
  componentCount?: number;
  evidenceStatus?: "FACT" | "MANUAL_FACT" | "ESTIMATE" | "REJECT";
} = {}): ProductTruthSnapshot {
  const component = {
    componentEvidenceId: "evidence-1",
    componentIndex: 0,
    product: "Farmhouse Homestyle Oat Bread",
    flavor: "Homestyle Oat",
    size: "24 oz",
    qty: overrides.qty ?? 6,
    targetCanonicalVariantId: "variant-oat-24oz",
    evidenceStatus: overrides.evidenceStatus ?? "FACT",
    content: overrides.content === false ? null : {
      canonicalVariantId: "variant-oat-24oz",
      identity: {
        variantKey: "pepperidge-farm|farmhouse|homestyle-oat|680.388g",
        identityHash: "a".repeat(64),
        keyVersion: "v1",
        brand: "Pepperidge Farm",
        productLine: "Farmhouse Bread",
        flavor: "Homestyle Oat",
        modifiers: [],
        form: "Loaf",
        sizeDimension: "MASS" as const,
        sizeBaseAmount: 680.388,
        sizeBaseUnit: "g" as const,
        outerPackCount: overrides.donorOuter ?? 1,
        identity: {},
      },
      facts: {
        title: "Pepperidge Farm Farmhouse Homestyle Oat Bread, 24 oz",
        description: "Exact donor description",
        bullets: [],
        attributes: {},
        nutritionFacts: {},
        ingredients: "Wheat",
        mainImageUrl: "https://i5.walmartimages.com/example.jpeg",
        imageUrls: ["https://i5.walmartimages.com/example.jpeg"],
      },
      provenance: {
        matcherVersion: "canonical-product-match/1.2.1",
        matcherImplementationSha256: "b".repeat(64),
        matcherReleaseSha256: "c".repeat(64),
        contentObservationId: "content-1",
        observationKey: "observation-1",
        donorProductId: "donor-1",
        variantDecisionId: "decision-1",
        decisionEvidenceHash: "d".repeat(64),
        contentHash: "e".repeat(64),
        fieldHashes: {},
        sourceUrl: "https://www.walmart.com/ip/1",
        sourceApi: "walmart",
        observedAt: "2026-07-23T01:00:00.000Z",
        runId: null,
        approvalId: "approval-1",
        meteredReceiptId: null,
      },
    },
    contentBlockers: [],
  };
  const components = Array.from(
    { length: overrides.componentCount ?? 1 },
    (_value, index) => ({ ...component, componentIndex: index }),
  );
  return {
    contractVersion: "product-truth-read-contract/3.2.0",
    snapshot: {
      sku: "SKU-6",
      channel: "walmart",
      storeIndex: 1,
      listingKey: "walmart:1:SKU-6",
      asOf: "2026-07-23T02:00:00.000Z",
      maxPriceAgeMs: 86_400_000,
      skuCostId: "cost-1",
    },
    recipe: { components, blockers: [] },
    views: {
      bundleFactory: {
        consumer: "BUNDLE_FACTORY",
        ready: true,
        components,
        blockers: [],
      },
      listingImprovement: {
        consumer: "LISTING_IMPROVEMENT",
        ready: overrides.ready ?? true,
        components,
        blockers: overrides.ready === false ? ["CONTENT_MISSING"] : [],
      },
      unitEconomics: {
        consumer: "UNIT_ECONOMICS",
        status: "FACT",
        current: null,
        factualCost: null,
        estimatedCost: null,
        blockers: [],
      },
      procurement: {
        consumer: "PROCUREMENT",
        ready: false,
        components: [],
        blockers: [],
      },
    },
  };
}

const diagnosticTarget = {
  sku: "SKU-6",
  item_id: "123456789",
};

const diagnosticBuyerPayload = {
  product: {
    item_id: diagnosticTarget.item_id,
    product_url: `https://www.walmart.com/ip/farmhouse-oat/${diagnosticTarget.item_id}`,
    title: "Pepperidge Farm Farmhouse Bread Homestyle Oat Loaf, Pack of 6, 24 oz",
    description:
      "Pepperidge Farm Farmhouse Bread Homestyle Oat Loaf. Pack of 6. Each loaf has net weight 24 oz.",
    feature_bullets: [
      "Pack of 6",
      "Each loaf has net weight 24 oz",
    ],
    main_image: "https://i5.walmartimages.com/main.png",
    images: [{ link: "https://i5.walmartimages.com/nutrition.png" }],
    attributes: {
      Brand: "Pepperidge Farm",
      "Product Type": "Farmhouse Bread",
      Flavor: "Homestyle Oat Loaf",
      "Multipack Quantity": 6,
      "Net Weight": "24 oz",
    },
  },
};

function exactResolution() {
  const title = "Pepperidge Farm Farmhouse Bread Homestyle Oat Loaf, Pack of 6, 24 oz";
  return resolveExactWalmartItemCandidate(diagnosticTarget.sku, {
    ItemResponse: [{
      sku: diagnosticTarget.sku,
      productName: title,
      upc: "123456789012",
      gtin: "00123456789012",
      wpid: "ALPHANUMERIC-WPID",
      publishedStatus: "PUBLISHED",
      lifecycleStatus: "ACTIVE",
    }],
  }, {
    items: [{
      itemId: diagnosticTarget.item_id,
      standardUpc: ["00123456789012"],
      title,
      isMarketPlaceItem: true,
      images: [{ url: "https://i5.walmartimages.com/main.png" }],
    }],
  });
}

function observation(
  imageId: string,
  overrides: Partial<BlindObservation> = {},
): BlindObservation {
  return {
    image_id: imageId,
    visual_role: "tiled_main",
    visible_brand_text: "Pepperidge Farm",
    visible_product_text: "Farmhouse Bread",
    visible_variant_text: "Homestyle Oat Loaf",
    visible_size_texts: ["24 oz"],
    external_package_count: { mode: "exact", value: 6, min: null, max: null },
    outer_package_claims: [],
    inner_contents_claims: [],
    case_package_claims: [],
    unclear_quantity_claims: [],
    grid_cell_kind: "single_sellable_package",
    front_visibility: "all",
    background: "white",
    multiple_distinct_products: "no",
    readable_identity: "clear",
    evidence: ["Six matching packages are visible"],
    flags: [],
    ...overrides,
  };
}

async function diagnosticFixture() {
  const mainPixels = Buffer.from(Array.from(
    { length: 12 * 10 * 3 },
    (_value, index) => Math.floor((index % (12 * 3)) / 3) * 20,
  ));
  const galleryPixels = Buffer.from(Array.from(
    { length: 8 * 14 * 3 },
    (_value, index) => Math.floor(index / (8 * 3)) * 17,
  ));
  const main = await sharp(mainPixels, {
    raw: { width: 12, height: 10, channels: 3 },
  }).png().toBuffer();
  const nutrition = await sharp(galleryPixels, {
    raw: { width: 8, height: 14, channels: 3 },
  }).png().toBuffer();
  const draft = await captureWalmartBuyerSnapshot(diagnosticTarget, {
    async getExactItemResolution() {
      return exactResolution();
    },
    async getBuyerPdpByItemId() {
      return diagnosticBuyerPayload;
    },
    async getImage(url) {
      return {
        status: 200,
        bytes: url.endsWith("main.png") ? main : nutrition,
        final_url: url,
      };
    },
  }, new Date("2026-07-24T12:00:00.000Z"));
  const directory = await mkdtemp(path.join(os.tmpdir(), "wli-single-pipeline-"));
  const sealed = await writeImmutableWalmartBuyerSnapshot(directory, draft);
  const imageBytes = new Map(draft.binary_assets);
  const imageIds = sealed.snapshot.assets.map((asset, index) => (
    walmartListingIntegrityImageId(
      asset.sha256,
      index === 0 ? "main" : `gallery-${index}`,
      "walmart:1:SKU-6",
    )
  ));
  const observations = [
    observation(imageIds[0]!),
    observation(imageIds[1]!),
  ];
  return {
    cleanup: () => rm(directory, { recursive: true, force: true }),
    root: directory,
    buyer_snapshot_path: sealed.manifest_path,
    asset_root: sealed.directory,
    buyer_snapshot: sealed.snapshot,
    image_bytes_by_sha256: imageBytes,
    blind_observations: observations,
  };
}

test("one canonical component becomes exact one-SKU detector truth", () => {
  const result = projectProductTruthForWalmartSingleListing(snapshot());
  assert.equal(result.status, "READY");
  if (result.status !== "READY") return;
  assert.equal(result.expected.outer_units, 6);
  assert.deepEqual(result.expected.identity.brand_aliases, ["Pepperidge Farm"]);
  assert.deepEqual(
    result.expected.identity.product_marker_groups,
    [["Farmhouse Bread", "Farmhouse Homestyle Oat Bread"]],
  );
  assert.deepEqual(result.expected.package_facts, [{
    kind: "net_content",
    requirement: "required",
    value: 680.388,
    unit: "g",
  }]);
});

test("exact canonical content remains usable when price evidence is unsourceable", () => {
  const contentOnly = snapshot({
    evidenceStatus: "REJECT",
  });
  const component = contentOnly.views.listingImprovement.components[0]!;
  component.product = "Hot Dog Buns";
  component.flavor = "White";
  component.content!.identity.brand = "farm pepperidge";
  component.content!.identity.productLine = "bakery buns classics dog hot";
  component.content!.identity.flavor = "white";
  component.content!.identity.form = "bag";
  component.content!.identity.modifiers = ["token:sliced", "token:top"];
  component.content!.facts.title =
    "Pepperidge Farm Bakery Classics Top Sliced White Hot Dog Buns - 14oz/8ct";
  const result = projectProductTruthForWalmartSingleListing(contentOnly);
  assert.equal(result.status, "READY");
  if (result.status !== "READY") return;
  assert.equal(result.adapter_version, "walmart-listing-single-pipeline-truth-adapter/v5");
  assert.equal(result.expected.outer_units, 6);
  assert.deepEqual(result.expected.identity.brand_aliases, [
    "Pepperidge Farm",
    "farm pepperidge",
  ]);
  assert.deepEqual(result.expected.identity.variant_marker_groups, [
    ["white"],
    ["sliced"],
    ["top"],
  ]);
  assert.deepEqual(result.blockers, []);
});

test("product aliases are deduplicated after detector normalization", () => {
  const duplicateCaseAlias = snapshot();
  const component = duplicateCaseAlias.views.listingImprovement.components[0]!;
  component.content!.identity.productLine = "condensed soup";
  component.product = "Condensed Soup";
  const result = projectProductTruthForWalmartSingleListing(duplicateCaseAlias);
  assert.equal(result.status, "READY");
  if (result.status !== "READY") return;
  assert.deepEqual(result.expected.identity.product_marker_groups, [["condensed soup"]]);
});

test("a multipack donor is rejected instead of becoming a multipack-of-multipacks", () => {
  const result = projectProductTruthForWalmartSingleListing(snapshot({ donorOuter: 2 }));
  assert.equal(result.status, "SOURCE_REQUIRED");
  assert.equal(
    result.blockers.includes("CONTENT_DONOR_IS_NOT_ONE_OUTER_PACKAGE:2"),
    true,
  );
});

test("missing canonical content never falls back to the Walmart title", () => {
  const result = projectProductTruthForWalmartSingleListing(snapshot({ content: false }));
  assert.equal(result.status, "SOURCE_REQUIRED");
  assert.equal(result.blockers.includes("EXACT_CONTENT_MISSING"), true);
});

test("mixed or multi-component recipes do not enter the same-product repair lane", () => {
  const result = projectProductTruthForWalmartSingleListing(snapshot({ componentCount: 2 }));
  assert.equal(result.status, "SOURCE_REQUIRED");
  assert.equal(
    result.blockers.includes("SAME_PRODUCT_PIPELINE_REQUIRES_ONE_COMPONENT:FOUND_2"),
    true,
  );
});

test("full one-SKU diagnostic proves a wrong MAIN package count is BAD", async () => {
  const fixture = await diagnosticFixture();
  try {
    fixture.blind_observations[0] = observation(
      fixture.blind_observations[0]!.image_id,
      {
        external_package_count: { mode: "exact", value: 1, min: null, max: null },
        outer_package_claims: [],
        grid_cell_kind: "single_sellable_package",
        evidence: ["Only one package is visible"],
      },
    );
    const result = await diagnoseWalmartSingleListing({
      product_truth: snapshot(),
      buyer_snapshot: fixture.buyer_snapshot,
      buyer_pdp_payload: diagnosticBuyerPayload,
      image_bytes_by_sha256: fixture.image_bytes_by_sha256,
      blind_observations: fixture.blind_observations,
    });
    assert.equal(result.status, "DIAGNOSED");
    if (result.status !== "DIAGNOSED") return;
    assert.equal(result.report.overall_verdict, "BAD");
    assert.equal(result.report.main_decision.verdict, "BAD");
    assert.equal("checks" in result.report.main_decision, true);
    if ("checks" in result.report.main_decision) {
      assert.equal(result.report.main_decision.checks.external_quantity, "MISMATCH");
    }
    assert.equal(result.report.assurance.marketplace_writes, 0);
    assert.equal(result.report.assurance.model_calls, 0);
    const outcome = classifyWalmartSingleDiagnostic(result);
    assert.equal(outcome.status, "BAD");
    assert.equal(outcome.next_step, "BUILD_REPAIR_PREVIEW");
  } finally {
    await fixture.cleanup();
  }
});

test("full diagnostic accepts possessive brand, interleaved title tokens, and observer role drift", async () => {
  const fixture = await diagnosticFixture();
  try {
    const truth = snapshot();
    const component = truth.views.listingImprovement.components[0]!;
    component.product = "Condensed Soup";
    component.flavor = "Golden Mushroom";
    component.content!.identity.brand = "campbells";
    component.content!.identity.productLine = "condensed soup";
    component.content!.identity.flavor = "golden mushroom";
    component.content!.identity.sizeBaseAmount = 297.6699928125;
    component.content!.facts.title =
      "Campbell's Condensed Golden Mushroom Soup, 10.5 oz Can";
    const payload = structuredClone(diagnosticBuyerPayload);
    payload.product.title =
      "Campbell's Condensed Golden Mushroom Soup, 10.5 oz Can (Pack of 6)";
    payload.product.description =
      "Campbell's Condensed Golden Mushroom Soup. Pack of 6. Each can is 10.5 oz.";
    payload.product.feature_bullets = [
      "Campbell's Golden Mushroom condensed soup",
      "Pack of 6",
    ];
    payload.product.attributes = {
      Brand: "Campbell's",
      "Product Type": "Condensed Soup",
      Flavor: "Golden Mushroom",
      "Multipack Quantity": 6,
      "Net Weight": "10.5 oz",
    };
    fixture.blind_observations[0] = observation(
      fixture.blind_observations[0]!.image_id,
      {
        visible_brand_text: "Campbell's",
        visible_product_text: "Golden Mushroom Soup",
        visible_variant_text: "Condensed",
        visible_size_texts: ["10.5 oz"],
      },
    );
    fixture.blind_observations[1] = observation(
      fixture.blind_observations[1]!.image_id,
      {
        visual_role: "single_product_front",
        visible_brand_text: "Campbell's",
        visible_product_text: "Golden Mushroom Soup",
        visible_variant_text: "Condensed",
        visible_size_texts: ["10.5 oz"],
        external_package_count: { mode: "exact", value: 1, min: null, max: null },
      },
    );
    const result = await diagnoseWalmartSingleListing({
      product_truth: truth,
      buyer_snapshot: fixture.buyer_snapshot,
      buyer_pdp_payload: payload,
      image_bytes_by_sha256: fixture.image_bytes_by_sha256,
      blind_observations: fixture.blind_observations,
    });
    assert.equal(result.status, "DIAGNOSED");
    if (result.status !== "DIAGNOSED") return;
    assert.equal(result.report.text_decision.checks.title_identity, "MATCH");
    assert.equal(result.report.main_decision.checks.identity, "MATCH");
    assert.equal(result.report.gallery_decisions[0]?.checks.identity, "MATCH");
  } finally {
    await fixture.cleanup();
  }
});

test("source-blocked self-consistency detects declared Pack of 6 versus one visible MAIN", async () => {
  const fixture = await diagnosticFixture();
  try {
    fixture.blind_observations[0] = observation(
      fixture.blind_observations[0]!.image_id,
      {
        external_package_count: { mode: "exact", value: 1, min: null, max: null },
        grid_cell_kind: "single_sellable_package",
        evidence: ["One sealed retail package is visible"],
      },
    );
    const report = compileWalmartListingDeclaredConsistency({
      listing_key: snapshot().snapshot.listingKey,
      buyer_snapshot: fixture.buyer_snapshot,
      buyer_pdp_payload: diagnosticBuyerPayload,
      blind_observations: fixture.blind_observations,
    });
    assert.equal(report.verdict, "CONTRADICTION");
    assert.equal(report.authority.establishes_product_truth, false);
    assert.equal(report.authority.authorizes_repair, false);
    assert.equal(report.declared_outer_units.value, 6);
    assert.equal(
      report.findings.some((finding) =>
        finding.code === "MAIN_VISIBLE_OUTER_QUANTITY_CONTRADICTS_LIVE_TITLE"
        && finding.slot === "main"
      ),
      true,
    );
    assert.match(report.body_sha256, /^[a-f0-9]{64}$/u);
  } finally {
    await fixture.cleanup();
  }
});

test("source-blocked self-consistency detects a hot-dog-buns listing with a hamburger-buns bullet", async () => {
  const fixture = await diagnosticFixture();
  try {
    const payload = structuredClone(diagnosticBuyerPayload);
    payload.product.feature_bullets.push(
      "PEPPERIDGE FARM BAKES IT BETTER: Pepperidge Farm hamburger buns are carefully crafted",
    );
    payload.product.attributes["Bread & bun type"] = "Hot Dog Buns";
    const report = compileWalmartListingDeclaredConsistency({
      listing_key: snapshot().snapshot.listingKey,
      buyer_snapshot: fixture.buyer_snapshot,
      buyer_pdp_payload: payload,
      blind_observations: fixture.blind_observations,
    });
    assert.equal(report.verdict, "CONTRADICTION");
    assert.equal(
      report.findings.some((finding) =>
        finding.code === "LIVE_BULLET_PRODUCT_CLASS_CONTRADICTS_TITLE_OR_ATTRIBUTE"
      ),
      true,
    );
    assert.equal(report.authority.authorizes_repair, false);
  } finally {
    await fixture.cleanup();
  }
});

test("a visually and textually clean input remains a candidate until source-aware qualification", async () => {
  const fixture = await diagnosticFixture();
  try {
    const result = await diagnoseWalmartSingleListing({
      product_truth: snapshot(),
      buyer_snapshot: fixture.buyer_snapshot,
      buyer_pdp_payload: diagnosticBuyerPayload,
      image_bytes_by_sha256: fixture.image_bytes_by_sha256,
      blind_observations: fixture.blind_observations,
    });
    const outcome = classifyWalmartSingleDiagnostic(result);
    assert.equal(
      outcome.status,
      "CLEAN_CANDIDATE",
      JSON.stringify({
        blocking: outcome.report?.blocking_reasons,
        review: outcome.report?.review_reasons,
        text: outcome.report?.text_decision,
        main: outcome.report?.main_decision,
        gallery: outcome.report?.gallery_decisions,
      }),
    );
    assert.equal(outcome.next_step, "RUN_SOURCE_AWARE_QUALIFICATION");
    assert.equal(outcome.report?.overall_verdict, "REVIEW");
    assert.match(
      outcome.report?.review_reasons.join(" ") ?? "",
      /source artifacts.*not independently verified/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("full one-SKU diagnostic rejects changed image bytes", async () => {
  const fixture = await diagnosticFixture();
  try {
    const mainSha = fixture.buyer_snapshot.assets[0]!.sha256;
    fixture.image_bytes_by_sha256.set(mainSha, new Uint8Array([1, 2, 3]));
    await assert.rejects(() => diagnoseWalmartSingleListing({
      product_truth: snapshot(),
      buyer_snapshot: fixture.buyer_snapshot,
      buyer_pdp_payload: diagnosticBuyerPayload,
      image_bytes_by_sha256: fixture.image_bytes_by_sha256,
      blind_observations: fixture.blind_observations,
    }), /main exact image bytes are missing or changed/);
  } finally {
    await fixture.cleanup();
  }
});

test("full one-SKU diagnostic rejects a buyer snapshot for another SKU", async () => {
  const fixture = await diagnosticFixture();
  try {
    const wrongBuyer = structuredClone(fixture.buyer_snapshot);
    wrongBuyer.target.sku = "OTHER-SKU";
    await assert.rejects(() => diagnoseWalmartSingleListing({
      product_truth: snapshot(),
      buyer_snapshot: wrongBuyer,
      buyer_pdp_payload: diagnosticBuyerPayload,
      image_bytes_by_sha256: fixture.image_bytes_by_sha256,
      blind_observations: fixture.blind_observations,
    }), /buyer snapshot does not prove the exact active published listing/);
  } finally {
    await fixture.cleanup();
  }
});

test("operator command processes one exact SKU evidence set and writes one sealed result", async () => {
  const fixture = await diagnosticFixture();
  try {
    fixture.blind_observations[0] = observation(
      fixture.blind_observations[0]!.image_id,
      {
        external_package_count: { mode: "exact", value: 1, min: null, max: null },
        grid_cell_kind: "single_sellable_package",
        evidence: ["Only one package is visible"],
      },
    );
    const productTruthPath = path.join(fixture.root, "product-truth.json");
    const buyerPdpPath = path.join(fixture.root, "buyer-pdp.json");
    const observationsPath = path.join(fixture.root, "observations.json");
    const outputPath = path.join(fixture.root, "process-result.json");
    await Promise.all([
      writeFile(productTruthPath, `${JSON.stringify(snapshot())}\n`, { flag: "wx" }),
      writeFile(buyerPdpPath, `${JSON.stringify(diagnosticBuyerPayload)}\n`, { flag: "wx" }),
      writeFile(observationsPath, `${JSON.stringify({
        schema_version: "wm_visual_observation_batch/v3",
        observations: fixture.blind_observations,
      })}\n`, { flag: "wx" }),
    ]);
    const result = await executeWalmartListingSingleProcess({
      command: "diagnose",
      product_truth: productTruthPath,
      buyer_snapshot: fixture.buyer_snapshot_path,
      buyer_pdp: buyerPdpPath,
      observations: observationsPath,
      asset_root: fixture.asset_root,
      output: outputPath,
    });
    assert.equal("outcome" in result, true);
    if (!("outcome" in result)) return;
    assert.equal(result.outcome.status, "BAD");
    assert.equal(result.outcome.next_step, "BUILD_REPAIR_PREVIEW");
    assert.match(result.body_sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.assurance, {
      input_files_read_once: true,
      image_sha256_verified: true,
      walmart_reads: 0,
      walmart_writes: 0,
      database_reads: 0,
      database_writes: 0,
      model_calls: 0,
      network_calls: 0,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("review command seals one exact Product Truth diff with image bytes but authorizes no write", async () => {
  const fixture = await diagnosticFixture();
  try {
    const productTruthPath = path.join(fixture.root, "review-product-truth.json");
    const buyerPdpPath = path.join(fixture.root, "review-buyer-pdp.json");
    const observationsPath = path.join(fixture.root, "review-observations.json");
    const diagnosisPath = path.join(fixture.root, "review-diagnosis.json");
    const donorAuditPath = path.join(fixture.root, "review-donor-audit.json");
    const proposalPath = path.join(fixture.root, "review-proposal.json");
    const certificationPath = path.join(fixture.root, "review-certification.json");
    const compilationRequestPath = path.join(
      fixture.root,
      "repair-compilation-request.json",
    );
    const donorAudit = {
      exact_content_candidate: {
        donor_product_id: "donor-exact-oat",
        upc: "123456789012",
        size: "24 oz",
        inner_count: 1,
      },
      current_legacy_component: {
        donor_product_id: "donor-wrong-cookies",
        finding: "WRONG_PRODUCT_DONOR",
        canonical_use_allowed: false,
      },
    };
    await Promise.all([
      writeFile(productTruthPath, `${JSON.stringify(snapshot())}\n`, { flag: "wx" }),
      writeFile(buyerPdpPath, `${JSON.stringify(diagnosticBuyerPayload)}\n`, { flag: "wx" }),
      writeFile(observationsPath, `${JSON.stringify({
        schema_version: "wm_visual_observation_batch/v3",
        observations: fixture.blind_observations,
      })}\n`, { flag: "wx" }),
      writeFile(donorAuditPath, `${JSON.stringify(donorAudit)}\n`, { flag: "wx" }),
    ]);
    const diagnosis = await executeWalmartListingSingleProcess({
      command: "diagnose",
      product_truth: productTruthPath,
      buyer_snapshot: fixture.buyer_snapshot_path,
      buyer_pdp: buyerPdpPath,
      observations: observationsPath,
      asset_root: fixture.asset_root,
      output: diagnosisPath,
    });
    assert.equal("body_sha256" in diagnosis, true);

    const fileSha = async (pathname: string) => createHash("sha256")
      .update(await readFile(pathname))
      .digest("hex");
    const main = fixture.buyer_snapshot.assets[0]!;
    const gallery = fixture.buyer_snapshot.assets.slice(1);
    const proposal = {
      schema_version: "walmart-listing-integrity-owner-repair-review/v1",
      status: "OWNER_REVIEW_REQUIRED",
      authority: {
        mode: "REVIEW_ONLY_NO_WALMART_WRITE",
        authorizes_product_truth_activation: false,
        authorizes_walmart_write: false,
      },
      listing: {
        listing_key: "walmart:1:SKU-6",
        sku: diagnosticTarget.sku,
        item_id: diagnosticTarget.item_id,
        seller_upc: "123456789012",
        published_status: "PUBLISHED",
        lifecycle_status: "ACTIVE",
        title: diagnosticBuyerPayload.product.title,
      },
      exact_product_truth_candidate: {
        donor_product_id: "donor-exact-oat",
        brand: "Pepperidge Farm",
        product: "Farmhouse Bread",
        variant: "Homestyle Oat Loaf",
        single_unit_upc: "123456789012",
        single_unit_size: "24 oz",
        single_unit_inner_count: 1,
        outer_units: 6,
        expected: {
          title: diagnosticBuyerPayload.product.title,
          outer_units: 6,
          identity: {
            brand_aliases: ["Pepperidge Farm"],
            product_marker_groups: [["Farmhouse Bread"]],
            variant_marker_groups: [["Homestyle Oat", "Homestyle Oat Loaf"]],
            forbidden_markers: [{
              role: "product",
              aliases: ["Chessmen Cookies"],
            }],
          },
          package_facts: [{
            kind: "net_content",
            value: 24,
            unit: "oz",
            requirement: "required",
          }],
          truth_source: "manual_verified",
        },
        legacy_wrong_donor_forbidden: {
          donor_product_id: "donor-wrong-cookies",
        },
      },
      fresh_live_evidence: {
        diagnosis_sha256: await fileSha(diagnosisPath),
        buyer_snapshot_sha256: await fileSha(fixture.buyer_snapshot_path),
        buyer_pdp_sha256: await fileSha(buyerPdpPath),
        donor_audit_sha256: await fileSha(donorAuditPath),
        main_image_sha256: main.sha256,
        gallery_image_sha256: gallery.map((asset) => asset.sha256),
      },
      proposed_repair: {
        changed_fields: ["description", "bullets"],
        before: {
          description: diagnosticBuyerPayload.product.description,
          bullets: diagnosticBuyerPayload.product.feature_bullets,
        },
        after: {
          description:
            "PACK OF 6: Pepperidge Farm Farmhouse Bread Homestyle Oat Loaf. "
            + "Six 24 oz loaves are included.",
          bullets: [
            "PACK OF 6: Includes 6 Pepperidge Farm Farmhouse Bread loaves",
            "Homestyle Oat Loaf; each loaf has net weight 24 oz",
          ],
        },
      },
    };
    await writeFile(proposalPath, `${JSON.stringify(proposal)}\n`, { flag: "wx" });

    const certification = await executeWalmartListingSingleProcess({
      command: "review",
      proposal: proposalPath,
      diagnosis: diagnosisPath,
      buyer_snapshot: fixture.buyer_snapshot_path,
      buyer_pdp: buyerPdpPath,
      donor_audit: donorAuditPath,
      asset_root: fixture.asset_root,
      output: certificationPath,
    });
    assert.equal("qualification_precheck" in certification, true);
    if (!("qualification_precheck" in certification)) return;
    assert.equal(certification.status, "OWNER_REVIEW_REQUIRED");
    assert.equal(certification.qualification_precheck, "PASS");
    assert.equal(certification.exact_image_bytes_verified, true);
    assert.equal(certification.marketplace_write_authorized, false);
    assert.equal(certification.database_write_authorized, false);
    assert.deepEqual(certification.assurance, {
      network_calls: 0,
      model_calls: 0,
      database_writes: 0,
      walmart_writes: 0,
    });
    assert.equal((await lstat(certificationPath)).mode & 0o777, 0o400);

    const compilation = await executeWalmartListingSingleProcess({
      command: "prepare-repair",
      proposal: proposalPath,
      diagnosis: diagnosisPath,
      buyer_snapshot: fixture.buyer_snapshot_path,
      buyer_pdp: buyerPdpPath,
      donor_audit: donorAuditPath,
      certification: certificationPath,
      asset_root: fixture.asset_root,
      output: compilationRequestPath,
    });
    assert.equal("repair" in compilation, true);
    if (!("repair" in compilation)) return;
    assert.equal(compilation.status, "READY_FOR_CONNECTED_MATERIALS");
    assert.deepEqual(compilation.repair.changed_fields, ["description", "bullets"]);
    assert.deepEqual(
      compilation.repair.baseline_images,
      compilation.repair.target_images,
    );
    assert.equal(
      compilation.repair.baseline_surface.attribute_claims.every(
        (claim) => !claim.field_path.startsWith("review."),
      ),
      true,
    );
    assert.deepEqual(
      compilation.repair.baseline_surface.attribute_claims,
      compilation.repair.target_surface.attribute_claims,
    );
    assert.deepEqual(
      compilation.repair.baseline_surface.unmapped_attributes,
      compilation.repair.target_surface.unmapped_attributes,
    );
    assert.equal(compilation.repair.unchanged_image_bytes, true);
    assert.equal(compilation.owner_gate.current_walmart_write_authorized, false);
    assert.equal(compilation.owner_gate.current_mass_run_authorized, false);
    assert.match(
      compilation.owner_gate.exact_confirmation,
      /^Подтверждаю SKU-6 и diff [a-f0-9]{8}…[a-f0-9]{5}\. Изменить только description и bullets\.$/u,
    );
    assert.deepEqual(compilation.assurance, {
      network_calls: 0,
      model_calls: 0,
      database_reads: 0,
      database_writes: 0,
      walmart_reads: 0,
      walmart_writes: 0,
    });
    assert.equal((await lstat(compilationRequestPath)).mode & 0o777, 0o400);

    const tamperedCertificationPath = path.join(
      fixture.root,
      "review-certification-tampered.json",
    );
    await writeFile(tamperedCertificationPath, `${JSON.stringify({
      ...certification,
      proposal_sha256: "f".repeat(64),
    })}\n`, { flag: "wx" });
    await assert.rejects(
      executeWalmartListingSingleProcess({
        command: "prepare-repair",
        proposal: proposalPath,
        diagnosis: diagnosisPath,
        buyer_snapshot: fixture.buyer_snapshot_path,
        buyer_pdp: buyerPdpPath,
        donor_audit: donorAuditPath,
        certification: tamperedCertificationPath,
        asset_root: fixture.asset_root,
        output: path.join(fixture.root, "tampered-compilation-must-not-exist.json"),
      }),
      /existing review certification differs/u,
    );

    const exactDonorAuditPath = path.join(
      fixture.root,
      "review-exact-donor-audit.json",
    );
    const exactDonorProposalPath = path.join(
      fixture.root,
      "review-exact-donor-proposal.json",
    );
    const exactDonorCertificationPath = path.join(
      fixture.root,
      "review-exact-donor-certification.json",
    );
    await writeFile(exactDonorAuditPath, `${JSON.stringify({
      exact_content_candidate: donorAudit.exact_content_candidate,
      current_legacy_component: {
        donor_product_id: "donor-exact-oat",
        finding: "EXACT_PRODUCT_DONOR",
        canonical_use_allowed: true,
      },
    })}\n`, { flag: "wx" });
    const exactDonorProposal = structuredClone(proposal);
    delete (
      exactDonorProposal.exact_product_truth_candidate as {
        legacy_wrong_donor_forbidden?: unknown;
      }
    ).legacy_wrong_donor_forbidden;
    exactDonorProposal.fresh_live_evidence.donor_audit_sha256 =
      await fileSha(exactDonorAuditPath);
    await writeFile(
      exactDonorProposalPath,
      `${JSON.stringify(exactDonorProposal)}\n`,
      { flag: "wx" },
    );
    const exactDonorCertification = await executeWalmartListingSingleProcess({
      command: "review",
      proposal: exactDonorProposalPath,
      diagnosis: diagnosisPath,
      buyer_snapshot: fixture.buyer_snapshot_path,
      buyer_pdp: buyerPdpPath,
      donor_audit: exactDonorAuditPath,
      asset_root: fixture.asset_root,
      output: exactDonorCertificationPath,
    });
    assert.equal(
      "qualification_precheck" in exactDonorCertification
        ? exactDonorCertification.qualification_precheck
        : null,
      "PASS",
    );
  } finally {
    await fixture.cleanup();
  }
});

function publicBuyerHtml(
  itemId = diagnosticTarget.item_id,
  primaryItemId: string | null = itemId,
): string {
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: {
      pageProps: {
        initialData: {
          data: {
            product: {
              usItemId: itemId,
              primaryUsItemId: primaryItemId,
              canonicalUrl: `https://www.walmart.com/ip/farmhouse-oat/${itemId}`,
              name: diagnosticBuyerPayload.product.title,
              shortDescription: diagnosticBuyerPayload.product.description,
              imageInfo: {
                allImages: [
                  { url: diagnosticBuyerPayload.product.main_image },
                  { url: diagnosticBuyerPayload.product.images[0]!.link },
                ],
              },
            },
            idml: {
              shortDescription: diagnosticBuyerPayload.product.description,
              longDescription: "<ul><li>Pack of 6</li><li>Each loaf has net weight 24 oz</li></ul>",
              specifications: Object.entries(diagnosticBuyerPayload.product.attributes)
                .map(([name, value]) => ({ name, value: String(value) })),
            },
          },
        },
      },
    },
  })}</script></html>`;
}

test("read-only intake stops at SOURCE_REQUIRED before Walmart, PDP, image, or model work", async () => {
  const calls: string[] = [];
  const result = await captureWalmartListingSingleIntake({
    sku: diagnosticTarget.sku,
    store_index: 1,
  }, {
    async readProductTruth() {
      calls.push("truth");
      return snapshot({ content: false });
    },
    async getExactSellerItem() {
      calls.push("seller");
      return {};
    },
    async getCatalogSearchByUpc() {
      calls.push("catalog");
      return {};
    },
    async getBuyerPdpHtml() {
      calls.push("pdp");
      return "";
    },
    async getImage() {
      calls.push("image");
      return { bytes: new Uint8Array() };
    },
  });
  assert.equal(result.status, "SOURCE_REQUIRED");
  assert.deepEqual(calls, ["truth"]);
  assert.deepEqual(result.execution, {
    product_truth_reads: 1,
    walmart_logical_gets: 0,
    buyer_pdp_gets: 0,
    image_gets: 0,
    model_calls: 0,
    database_writes: 0,
    walmart_writes: 0,
  });
});

test("explicit inspect mode captures live buyer evidence while preserving SOURCE_REQUIRED authority", async () => {
  const main = await sharp({
    create: { width: 5, height: 4, channels: 3, background: "#f0d0a0" },
  }).png().toBuffer();
  const gallery = await sharp({
    create: { width: 4, height: 5, channels: 3, background: "#ffffff" },
  }).png().toBuffer();
  const calls: string[] = [];
  const result = await captureWalmartListingSingleIntake({
    sku: diagnosticTarget.sku,
    store_index: 1,
  }, {
    async readProductTruth() {
      calls.push("truth");
      return snapshot({ content: false });
    },
    async getExactSellerItem() {
      calls.push("seller");
      return {
        ItemResponse: [{
          sku: diagnosticTarget.sku,
          productName: diagnosticBuyerPayload.product.title,
          upc: "123456789012",
          gtin: "00123456789012",
          wpid: "ALPHANUMERIC-WPID",
          publishedStatus: "PUBLISHED",
          lifecycleStatus: "ACTIVE",
        }],
      };
    },
    async getCatalogSearchByUpc() {
      calls.push("catalog");
      return {
        items: [{
          itemId: diagnosticTarget.item_id,
          standardUpc: ["00123456789012"],
          title: diagnosticBuyerPayload.product.title,
          isMarketPlaceItem: true,
          images: [{ url: diagnosticBuyerPayload.product.main_image }],
        }],
      };
    },
    async getBuyerPdpHtml() {
      calls.push("pdp");
      return publicBuyerHtml();
    },
    async getImage(url) {
      calls.push("image");
      return {
        status: 200,
        bytes: url.endsWith("main.png") ? main : gallery,
        final_url: url,
      };
    },
  }, new Date("2026-07-25T12:00:00.000Z"), {
    continue_when_source_required: true,
  });
  assert.equal(result.status, "CAPTURED_SOURCE_REQUIRED");
  if (result.status !== "CAPTURED_SOURCE_REQUIRED") return;
  assert.equal(result.truth.status, "SOURCE_REQUIRED");
  assert.deepEqual(result.execution, {
    product_truth_reads: 1,
    walmart_logical_gets: 2,
    buyer_pdp_gets: 1,
    image_gets: 2,
    model_calls: 0,
    database_writes: 0,
    walmart_writes: 0,
  });
  assert.deepEqual(calls.slice(0, 4), ["truth", "seller", "catalog", "pdp"]);
});

test("buyer-PDP substitution is sealed as a capture requirement, never accepted as the target", async () => {
  const result = await captureWalmartListingSingleIntake({
    sku: diagnosticTarget.sku,
    store_index: 1,
  }, {
    async readProductTruth() {
      return snapshot({ content: false });
    },
    async getExactSellerItem() {
      return {
        ItemResponse: [{
          sku: diagnosticTarget.sku,
          productName: diagnosticBuyerPayload.product.title,
          upc: "123456789012",
          gtin: "00123456789012",
          wpid: "ALPHANUMERIC-WPID",
          publishedStatus: "PUBLISHED",
          lifecycleStatus: "ACTIVE",
        }],
      };
    },
    async getCatalogSearchByUpc() {
      return {
        items: [{
          itemId: diagnosticTarget.item_id,
          standardUpc: ["00123456789012"],
          title: diagnosticBuyerPayload.product.title,
          isMarketPlaceItem: true,
          images: [{ url: diagnosticBuyerPayload.product.main_image }],
        }],
      };
    },
    async getBuyerPdpHtml() {
      return publicBuyerHtml("999999999");
    },
    async getImage() {
      throw new Error("images must not be fetched after a substituted PDP");
    },
  }, new Date("2026-07-25T12:00:00.000Z"), {
    continue_when_source_required: true,
  });
  assert.equal(result.status, "BUYER_CAPTURE_REQUIRED");
  if (result.status !== "BUYER_CAPTURE_REQUIRED") return;
  assert.equal(result.target.item_id, diagnosticTarget.item_id);
  assert.equal(result.buyer_capture_request.failure_stage, "STRICT_PROJECTION");
  assert.match(
    result.buyer_capture_request.failure_message,
    /displayed product does not match/,
  );
  assert.equal(result.execution.image_gets, 0);
  assert.equal(result.execution.walmart_writes, 0);

  const root = await mkdtemp(path.join(os.tmpdir(), "wli-buyer-capture-required-"));
  try {
    const written = await writeWalmartListingSingleIntake(
      path.join(root, "partial-intake"),
      result,
    );
    assert.equal(written.index.status, "BUYER_CAPTURE_REQUIRED");
    assert.equal(written.index.buyer_snapshot_id, null);
    assert.equal(
      written.index.files.some((file) => file.role === "rejected_buyer_pdp_html"),
      true,
    );
    assert.equal(
      written.index.files.some((file) => file.role === "exact_resolution"),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buyer PDP accepts an exact displayed item whose primary variant item differs", () => {
  const projected = projectWalmartPublicBuyerPdpHtml(
    publicBuyerHtml(diagnosticTarget.item_id, "987654321"),
    diagnosticTarget.item_id,
  );
  assert.equal(projected.product.item_id, diagnosticTarget.item_id);
  assert.equal(projected.product.title, diagnosticBuyerPayload.product.title);
});

test("buyer PDP accepts an exact displayed item with no primary variant item", () => {
  const projected = projectWalmartPublicBuyerPdpHtml(
    publicBuyerHtml(diagnosticTarget.item_id, null),
    diagnosticTarget.item_id,
  );
  assert.equal(projected.product.item_id, diagnosticTarget.item_id);
});

test("inspect accepts one exact imported buyer HTML file and accounts for zero PDP GETs", async () => {
  const parsed = parseWalmartListingSingleProcessArgs([
    "inspect",
    "--sku=SKU-6",
    "--store-index=1",
    "--output-dir=/tmp/wli-output",
    "--buyer-pdp-html=/tmp/wli-exact-pdp.html",
  ]);
  assert.equal(parsed.command, "inspect");
  assert.equal(parsed.buyer_pdp_html, "/tmp/wli-exact-pdp.html");

  const main = await sharp({
    create: { width: 5, height: 4, channels: 3, background: "#f0d0a0" },
  }).png().toBuffer();
  const gallery = await sharp({
    create: { width: 4, height: 5, channels: 3, background: "#ffffff" },
  }).png().toBuffer();
  const result = await captureWalmartListingSingleIntake({
    sku: diagnosticTarget.sku,
    store_index: 1,
  }, {
    async readProductTruth() {
      return snapshot({ content: false });
    },
    async getExactSellerItem() {
      return {
        ItemResponse: [{
          sku: diagnosticTarget.sku,
          productName: diagnosticBuyerPayload.product.title,
          upc: "123456789012",
          gtin: "00123456789012",
          wpid: "ALPHANUMERIC-WPID",
          publishedStatus: "PUBLISHED",
          lifecycleStatus: "ACTIVE",
        }],
      };
    },
    async getCatalogSearchByUpc() {
      return {
        items: [{
          itemId: diagnosticTarget.item_id,
          standardUpc: ["00123456789012"],
          title: diagnosticBuyerPayload.product.title,
          isMarketPlaceItem: true,
          images: [{ url: diagnosticBuyerPayload.product.main_image }],
        }],
      };
    },
    async getBuyerPdpHtml() {
      return publicBuyerHtml();
    },
    async getImage(url) {
      return {
        status: 200,
        bytes: url.endsWith("main.png") ? main : gallery,
        final_url: url,
      };
    },
  }, new Date("2026-07-25T12:00:00.000Z"), {
    continue_when_source_required: true,
    buyer_pdp_gets: 0,
  });
  assert.equal(result.status, "CAPTURED_SOURCE_REQUIRED");
  if (result.status !== "CAPTURED_SOURCE_REQUIRED") return;
  assert.equal(result.execution.buyer_pdp_gets, 0);
  assert.equal(result.execution.image_gets, 2);
});

test("read-only intake captures the exact seller-to-buyer chain and every image", async () => {
  const main = await sharp({
    create: { width: 5, height: 4, channels: 3, background: "#f0d0a0" },
  }).png().toBuffer();
  const gallery = await sharp({
    create: { width: 4, height: 5, channels: 3, background: "#ffffff" },
  }).png().toBuffer();
  const sellerPayload = {
    ItemResponse: [{
      sku: diagnosticTarget.sku,
      productName: diagnosticBuyerPayload.product.title,
      upc: "123456789012",
      gtin: "00123456789012",
      wpid: "ALPHANUMERIC-WPID",
      publishedStatus: "PUBLISHED",
      lifecycleStatus: "ACTIVE",
    }],
  };
  const catalogPayload = {
    items: [{
      itemId: diagnosticTarget.item_id,
      standardUpc: ["00123456789012"],
      title: diagnosticBuyerPayload.product.title,
      isMarketPlaceItem: true,
      images: [{ url: diagnosticBuyerPayload.product.main_image }],
    }],
  };
  const calls: string[] = [];
  const result = await captureWalmartListingSingleIntake({
    sku: diagnosticTarget.sku,
    store_index: 1,
  }, {
    async readProductTruth() {
      calls.push("truth");
      return snapshot();
    },
    async getExactSellerItem(sku) {
      calls.push(`seller:${sku}`);
      return sellerPayload;
    },
    async getCatalogSearchByUpc(upc) {
      calls.push(`catalog:${upc}`);
      return catalogPayload;
    },
    async getBuyerPdpHtml(itemId) {
      calls.push(`pdp:${itemId}`);
      return publicBuyerHtml(itemId);
    },
    async getImage(url) {
      calls.push(`image:${url}`);
      return {
        status: 200,
        bytes: url.endsWith("main.png") ? main : gallery,
        final_url: url,
      };
    },
  }, new Date("2026-07-25T12:00:00.000Z"));
  assert.equal(result.status, "CAPTURED");
  if (result.status !== "CAPTURED") return;
  assert.equal(result.target.item_id, diagnosticTarget.item_id);
  assert.deepEqual(result.buyer_snapshot.assets.map((asset) => asset.slot), [
    "MAIN",
    "GALLERY_1",
  ]);
  assert.deepEqual(result.execution, {
    product_truth_reads: 1,
    walmart_logical_gets: 2,
    buyer_pdp_gets: 1,
    image_gets: 2,
    model_calls: 0,
    database_writes: 0,
    walmart_writes: 0,
  });
  assert.deepEqual(calls.slice(0, 4), [
    "truth",
    `seller:${diagnosticTarget.sku}`,
    "catalog:123456789012",
    `pdp:${diagnosticTarget.item_id}`,
  ]);
  assert.deepEqual(
    result.buyer_pdp_payload,
    projectWalmartPublicBuyerPdpHtml(publicBuyerHtml(), diagnosticTarget.item_id),
  );
});

test("captured intake is atomically persisted as one immutable local bundle", async () => {
  const main = await sharp({
    create: { width: 5, height: 4, channels: 3, background: "#f0d0a0" },
  }).png().toBuffer();
  const gallery = await sharp({
    create: { width: 4, height: 5, channels: 3, background: "#ffffff" },
  }).png().toBuffer();
  const result = await captureWalmartListingSingleIntake({
    sku: diagnosticTarget.sku,
    store_index: 1,
  }, {
    async readProductTruth() {
      return snapshot();
    },
    async getExactSellerItem() {
      return {
        ItemResponse: [{
          sku: diagnosticTarget.sku,
          productName: diagnosticBuyerPayload.product.title,
          upc: "123456789012",
          gtin: "00123456789012",
          wpid: "ALPHANUMERIC-WPID",
          publishedStatus: "PUBLISHED",
          lifecycleStatus: "ACTIVE",
        }],
      };
    },
    async getCatalogSearchByUpc() {
      return {
        items: [{
          itemId: diagnosticTarget.item_id,
          standardUpc: ["00123456789012"],
          title: diagnosticBuyerPayload.product.title,
          isMarketPlaceItem: true,
          images: [{ url: diagnosticBuyerPayload.product.main_image }],
        }],
      };
    },
    async getBuyerPdpHtml() {
      return publicBuyerHtml();
    },
    async getImage(url) {
      return {
        status: 200,
        bytes: url.endsWith("main.png") ? main : gallery,
        final_url: url,
      };
    },
  }, new Date("2026-07-25T12:00:00.000Z"));
  assert.equal(result.status, "CAPTURED");
  if (result.status !== "CAPTURED") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "wli-intake-bundle-"));
  try {
    const written = await writeWalmartListingSingleIntake(
      path.join(root, "exact-sku-intake"),
      result,
    );
    assert.equal(written.index.status, "CAPTURED");
    assert.match(written.index.body_sha256, /^[a-f0-9]{64}$/);
    assert.equal(
      written.index.files.filter((file) => file.role.startsWith("buyer_image_")).length,
      2,
    );
    assert.equal(written.index.execution.walmart_writes, 0);
    assert.equal(written.index.execution.database_writes, 0);

    const { privateKey } = generateKeyPairSync("ed25519");
    const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
    const signer = visionContract.createVisionReceiptSigner(
      privateDer.toString("base64"),
      "test-observe-command-key",
    );
    const worker = WALMART_LISTING_SINGLE_OBSERVER_WORKER_CONTRACT;
    const metadata = (inputImageCount: number) => ({
      input_image_count: inputImageCount,
      vision_provider: "claude_cli_subscription",
      vision_model: worker.model,
      vision_reasoning_effort: worker.reasoning_effort,
      cli_version: worker.cli_version,
      node_version: worker.node_version,
      runtime_platform: worker.runtime_platform,
      runtime_arch: worker.runtime_arch,
      worker_build: worker.worker_build,
      vision_timeout_ms: worker.vision_timeout_ms,
      reservation_ledger: worker.reservation_ledger,
    });
    const healthValue = {
      ok: true,
      health_authorization_verified: true,
      vision: true,
      worker_build: worker.worker_build,
      vision_timeout_ms: worker.vision_timeout_ms,
      durable_call_key_reservations: true,
      reservation_ledger: worker.reservation_ledger,
      signed_vision_receipts: {
        schema_version: "vision-worker-receipt/v2",
        key_id: signer.key_id,
        public_key_spki_sha256: signer.public_key_spki_sha256,
      },
      vision_contracts: {
        claude_cli_subscription: {
          model: worker.model,
          reasoning_effort: worker.reasoning_effort,
          cli_version: worker.cli_version,
        },
      },
    };
    const healthBytes = Buffer.from(JSON.stringify(healthValue), "utf8");
    const failedPrecallOutput = path.join(root, "observer-health-failure");
    await assert.rejects(
      executeLiveWalmartListingSingleObservation({
        command: "observe",
        intake_dir: written.directory,
        output_dir: failedPrecallOutput,
      }, {
        connection: {
          async health() {
            return {
              status: 503,
              bytes: Buffer.from("{}"),
              value: {},
              sha256: createHash("sha256").update("{}").digest("hex"),
            };
          },
          async analyze() {
            throw new Error("analyze must not run after failed health");
          },
        },
      }),
      /authenticated worker health returned HTTP 503/,
    );
    await assert.rejects(
      lstat(failedPrecallOutput),
      (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
    const unknownOutput = path.join(root, "observer-unknown-outcome");
    const unknownSummary = await executeLiveWalmartListingSingleObservation({
      command: "observe",
      intake_dir: written.directory,
      output_dir: unknownOutput,
    }, {
      trust: {
        key_id: signer.key_id,
        public_key_spki_sha256: signer.public_key_spki_sha256,
      },
      connection: {
        async health() {
          return {
            status: 200,
            bytes: healthBytes,
            value: healthValue,
            sha256: createHash("sha256").update(healthBytes).digest("hex"),
          };
        },
        async analyze() {
          throw new Error("transport closed after request handoff");
        },
      },
    });
    assert.equal(unknownSummary.status, "OBSERVATION_UNKNOWN_OUTCOME");
    if (unknownSummary.status !== "OBSERVATION_UNKNOWN_OUTCOME") return;
    assert.equal(unknownSummary.execution.subscription_calls_confirmed_consumed, 0);
    assert.equal(unknownSummary.execution.subscription_calls_unknown, 1);
    assert.equal(unknownSummary.execution.transport_attempts, 1);
    assert.equal(unknownSummary.execution.retries, 0);
    assert.equal(unknownSummary.execution.walmart_writes, 0);
    assert.equal(
      unknownSummary.next_step,
      "DO_NOT_RETRY_RECONCILE_EXACT_CALL_KEY",
    );
    const unknownArtifact = JSON.parse(
      await readFile(unknownSummary.unknown_outcome_path, "utf8"),
    );
    assert.equal(
      unknownArtifact.disposition.automatic_replay_allowed,
      false,
    );
    assert.equal(
      unknownArtifact.transport.subscription_call_consumption,
      "UNKNOWN",
    );
    const unknownExecution = JSON.parse(
      await readFile(path.join(unknownOutput, "execution-index.json"), "utf8"),
    );
    assert.equal(unknownExecution.status, "UNKNOWN_OUTCOME");
    assert.equal(unknownExecution.calls[0].call_key, unknownSummary.unknown_call.call_key);
    assert.equal(unknownExecution.calls[0].response_file_sha256, null);

    const summary = await executeLiveWalmartListingSingleObservation({
      command: "observe",
      intake_dir: written.directory,
      output_dir: path.join(root, "observer"),
    }, {
      trust: {
        key_id: signer.key_id,
        public_key_spki_sha256: signer.public_key_spki_sha256,
      },
      connection: {
        async health() {
          return {
            status: 200,
            bytes: healthBytes,
            value: healthValue,
            sha256: createHash("sha256").update(healthBytes).digest("hex"),
          };
        },
        async analyze(body) {
          const request = JSON.parse(body);
          const ids = [...request.prompt.matchAll(
            /attached image \d+ -> (i_[a-f0-9]+)/gu,
          )].map((match) => match[1]);
          const visionResult = {
            schema_version: "wm_visual_observation_batch/v3",
            observations: ids.map((id) => observation(id)),
          };
          const workerMetadata = metadata(ids.length);
          const receipt = signer.sign({
            issued_at: "2026-07-25T13:00:01.000Z",
            reservation_reserved_at: "2026-07-25T13:00:00.000Z",
            request_attestation: request.request_attestation,
            result_canonical_sha256: createHash("sha256")
              .update(visionContract.canonicalJson(visionResult))
              .digest("hex"),
            worker_contract: workerMetadata,
            subscription_policy: {
              auth_mode: "claude_subscription_oauth",
              paid_api_environment_absent: true,
              alternate_cloud_routing_absent: true,
            },
          });
          const value = {
            ok: true,
            result: visionResult,
            ...workerMetadata,
            request_attestation_verified: true,
            worker_receipt: receipt,
          };
          const bytes = Buffer.from(JSON.stringify(value), "utf8");
          return {
            status: 200,
            bytes,
            value,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
        },
      },
    });
    assert.equal(summary.status, "OBSERVED");
    assert.equal(summary.execution.subscription_calls_consumed, 1);
    assert.equal(summary.execution.retries, 0);
    assert.equal(summary.execution.walmart_writes, 0);
  } finally {
    await chmod(path.join(root, "observer-unknown-outcome", "model-assets"), 0o700)
      .catch(() => {});
    await chmod(path.join(root, "observer-unknown-outcome"), 0o700).catch(() => {});
    await chmod(path.join(root, "observer", "model-assets"), 0o700).catch(() => {});
    await chmod(path.join(root, "observer"), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("blind observer plan hides listing truth and verifies an exact signed worker response", async () => {
  const modelBytes = await sharp({
    create: { width: 8, height: 6, channels: 3, background: "#f0d0a0" },
  }).jpeg().toBuffer();
  const modelSha = createHash("sha256").update(modelBytes).digest("hex");
  const sourceSha = "a".repeat(64);
  const plan = buildWalmartListingSingleObserverPlan({
    created_at: "2026-07-25T13:00:00.000Z",
    listing_key: "walmart:1:SKU-6",
    item_id: diagnosticTarget.item_id,
    intake_index_file_sha256: "b".repeat(64),
    intake_index_body_sha256: "c".repeat(64),
    prepared_assets: [{
      slot: "main",
      source_asset_sha256: sourceSha,
      model_asset: {
        path: "model-assets/main.jpeg",
        sha256: modelSha,
        bytes: modelBytes.length,
        media_type: "image/jpeg",
        width: 8,
        height: 6,
      },
    }],
  });
  assert.equal(plan.calls.length, 1);
  assert.equal(plan.calls[0]!.prompt.includes("SKU-6"), false);
  assert.equal(plan.calls[0]!.prompt.includes("Pack of 6"), false);
  assert.equal(plan.calls[0]!.prompt.includes("Product Truth"), false);
  const request = buildWalmartListingSingleObserverRequest(plan, 0, [modelBytes]);

  const { privateKey } = generateKeyPairSync("ed25519");
  const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
  const signer = visionContract.createVisionReceiptSigner(
    privateDer.toString("base64"),
    "test-worker-key",
  );
  const result = {
    schema_version: "wm_visual_observation_batch/v3",
    observations: [observation(plan.assets[0]!.image_id)],
  };
  const workerMetadata = {
    input_image_count: 1,
    vision_provider: "claude_cli_subscription",
    vision_model: WALMART_LISTING_SINGLE_OBSERVER_WORKER_CONTRACT.model,
    vision_reasoning_effort:
      WALMART_LISTING_SINGLE_OBSERVER_WORKER_CONTRACT.reasoning_effort,
    cli_version: WALMART_LISTING_SINGLE_OBSERVER_WORKER_CONTRACT.cli_version,
    node_version: WALMART_LISTING_SINGLE_OBSERVER_WORKER_CONTRACT.node_version,
    runtime_platform:
      WALMART_LISTING_SINGLE_OBSERVER_WORKER_CONTRACT.runtime_platform,
    runtime_arch: WALMART_LISTING_SINGLE_OBSERVER_WORKER_CONTRACT.runtime_arch,
    worker_build: WALMART_LISTING_SINGLE_OBSERVER_WORKER_CONTRACT.worker_build,
    vision_timeout_ms:
      WALMART_LISTING_SINGLE_OBSERVER_WORKER_CONTRACT.vision_timeout_ms,
    reservation_ledger:
      WALMART_LISTING_SINGLE_OBSERVER_WORKER_CONTRACT.reservation_ledger,
  };
  const receipt = signer.sign({
    issued_at: "2026-07-25T13:00:01.000Z",
    reservation_reserved_at: "2026-07-25T13:00:00.000Z",
    request_attestation: request.value.request_attestation,
    result_canonical_sha256: createHash("sha256")
      .update(visionContract.canonicalJson(result))
      .digest("hex"),
    worker_contract: workerMetadata,
    subscription_policy: {
      auth_mode: "claude_subscription_oauth",
      paid_api_environment_absent: true,
      alternate_cloud_routing_absent: true,
    },
  });
  const response = {
    ok: true,
    result,
    ...workerMetadata,
    request_attestation_verified: true,
    worker_receipt: receipt,
  };
  const verified = verifyWalmartListingSingleWorkerResponse({
    plan,
    call_index: 0,
    request: request.value,
    http_status: 200,
    response,
    trust: {
      key_id: signer.key_id,
      public_key_spki_sha256: signer.public_key_spki_sha256,
    },
  });
  assert.equal(verified.observations.length, 1);
  const tampered = structuredClone(response);
  tampered.result.observations[0].external_package_count.value = 1;
  assert.throws(() => verifyWalmartListingSingleWorkerResponse({
    plan,
    call_index: 0,
    request: request.value,
    http_status: 200,
    response: tampered,
    trust: {
      key_id: signer.key_id,
      public_key_spki_sha256: signer.public_key_spki_sha256,
    },
  }), /signed worker receipt mismatch/);
});
