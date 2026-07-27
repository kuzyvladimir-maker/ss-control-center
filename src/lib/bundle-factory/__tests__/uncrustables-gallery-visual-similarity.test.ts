// npx tsx --test src/lib/bundle-factory/__tests__/uncrustables-gallery-visual-similarity.test.ts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  GALLERY_VISUAL_SIMILARITY_POLICY,
  GALLERY_VISUAL_SIMILARITY_REVIEW_SCHEMA,
  enforceGalleryVisualSimilarityReview,
  galleryVisualSimilarityPairCount,
  reviewedGalleryVisualDropShaBySku,
  screenGalleryVisualSimilarity,
  sealGalleryVisualSimilarityReviewBody,
  type ExpectedGalleryVisualSimilaritySource,
  type GalleryVisualSimilarityFinding,
  type GalleryVisualSimilarityReviewArtifact,
  type GalleryVisualSimilarityReviewBody,
  type GalleryVisualSimilarityReviewDecision,
  type GalleryVisualSimilarityRowInput,
} from "../repair/uncrustables-gallery-visual-similarity";

const PLAN_PATH =
  "data/audits/uncrustables-live-gallery-surgical-plan-20260718-v1.json";

const TARGET_SKUS = new Set([
  "AZ-ASMY-VEQ2",
  "ER-ASRK-TPYQ",
  "GX-ASTJ-WHV3",
  "SG-AS32-LZ9Y",
  "UA-ASAO-RE7Q",
  "VC-ASV1-378P",
  "ZX-ASQU-TKU9",
]);

const DROP_SHA =
  "15dde9a56f62cf026daed4d9a611f0d8564a1d3706be039c9827b01b21eaac7c";

interface PlanAsset {
  slot: string;
  sha256: string;
  local_path: string;
  component_key: string | null;
}

interface PlanRow {
  sku: string;
  after: { secondary_assets: PlanAsset[] };
}

interface PlanArtifact {
  body_sha256: string;
  rows: PlanRow[];
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(): Promise<{
  rows: GalleryVisualSimilarityRowInput[];
  source: ExpectedGalleryVisualSimilaritySource;
}> {
  const bytes = await readFile(PLAN_PATH);
  const plan = JSON.parse(bytes.toString("utf8")) as PlanArtifact;
  const rows = plan.rows
    .filter((row) => TARGET_SKUS.has(row.sku))
    .map((row) => ({
      sku: row.sku,
      assets: row.after.secondary_assets.map((asset) => ({
        slot: asset.slot,
        sha256: asset.sha256,
        local_path: asset.local_path,
        component_key: asset.component_key,
      })),
    }));
  assert.equal(rows.length, 7);
  return {
    rows,
    source: { sha256: sha256(bytes), body_sha256: plan.body_sha256 },
  };
}

function decisionFor(
  finding: GalleryVisualSimilarityFinding,
): GalleryVisualSimilarityReviewDecision {
  const shouldDrop = new Set([
    "AZ-ASMY-VEQ2",
    "UA-ASAO-RE7Q",
    "VC-ASV1-378P",
    "ZX-ASQU-TKU9",
  ]).has(finding.sku);
  const pair = [finding.asset_a.sha256, finding.asset_b.sha256];
  assert.equal(shouldDrop ? pair.includes(DROP_SHA) : true, true);
  const keepSha = shouldDrop ? pair.find((sha) => sha !== DROP_SHA)! : null;
  return {
    ...finding,
    action: shouldDrop ? "DROP" : "SEMANTICALLY_DISTINCT",
    keep_sha256: keepSha,
    drop_sha256: shouldDrop ? DROP_SHA : null,
    rationale: shouldDrop
      ? "Human review confirms the two files repeat the same baseball lifestyle creative; retain only the reviewed counterpart."
      : "Human review confirms the similar layout belongs to two different recipe-specific flavors with visibly different label, nutrition, or handling content.",
    visual_review_evidence: shouldDrop
      ? "Side-by-side full-resolution review: same people, framing, copy, and strawberry wrapper; only rendition/crop encoding differs."
      : `Side-by-side full-resolution review binds ${finding.asset_a.component_key} and ${finding.asset_b.component_key} as semantically distinct product panels.`,
  };
}

function sealedReview(
  source: ExpectedGalleryVisualSimilaritySource,
  decisions: GalleryVisualSimilarityReviewDecision[],
): GalleryVisualSimilarityReviewArtifact {
  const body: GalleryVisualSimilarityReviewBody = {
    schema_version: GALLERY_VISUAL_SIMILARITY_REVIEW_SCHEMA,
    status: "SEALED_LOCAL_HUMAN_REVIEW",
    immutable: true,
    reviewed_at: "2026-07-18T05:00:00.000Z",
    reviewed_by: "fixture-human-visual-review",
    source_gallery_plan: {
      path: PLAN_PATH,
      sha256: source.sha256,
      body_sha256: source.body_sha256,
    },
    policy: GALLERY_VISUAL_SIMILARITY_POLICY,
    decisions,
  };
  return { ...body, body_sha256: sealGalleryVisualSimilarityReviewBody(body) };
}

test("exhaustive local screen finds the exact 8 low-MAE pairs in the 7 known rows", async () => {
  const { rows } = await fixture();
  const findings = await screenGalleryVisualSimilarity(rows);
  assert.equal(findings.length, 8);
  assert.equal(galleryVisualSimilarityPairCount(rows), 147);
  assert.deepEqual(
    [...new Set(findings.map((finding) => finding.sku))].sort(),
    [...TARGET_SKUS].sort(),
  );
  assert.deepEqual(
    findings.map((finding) => [
      finding.sku,
      finding.absolute_error_sum,
      finding.sample_count,
      finding.grayscale_mae,
    ]),
    [
      ["AZ-ASMY-VEQ2", 5062, 4096, 1.23583984375],
      ["ER-ASRK-TPYQ", 10478, 4096, 2.55810546875],
      ["GX-ASTJ-WHV3", 11800, 4096, 2.880859375],
      ["GX-ASTJ-WHV3", 13792, 4096, 3.3671875],
      ["SG-AS32-LZ9Y", 5416, 4096, 1.322265625],
      ["UA-ASAO-RE7Q", 5062, 4096, 1.23583984375],
      ["VC-ASV1-378P", 5062, 4096, 1.23583984375],
      ["ZX-ASQU-TKU9", 1, 4096, 0.000244140625],
    ],
  );
});

test("sealed review allows exact ER/SG/GX semantic pairs but rejects the old ZX/AZ/UA/VC galleries", async () => {
  const { rows, source } = await fixture();
  const findings = await screenGalleryVisualSimilarity(rows);
  const review = sealedReview(source, findings.map(decisionFor));
  const gate = await enforceGalleryVisualSimilarityReview(rows, review, source);

  assert.equal(gate.pass, false);
  assert.equal(gate.evaluated_pair_count, 147);
  assert.equal(gate.unreviewed_findings.length, 0);
  assert.equal(gate.semantically_distinct_findings.length, 4);
  assert.deepEqual(
    gate.required_drops.map((entry) => entry.finding.sku).sort(),
    ["AZ-ASMY-VEQ2", "UA-ASAO-RE7Q", "VC-ASV1-378P", "ZX-ASQU-TKU9"],
  );
  assert.ok(
    gate.required_drops.every(
      (entry) => entry.decision.drop_sha256 === DROP_SHA,
    ),
  );

  const drops = reviewedGalleryVisualDropShaBySku(review, source);
  assert.equal(drops.size, 4);
  assert.ok([...drops.values()].every((values) => values.has(DROP_SHA)));

  const afterDrops = rows.map((row) => ({
    ...row,
    assets: row.assets.filter(
      (asset) => !(drops.get(row.sku)?.has(asset.sha256) ?? false),
    ),
  }));
  const postDropGate = await enforceGalleryVisualSimilarityReview(
    afterDrops,
    review,
    source,
  );
  assert.equal(postDropGate.pass, true);
  assert.equal(postDropGate.evaluated_pair_count, 123);
  assert.equal(postDropGate.findings.length, 4);
  assert.equal(postDropGate.semantically_distinct_findings.length, 4);
  assert.equal(postDropGate.resolved_drop_decisions.length, 4);
  assert.equal(postDropGate.required_drops.length, 0);
  assert.equal(postDropGate.unreviewed_findings.length, 0);
});

test("an unreviewed near-duplicate fails closed even when every other decision is resealed", async () => {
  const { rows, source } = await fixture();
  const findings = await screenGalleryVisualSimilarity(rows);
  const omitted = findings.find((finding) => finding.sku === "ER-ASRK-TPYQ")!;
  const review = sealedReview(
    source,
    findings.filter((finding) => finding !== omitted).map(decisionFor),
  );
  const gate = await enforceGalleryVisualSimilarityReview(rows, review, source);
  assert.equal(gate.pass, false);
  assert.deepEqual(
    gate.unreviewed_findings.map((finding) => finding.finding_key),
    [omitted.finding_key],
  );
  assert.ok(
    gate.errors.includes(`UNREVIEWED_NEAR_DUPLICATE:${omitted.finding_key}`),
  );
});

test("a same-component near-duplicate cannot be relabeled as semantically distinct", async () => {
  const { rows, source } = await fixture();
  const findings = await screenGalleryVisualSimilarity(rows);
  const decisions = findings.map(decisionFor);
  const duplicate = decisions.find((decision) => decision.sku === "AZ-ASMY-VEQ2")!;
  duplicate.action = "SEMANTICALLY_DISTINCT";
  duplicate.keep_sha256 = null;
  duplicate.drop_sha256 = null;
  const review = sealedReview(source, decisions);
  await assert.rejects(
    enforceGalleryVisualSimilarityReview(rows, review, source),
    /semantic-distinct decision must bind two distinct recipe components/,
  );
});
