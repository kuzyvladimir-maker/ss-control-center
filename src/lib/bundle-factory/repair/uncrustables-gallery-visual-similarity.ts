/**
 * Deterministic, local-only perceptual-duplicate gate for Uncrustables
 * secondary galleries.
 *
 * Exact file hashes are necessary but insufficient: retailer CDNs can expose
 * the same creative at different crops/resolutions/encodes. This gate screens
 * every intra-gallery pair after normalising it to the same 64 x 64 grayscale
 * raster. Every pair at or below the conservative MAE threshold must then have
 * an exact, sealed human decision. A reviewed DROP keeps the gallery blocked
 * until that asset is absent; SEMANTICALLY_DISTINCT is the only allow action.
 *
 * No network or external writes occur here. Local source bytes are SHA-checked
 * before decoding so a review cannot silently drift to different pixels.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import {
  sealUncrustablesLiveGalleryManifestBody,
  verifyUncrustablesLiveGalleryManifestSeal,
} from "../audit/uncrustables-live-gallery";

export const GALLERY_VISUAL_SIMILARITY_REVIEW_SCHEMA =
  "uncrustables-gallery-visual-similarity-review/v1.0" as const;

export const GALLERY_VISUAL_SIMILARITY_POLICY = Object.freeze({
  normalization_version:
    "sharp-rotate-flatten-white-contain-64x64-grayscale-raw/v1" as const,
  width: 64,
  height: 64,
  channels: 1,
  sample_count: 64 * 64,
  maximum_grayscale_mae: 6.5,
});

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface GalleryVisualSimilarityAssetInput {
  slot: string;
  sha256: string;
  local_path: string;
  component_key: string | null;
}

export interface GalleryVisualSimilarityRowInput {
  sku: string;
  assets: readonly GalleryVisualSimilarityAssetInput[];
}

export interface GalleryVisualSimilarityFindingAsset {
  sha256: string;
  slot: string;
  component_key: string | null;
}

export interface GalleryVisualSimilarityFinding {
  finding_key: string;
  sku: string;
  asset_a: GalleryVisualSimilarityFindingAsset;
  asset_b: GalleryVisualSimilarityFindingAsset;
  absolute_error_sum: number;
  sample_count: number;
  grayscale_mae: number;
}

export type GalleryVisualSimilarityDecisionAction =
  | "SEMANTICALLY_DISTINCT"
  | "DROP";

export interface GalleryVisualSimilarityReviewDecision {
  finding_key: string;
  sku: string;
  asset_a: GalleryVisualSimilarityFindingAsset;
  asset_b: GalleryVisualSimilarityFindingAsset;
  absolute_error_sum: number;
  sample_count: number;
  grayscale_mae: number;
  action: GalleryVisualSimilarityDecisionAction;
  keep_sha256: string | null;
  drop_sha256: string | null;
  rationale: string;
  visual_review_evidence: string;
}

export interface GalleryVisualSimilarityReviewBody
  extends Record<string, unknown> {
  schema_version: typeof GALLERY_VISUAL_SIMILARITY_REVIEW_SCHEMA;
  status: "SEALED_LOCAL_HUMAN_REVIEW";
  immutable: true;
  reviewed_at: string;
  reviewed_by: string;
  source_gallery_plan: {
    path: string;
    sha256: string;
    body_sha256: string;
  };
  policy: typeof GALLERY_VISUAL_SIMILARITY_POLICY;
  decisions: GalleryVisualSimilarityReviewDecision[];
}

export interface GalleryVisualSimilarityReviewArtifact
  extends GalleryVisualSimilarityReviewBody {
  body_sha256: string;
}

export interface ExpectedGalleryVisualSimilaritySource {
  sha256: string;
  body_sha256: string;
}

export interface GalleryVisualSimilarityRequiredDrop {
  finding: GalleryVisualSimilarityFinding;
  decision: GalleryVisualSimilarityReviewDecision;
}

export interface GalleryVisualSimilarityGateResult {
  pass: boolean;
  errors: string[];
  evaluated_pair_count: number;
  findings: GalleryVisualSimilarityFinding[];
  semantically_distinct_findings: GalleryVisualSimilarityFinding[];
  required_drops: GalleryVisualSimilarityRequiredDrop[];
  resolved_drop_decisions: GalleryVisualSimilarityReviewDecision[];
  unreviewed_findings: GalleryVisualSimilarityFinding[];
  stale_or_mismatched_decisions: GalleryVisualSimilarityReviewDecision[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedMae(absoluteErrorSum: number, sampleCount: number): number {
  return absoluteErrorSum / sampleCount;
}

function compareFindingAssets(
  left: GalleryVisualSimilarityFindingAsset,
  right: GalleryVisualSimilarityFindingAsset,
): number {
  return left.sha256.localeCompare(right.sha256) || left.slot.localeCompare(right.slot);
}

function canonicalFindingAssets(
  left: GalleryVisualSimilarityFindingAsset,
  right: GalleryVisualSimilarityFindingAsset,
): [GalleryVisualSimilarityFindingAsset, GalleryVisualSimilarityFindingAsset] {
  return compareFindingAssets(left, right) <= 0 ? [left, right] : [right, left];
}

export function galleryVisualSimilarityFindingKey(
  sku: string,
  assetASha256: string,
  assetBSha256: string,
): string {
  assert(nonEmptyString(sku), "Visual-similarity finding SKU is empty.");
  assert(isSha256(assetASha256), "Visual-similarity asset A SHA is invalid.");
  assert(isSha256(assetBSha256), "Visual-similarity asset B SHA is invalid.");
  assert(assetASha256 !== assetBSha256, "Visual-similarity pair uses one SHA twice.");
  const [first, second] = [assetASha256, assetBSha256].sort();
  return `GVSP-${sha256(`${sku}\n${first}\n${second}`).slice(0, 24)}`;
}

function validateFindingAsset(
  value: GalleryVisualSimilarityFindingAsset,
  label: string,
): void {
  assert(isSha256(value.sha256), `${label} SHA is invalid.`);
  assert(nonEmptyString(value.slot), `${label} slot is empty.`);
  assert(
    value.component_key === null || nonEmptyString(value.component_key),
    `${label} component key is invalid.`,
  );
}

function findingMatchesDecision(
  finding: GalleryVisualSimilarityFinding,
  decision: GalleryVisualSimilarityReviewDecision,
): boolean {
  return (
    finding.finding_key === decision.finding_key &&
    finding.sku === decision.sku &&
    finding.asset_a.sha256 === decision.asset_a.sha256 &&
    finding.asset_a.slot === decision.asset_a.slot &&
    finding.asset_a.component_key === decision.asset_a.component_key &&
    finding.asset_b.sha256 === decision.asset_b.sha256 &&
    finding.asset_b.slot === decision.asset_b.slot &&
    finding.asset_b.component_key === decision.asset_b.component_key &&
    finding.absolute_error_sum === decision.absolute_error_sum &&
    finding.sample_count === decision.sample_count &&
    finding.grayscale_mae === decision.grayscale_mae
  );
}

function exactPolicyMatches(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const policy = value as Record<string, unknown>;
  return (
    policy.normalization_version ===
      GALLERY_VISUAL_SIMILARITY_POLICY.normalization_version &&
    policy.width === GALLERY_VISUAL_SIMILARITY_POLICY.width &&
    policy.height === GALLERY_VISUAL_SIMILARITY_POLICY.height &&
    policy.channels === GALLERY_VISUAL_SIMILARITY_POLICY.channels &&
    policy.sample_count === GALLERY_VISUAL_SIMILARITY_POLICY.sample_count &&
    policy.maximum_grayscale_mae ===
      GALLERY_VISUAL_SIMILARITY_POLICY.maximum_grayscale_mae &&
    Object.keys(policy).length === Object.keys(GALLERY_VISUAL_SIMILARITY_POLICY).length
  );
}

function validateDecision(
  decision: GalleryVisualSimilarityReviewDecision,
): void {
  assert(nonEmptyString(decision.sku), "Visual-similarity decision SKU is empty.");
  validateFindingAsset(decision.asset_a, `${decision.sku} decision asset A`);
  validateFindingAsset(decision.asset_b, `${decision.sku} decision asset B`);
  assert(
    compareFindingAssets(decision.asset_a, decision.asset_b) < 0,
    `${decision.sku} decision pair is not in canonical SHA/slot order.`,
  );
  assert(
    decision.finding_key ===
      galleryVisualSimilarityFindingKey(
        decision.sku,
        decision.asset_a.sha256,
        decision.asset_b.sha256,
      ),
    `${decision.sku} decision finding key is invalid.`,
  );
  assert(
    Number.isInteger(decision.absolute_error_sum) &&
      decision.absolute_error_sum >= 0,
    `${decision.sku} decision absolute-error sum is invalid.`,
  );
  assert(
    decision.sample_count === GALLERY_VISUAL_SIMILARITY_POLICY.sample_count,
    `${decision.sku} decision sample count is invalid.`,
  );
  assert(
    decision.grayscale_mae ===
      normalizedMae(decision.absolute_error_sum, decision.sample_count),
    `${decision.sku} decision MAE does not match its exact integer metric.`,
  );
  assert(
    decision.grayscale_mae <=
      GALLERY_VISUAL_SIMILARITY_POLICY.maximum_grayscale_mae,
    `${decision.sku} decision is outside the reviewed near-duplicate threshold.`,
  );
  assert(
    decision.action === "SEMANTICALLY_DISTINCT" || decision.action === "DROP",
    `${decision.sku} decision action is invalid.`,
  );
  assert(nonEmptyString(decision.rationale), `${decision.sku} rationale is empty.`);
  assert(
    nonEmptyString(decision.visual_review_evidence),
    `${decision.sku} visual-review evidence is empty.`,
  );
  if (decision.action === "DROP") {
    const pair = new Set([decision.asset_a.sha256, decision.asset_b.sha256]);
    assert(
      isSha256(decision.keep_sha256) && pair.has(decision.keep_sha256),
      `${decision.sku} DROP keep SHA is invalid.`,
    );
    assert(
      isSha256(decision.drop_sha256) && pair.has(decision.drop_sha256),
      `${decision.sku} DROP asset SHA is invalid.`,
    );
    assert(
      decision.keep_sha256 !== decision.drop_sha256,
      `${decision.sku} DROP keeps and removes the same asset.`,
    );
  } else {
    assert(
      decision.keep_sha256 === null && decision.drop_sha256 === null,
      `${decision.sku} semantic-distinct decision must not contain a drop.`,
    );
    assert(
      decision.asset_a.component_key !== decision.asset_b.component_key &&
        decision.asset_a.component_key !== null &&
        decision.asset_b.component_key !== null,
      `${decision.sku} semantic-distinct decision must bind two distinct recipe components.`,
    );
  }
}

export function assertGalleryVisualSimilarityReviewArtifact(
  review: GalleryVisualSimilarityReviewArtifact,
  expectedSource: ExpectedGalleryVisualSimilaritySource,
): void {
  assert(
    review.schema_version === GALLERY_VISUAL_SIMILARITY_REVIEW_SCHEMA,
    "Unexpected gallery visual-similarity review schema.",
  );
  assert(
    review.status === "SEALED_LOCAL_HUMAN_REVIEW" && review.immutable === true,
    "Gallery visual-similarity review is not sealed/immutable.",
  );
  assert(nonEmptyString(review.reviewed_at), "Review timestamp is empty.");
  assert(Number.isFinite(Date.parse(review.reviewed_at)), "Review timestamp is invalid.");
  assert(nonEmptyString(review.reviewed_by), "Review author is empty.");
  assert(
    verifyUncrustablesLiveGalleryManifestSeal(review),
    "Gallery visual-similarity review body seal verification failed.",
  );
  assert(exactPolicyMatches(review.policy), "Visual-similarity policy drifted.");
  assert(
    nonEmptyString(review.source_gallery_plan?.path) &&
      review.source_gallery_plan.sha256 === expectedSource.sha256 &&
      review.source_gallery_plan.body_sha256 === expectedSource.body_sha256 &&
      isSha256(review.source_gallery_plan.sha256) &&
      isSha256(review.source_gallery_plan.body_sha256),
    "Visual-similarity review is not bound to the exact source gallery plan.",
  );
  assert(Array.isArray(review.decisions), "Visual-similarity decisions are absent.");
  const keys = new Set<string>();
  for (const decision of review.decisions) {
    validateDecision(decision);
    assert(
      !keys.has(decision.finding_key),
      `Duplicate visual-similarity decision ${decision.finding_key}.`,
    );
    keys.add(decision.finding_key);
  }
}

export function sealGalleryVisualSimilarityReviewBody(
  body: GalleryVisualSimilarityReviewBody,
): string {
  return sealUncrustablesLiveGalleryManifestBody(body);
}

/** Exact n-choose-2 count used to prove the screen covered every row pair. */
export function galleryVisualSimilarityPairCount(
  rows: readonly GalleryVisualSimilarityRowInput[],
): number {
  return rows.reduce(
    (count, row) => count + (row.assets.length * (row.assets.length - 1)) / 2,
    0,
  );
}

function resolveLocalAssetPath(root: string, localPath: string): string {
  assert(nonEmptyString(localPath), "Visual-similarity local asset path is empty.");
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, localPath);
  const relative = path.relative(resolvedRoot, resolved);
  assert(
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `Visual-similarity asset escapes the local root: ${localPath}`,
  );
  return resolved;
}

async function normalizedGrayscalePixels(
  root: string,
  asset: GalleryVisualSimilarityAssetInput,
): Promise<Buffer> {
  assert(isSha256(asset.sha256), `Invalid gallery asset SHA ${asset.sha256}.`);
  const localPath = resolveLocalAssetPath(root, asset.local_path);
  const source = await readFile(localPath);
  assert(
    sha256(source) === asset.sha256,
    `Local gallery asset SHA mismatch for ${asset.sha256}.`,
  );
  const pixels = await sharp(source, { failOn: "error" })
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize(
      GALLERY_VISUAL_SIMILARITY_POLICY.width,
      GALLERY_VISUAL_SIMILARITY_POLICY.height,
      {
        fit: "contain",
        background: "#ffffff",
        withoutEnlargement: false,
      },
    )
    .greyscale()
    .raw()
    .toBuffer();
  assert(
    pixels.length === GALLERY_VISUAL_SIMILARITY_POLICY.sample_count,
    `Unexpected normalized pixel count for ${asset.sha256}.`,
  );
  return pixels;
}

/** Exhaustively screen every distinct-SHA pair in every supplied gallery. */
export async function screenGalleryVisualSimilarity(
  rows: readonly GalleryVisualSimilarityRowInput[],
  options: { root?: string } = {},
): Promise<GalleryVisualSimilarityFinding[]> {
  assert(rows.length > 0, "Visual-similarity screen has no gallery rows.");
  const root = options.root ?? process.cwd();
  const seenSkus = new Set<string>();
  const canonicalPathBySha = new Map<string, string>();
  const normalizedBySha = new Map<string, Promise<Buffer>>();

  const pixels = (
    asset: GalleryVisualSimilarityAssetInput,
  ): Promise<Buffer> => {
    const resolved = resolveLocalAssetPath(root, asset.local_path);
    const priorPath = canonicalPathBySha.get(asset.sha256);
    assert(
      priorPath === undefined || priorPath === resolved,
      `Asset ${asset.sha256} maps to multiple local files in one screen.`,
    );
    canonicalPathBySha.set(asset.sha256, resolved);
    let pending = normalizedBySha.get(asset.sha256);
    if (!pending) {
      pending = normalizedGrayscalePixels(root, asset);
      normalizedBySha.set(asset.sha256, pending);
    }
    return pending;
  };

  const findings: GalleryVisualSimilarityFinding[] = [];
  for (const row of [...rows].sort((left, right) => left.sku.localeCompare(right.sku))) {
    assert(nonEmptyString(row.sku), "Gallery visual-similarity row SKU is empty.");
    assert(!seenSkus.has(row.sku), `Duplicate gallery row SKU ${row.sku}.`);
    seenSkus.add(row.sku);
    assert(Array.isArray(row.assets), `${row.sku} assets are absent.`);
    const seenSlots = new Set<string>();
    const seenSha = new Set<string>();
    for (const asset of row.assets) {
      assert(nonEmptyString(asset.slot), `${row.sku} has an empty gallery slot.`);
      assert(!seenSlots.has(asset.slot), `${row.sku} has duplicate slot ${asset.slot}.`);
      assert(isSha256(asset.sha256), `${row.sku}/${asset.slot} has an invalid SHA.`);
      assert(
        !seenSha.has(asset.sha256),
        `${row.sku} contains exact duplicate SHA ${asset.sha256}.`,
      );
      assert(
        asset.component_key === null || nonEmptyString(asset.component_key),
        `${row.sku}/${asset.slot} has an invalid component key.`,
      );
      seenSlots.add(asset.slot);
      seenSha.add(asset.sha256);
    }
    // Prove every local source before evaluating pairs. Awaiting the complete
    // row also prevents a decode/SHA failure from becoming an unhandled promise
    // when a malformed caller supplies fewer than two assets.
    await Promise.all(row.assets.map((asset) => pixels(asset)));

    for (let leftIndex = 0; leftIndex < row.assets.length; leftIndex++) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < row.assets.length;
        rightIndex++
      ) {
        const left = row.assets[leftIndex];
        const right = row.assets[rightIndex];
        const [leftPixels, rightPixels] = await Promise.all([
          pixels(left),
          pixels(right),
        ]);
        let absoluteErrorSum = 0;
        for (let index = 0; index < leftPixels.length; index++) {
          absoluteErrorSum += Math.abs(leftPixels[index] - rightPixels[index]);
        }
        const grayscaleMae = normalizedMae(
          absoluteErrorSum,
          GALLERY_VISUAL_SIMILARITY_POLICY.sample_count,
        );
        if (
          grayscaleMae >
          GALLERY_VISUAL_SIMILARITY_POLICY.maximum_grayscale_mae
        ) {
          continue;
        }
        const [assetA, assetB] = canonicalFindingAssets(
          {
            sha256: left.sha256,
            slot: left.slot,
            component_key: left.component_key,
          },
          {
            sha256: right.sha256,
            slot: right.slot,
            component_key: right.component_key,
          },
        );
        findings.push({
          finding_key: galleryVisualSimilarityFindingKey(
            row.sku,
            assetA.sha256,
            assetB.sha256,
          ),
          sku: row.sku,
          asset_a: assetA,
          asset_b: assetB,
          absolute_error_sum: absoluteErrorSum,
          sample_count: GALLERY_VISUAL_SIMILARITY_POLICY.sample_count,
          grayscale_mae: grayscaleMae,
        });
      }
    }
  }
  return findings.sort(
    (left, right) =>
      left.sku.localeCompare(right.sku) ||
      left.finding_key.localeCompare(right.finding_key),
  );
}

/**
 * Screen and enforce the sealed decisions. Structural/seal drift throws;
 * review-state failures are returned as `pass=false` for fail-closed planning.
 */
export async function enforceGalleryVisualSimilarityReview(
  rows: readonly GalleryVisualSimilarityRowInput[],
  review: GalleryVisualSimilarityReviewArtifact,
  expectedSource: ExpectedGalleryVisualSimilaritySource,
  options: { root?: string } = {},
): Promise<GalleryVisualSimilarityGateResult> {
  assertGalleryVisualSimilarityReviewArtifact(review, expectedSource);
  const findings = await screenGalleryVisualSimilarity(rows, options);
  const decisionsByKey = new Map(
    review.decisions.map((decision) => [decision.finding_key, decision]),
  );
  const rowsBySku = new Map(rows.map((row) => [row.sku, row]));
  const errors: string[] = [];
  const semanticallyDistinctFindings: GalleryVisualSimilarityFinding[] = [];
  const requiredDrops: GalleryVisualSimilarityRequiredDrop[] = [];
  const unreviewedFindings: GalleryVisualSimilarityFinding[] = [];
  const staleOrMismatchedDecisions: GalleryVisualSimilarityReviewDecision[] = [];
  const matchedDecisionKeys = new Set<string>();

  for (const finding of findings) {
    const decision = decisionsByKey.get(finding.finding_key);
    if (!decision) {
      unreviewedFindings.push(finding);
      errors.push(`UNREVIEWED_NEAR_DUPLICATE:${finding.finding_key}`);
      continue;
    }
    matchedDecisionKeys.add(decision.finding_key);
    if (!findingMatchesDecision(finding, decision)) {
      staleOrMismatchedDecisions.push(decision);
      errors.push(`REVIEW_DECISION_FINDING_MISMATCH:${finding.finding_key}`);
      continue;
    }
    if (decision.action === "DROP") {
      requiredDrops.push({ finding, decision });
      errors.push(`REVIEWED_NEAR_DUPLICATE_REQUIRES_DROP:${finding.finding_key}`);
    } else {
      semanticallyDistinctFindings.push(finding);
    }
  }

  const resolvedDropDecisions: GalleryVisualSimilarityReviewDecision[] = [];
  for (const decision of review.decisions) {
    if (matchedDecisionKeys.has(decision.finding_key)) continue;
    const row = rowsBySku.get(decision.sku);
    const presentSha = new Set(row?.assets.map((asset) => asset.sha256) ?? []);
    if (
      decision.action === "DROP" &&
      decision.drop_sha256 !== null &&
      decision.keep_sha256 !== null &&
      !presentSha.has(decision.drop_sha256) &&
      presentSha.has(decision.keep_sha256)
    ) {
      resolvedDropDecisions.push(decision);
      continue;
    }
    staleOrMismatchedDecisions.push(decision);
    errors.push(`STALE_OR_UNRESOLVED_REVIEW_DECISION:${decision.finding_key}`);
  }

  return {
    pass: errors.length === 0,
    errors,
    evaluated_pair_count: galleryVisualSimilarityPairCount(rows),
    findings,
    semantically_distinct_findings: semanticallyDistinctFindings,
    required_drops: requiredDrops,
    resolved_drop_decisions: resolvedDropDecisions,
    unreviewed_findings: unreviewedFindings,
    stale_or_mismatched_decisions: staleOrMismatchedDecisions,
  };
}

/** Extract row-scoped reviewed drops after the artifact/source seal is proven. */
export function reviewedGalleryVisualDropShaBySku(
  review: GalleryVisualSimilarityReviewArtifact,
  expectedSource: ExpectedGalleryVisualSimilaritySource,
): Map<string, Set<string>> {
  assertGalleryVisualSimilarityReviewArtifact(review, expectedSource);
  const result = new Map<string, Set<string>>();
  for (const decision of review.decisions) {
    if (decision.action !== "DROP" || decision.drop_sha256 === null) continue;
    const drops = result.get(decision.sku) ?? new Set<string>();
    drops.add(decision.drop_sha256);
    result.set(decision.sku, drops);
  }
  return result;
}
