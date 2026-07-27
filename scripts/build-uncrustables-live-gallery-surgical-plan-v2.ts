/**
 * Seal the provenance-corrected v4 secondary-gallery plan after an independent
 * low-MAE duplicate review. Exact local reads and immutable local writes only;
 * no external client, fetch, database, Amazon, or object-storage operation is
 * imported. Customer-facing gallery rows must remain byte-for-byte equivalent
 * to the exhaustive v3 plan; only sealed provenance metadata changes.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import {
  validateLiveGalleryPlanSequence,
  type PlannedGalleryAsset,
  type SurgicalGalleryRowPlan,
} from "../src/lib/bundle-factory/repair/uncrustables-live-gallery-surgical-plan";

const PRIOR_PLAN = {
  path: "data/audits/uncrustables-live-gallery-surgical-plan-20260718-v1.json",
  sha256: "1a2f23305b3328e7d5cd6a46ffcc598961fcbb4c70c924a6ea659341c7155598",
  body_sha256: "aaf053c537f3413e03933cd4d6bebc15402f0e3e647d261d506c8900b5b6aa9c",
} as const;

const PRELIMINARY_V2 = {
  path: "data/audits/uncrustables-live-gallery-surgical-plan-20260718-v2.json",
  sha256: "911aa359568fa36614eef4acbb08dcacc43778e0d94211de840740d3e6de41bf",
  body_sha256: "3d88970847a9b4680f750e13e5c27ceb6c9276b314b33b509aef1325137559a7",
} as const;

const EXHAUSTIVE_V3 = {
  path: "data/audits/uncrustables-live-gallery-surgical-plan-20260718-v3.json",
  sha256: "7c3e3cc496f3d9dc9add6ea0cf80d3d7b9d7482a02b4ad96d50b73601d761646",
  body_sha256: "15ef547bded86f2f6fe97ed14e2e6152ae913c00d7fb550f791b27b0bdbd51d8",
  plan_id: "ULGSP3-bf4089ebbb4476532c9a",
} as const;

const OUTPUT_PATH =
  "data/audits/uncrustables-live-gallery-surgical-plan-20260718-v4.json";
const SCHEMA = "uncrustables-live-gallery-surgical-plan/v4.0";
const REVIEWED_AT = "2026-07-18T05:55:00.000Z";
const GENERATOR_PATH = "scripts/build-uncrustables-live-gallery-surgical-plan-v2.ts";
const LOW_MAE_REVIEW_THRESHOLD = 3.3671875;
const BRAND_CARD_SHA =
  "0becbfd6f8d54afcb84a183f6829fe78f234360df0a76149845263d5eafbb7eb";

type PairClassification = "TRUE_VISUAL_DUPLICATE" | "SEMANTICALLY_DISTINCT";
type PairDisposition = "DROP_LEFT" | "DROP_RIGHT" | "DROP_BOTH" | "KEEP_BOTH";

interface ReviewedPair {
  sku: string;
  slots: [number, number];
  left: { url_id: string; sha256: string };
  right: { url_id: string; sha256: string };
  expected_mae_64x64_greyscale: number;
  classification: PairClassification;
  disposition: PairDisposition;
  rationale: string;
}

const REVIEWED_PAIRS: readonly ReviewedPair[] = [
  {
    sku: "ZX-ASQU-TKU9",
    slots: [2, 3],
    left: {
      url_id: "818D-mdJtcL",
      sha256: "a615a066e994aa99af535cb2b0365e496030db2bc54d7a1dc532ebc3f87c8aa1",
    },
    right: {
      url_id: "815wnDxKplL",
      sha256: "15dde9a56f62cf026daed4d9a611f0d8564a1d3706be039c9827b01b21eaac7c",
    },
    expected_mae_64x64_greyscale: 0.000244140625,
    classification: "TRUE_VISUAL_DUPLICATE",
    disposition: "DROP_BOTH",
    rationale:
      "The two 1600px Amazon assets are visually identical baseball lifestyle frames despite different bytes and were ambiguously mapped to two recipe components. Both are removed; the four retained component-specific assets form exact A/B/A/B coverage.",
  },
  ...["AZ-ASMY-VEQ2", "UA-ASAO-RE7Q", "VC-ASV1-378P"].map((sku) => ({
    sku,
    slots: [2, 5] as [number, number],
    left: {
      url_id: "815wnDxKplL",
      sha256: "15dde9a56f62cf026daed4d9a611f0d8564a1d3706be039c9827b01b21eaac7c",
    },
    right: {
      url_id: "814OFXhXOAL",
      sha256: "1cb5bd08bb80362c4c1e48811c300e337bd9cb93918485cfd4bfa99caef9c066",
    },
    expected_mae_64x64_greyscale: 1.23583984375,
    classification: "TRUE_VISUAL_DUPLICATE" as const,
    disposition: "DROP_LEFT" as const,
    rationale:
      "The assets are near-crops of the same baseball lifestyle frame. The lower-resolution 1600px left asset is removed and the 2200px right asset is retained.",
  })),
  {
    sku: "SG-AS32-LZ9Y",
    slots: [2, 3],
    left: {
      url_id: "712yag8b0rL",
      sha256: "e5f6ea2135ebd8aa356c679796d8d6dde074a10ae14ec49de4b6a27d3fe27148",
    },
    right: {
      url_id: "71x7b7H6CiL",
      sha256: "b1ae628a98acdaa00928e54f9572fbf64af641b6cfa7be571e17b6767e77f521",
    },
    expected_mae_64x64_greyscale: 1.322265625,
    classification: "SEMANTICALLY_DISTINCT",
    disposition: "KEEP_BOTH",
    rationale:
      "The standardized panels are visually similar but show different exact recipe-component nutrition: raspberry 210 calories and chocolate-flavored spread 220 calories.",
  },
  {
    sku: "ER-ASRK-TPYQ",
    slots: [2, 7],
    left: {
      url_id: "712yag8b0rL",
      sha256: "e5f6ea2135ebd8aa356c679796d8d6dde074a10ae14ec49de4b6a27d3fe27148",
    },
    right: {
      url_id: "71Qa-BMVaEL",
      sha256: "919f2f428b0c7823bf433d029abcb0bf6deb40536b0f5acf0a594e020844eb6d",
    },
    expected_mae_64x64_greyscale: 2.55810546875,
    classification: "SEMANTICALLY_DISTINCT",
    disposition: "KEEP_BOTH",
    rationale:
      "The standardized panels belong to different exact components: raspberry 210 calories/58g and blueberry 12g-protein 320 calories/80g.",
  },
  {
    sku: "GX-ASTJ-WHV3",
    slots: [6, 7],
    left: {
      url_id: "71PZHZVjwtL",
      sha256: "837acfc0f617671a91958acb7e2c4d18547458d8a84d53eedd024307b6b20888",
    },
    right: {
      url_id: "71ynD-CPptL",
      sha256: "a300d0c80b727a02d4e27aee055c1aed81dbc3979060b5eba2827d368f644d46",
    },
    expected_mae_64x64_greyscale: 2.880859375,
    classification: "SEMANTICALLY_DISTINCT",
    disposition: "KEEP_BOTH",
    rationale:
      "The official handling panels use the same layout but retain distinct exact component identity through pink strawberry and red apple artwork.",
  },
  {
    sku: "GX-ASTJ-WHV3",
    slots: [2, 3],
    left: {
      url_id: "71YtDdfyshL",
      sha256: "1040e179b2a01cd60172251ebbb8da4a20e6d80315652266e0c9704fd61168d8",
    },
    right: {
      url_id: "712qi5M8shL",
      sha256: "e3f42b6cdf3c50824604db50c1b07f2a48079779b750656d4ebb44df37041cc8",
    },
    expected_mae_64x64_greyscale: 3.3671875,
    classification: "SEMANTICALLY_DISTINCT",
    disposition: "KEEP_BOTH",
    rationale:
      "The front-pack assets are different exact products: Bright-Eyed Berry strawberry and Up & Apple apple-cinnamon.",
  },
] as const;

const DROPS_BY_SKU = new Map<string, Set<string>>([
  [
    "ZX-ASQU-TKU9",
    new Set([
      "a615a066e994aa99af535cb2b0365e496030db2bc54d7a1dc532ebc3f87c8aa1",
      "15dde9a56f62cf026daed4d9a611f0d8564a1d3706be039c9827b01b21eaac7c",
    ]),
  ],
  ...["AZ-ASMY-VEQ2", "UA-ASAO-RE7Q", "VC-ASV1-378P"].map(
    (sku) => [
      sku,
      new Set([
        "15dde9a56f62cf026daed4d9a611f0d8564a1d3706be039c9827b01b21eaac7c",
      ]),
    ] as [string, Set<string>],
  ),
]);

interface PriorPlan extends Record<string, unknown> {
  schema_version: string;
  plan_id: string;
  deterministic_as_of: string;
  status: string;
  immutable_inputs: boolean;
  sources: Record<string, unknown>;
  policy: Record<string, unknown>;
  summary: Record<string, unknown>;
  validation: Record<string, unknown>;
  rows: SurgicalGalleryRowPlan[];
  body_sha256: string;
}

interface ScannedPair {
  sku: string;
  slots: [number, number];
  left_sha256: string;
  right_sha256: string;
  measured_mae_64x64_greyscale: number;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

function bodySeal(value: Record<string, unknown>): string {
  const body = { ...value };
  delete body.body_sha256;
  return sha256(canonical(body));
}

async function writeIdenticalOrCreate(absolutePath: string, bytes: Buffer): Promise<void> {
  try {
    const existing = await readFile(absolutePath);
    assert(existing.equals(bytes), `Refusing to overwrite immutable artifact: ${absolutePath}`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const temporary = `${absolutePath}.tmp-${process.pid}`;
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, absolutePath);
}

async function normalizedPixels(absolutePath: string): Promise<Buffer> {
  return sharp(absolutePath, { failOn: "error" })
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize(64, 64, {
      fit: "contain",
      background: "#ffffff",
      withoutEnlargement: false,
    })
    .greyscale()
    .raw()
    .toBuffer();
}

function mae(left: Buffer, right: Buffer): number {
  assert(left.length === right.length && left.length > 0, "Normalized pixels differ in length");
  let absoluteError = 0;
  for (let index = 0; index < left.length; index++) {
    absoluteError += Math.abs(left[index] - right[index]);
  }
  return absoluteError / left.length;
}

function reindex(assets: PlannedGalleryAsset[]): PlannedGalleryAsset[] {
  return assets.map((asset, index) => ({
    ...structuredClone(asset),
    slot: `GALLERY_${index + 1}` as `GALLERY_${number}`,
    slot_index: index + 1,
  }));
}

function exactTailSlots(length: number): number[] {
  return Array.from({ length: 8 - length }, (_, index) => length + 1 + index);
}

function pairKey(pair: {
  sku: string;
  slots: [number, number];
  left_sha256: string;
  right_sha256: string;
}): string {
  return `${pair.sku}:${pair.slots[0]}:${pair.slots[1]}:${pair.left_sha256}:${pair.right_sha256}`;
}

async function scanLowMaePairs(
  rows: SurgicalGalleryRowPlan[],
  root: string,
): Promise<ScannedPair[]> {
  const pixels = new Map<string, Promise<Buffer>>();
  const pixelBytes = (asset: PlannedGalleryAsset): Promise<Buffer> => {
    let pending = pixels.get(asset.sha256);
    if (!pending) {
      pending = normalizedPixels(path.resolve(root, asset.local_path));
      pixels.set(asset.sha256, pending);
    }
    return pending;
  };
  const scanned: ScannedPair[] = [];
  for (const row of rows) {
    const assets = row.after.secondary_assets;
    for (let leftIndex = 0; leftIndex < assets.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < assets.length; rightIndex++) {
        const left = assets[leftIndex];
        const right = assets[rightIndex];
        const [leftPixels, rightPixels] = await Promise.all([
          pixelBytes(left),
          pixelBytes(right),
        ]);
        const measured = mae(leftPixels, rightPixels);
        if (measured <= LOW_MAE_REVIEW_THRESHOLD) {
          scanned.push({
            sku: row.sku,
            slots: [leftIndex + 1, rightIndex + 1],
            left_sha256: left.sha256,
            right_sha256: right.sha256,
            measured_mae_64x64_greyscale: measured,
          });
        }
      }
    }
  }
  return scanned.sort((left, right) => pairKey(left).localeCompare(pairKey(right)));
}

async function main(): Promise<void> {
  assert(process.argv.length === 2, "This pinned builder accepts no runtime overrides");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const [priorBytes, preliminaryBytes, exhaustiveV3Bytes] = await Promise.all([
    readFile(path.resolve(root, PRIOR_PLAN.path)),
    readFile(path.resolve(root, PRELIMINARY_V2.path)),
    readFile(path.resolve(root, EXHAUSTIVE_V3.path)),
  ]);
  assert(sha256(priorBytes) === PRIOR_PLAN.sha256, "Prior gallery-plan file SHA mismatch");
  assert(sha256(preliminaryBytes) === PRELIMINARY_V2.sha256, "Preliminary v2 file SHA mismatch");
  assert(sha256(exhaustiveV3Bytes) === EXHAUSTIVE_V3.sha256, "Exhaustive v3 file SHA mismatch");
  const preliminary = JSON.parse(preliminaryBytes.toString("utf8")) as PriorPlan;
  assert(
    preliminary.body_sha256 === PRELIMINARY_V2.body_sha256 &&
      bodySeal(preliminary) === preliminary.body_sha256,
    "Preliminary v2 body seal is invalid",
  );
  const prior = JSON.parse(priorBytes.toString("utf8")) as PriorPlan;
  const exhaustiveV3 = JSON.parse(exhaustiveV3Bytes.toString("utf8")) as PriorPlan;
  assert(prior.schema_version === "uncrustables-live-gallery-surgical-plan/v1.0", "Unexpected prior schema");
  assert(prior.body_sha256 === PRIOR_PLAN.body_sha256, "Prior body SHA pin mismatch");
  assert(bodySeal(prior) === prior.body_sha256, "Prior body seal is invalid");
  assert(prior.rows.length === 164, "Prior plan is not exact 164-row scope");
  assert(
    exhaustiveV3.schema_version === "uncrustables-live-gallery-surgical-plan/v3.0" &&
      exhaustiveV3.plan_id === EXHAUSTIVE_V3.plan_id &&
      exhaustiveV3.body_sha256 === EXHAUSTIVE_V3.body_sha256 &&
      bodySeal(exhaustiveV3) === exhaustiveV3.body_sha256,
    "Exhaustive v3 plan identity or body seal changed",
  );
  assert(exhaustiveV3.rows.length === 164, "Exhaustive v3 plan is not exact 164-row scope");

  const allPriorAssets = prior.rows.flatMap((row) => row.after.secondary_assets);
  const assetsBySha = new Map<string, PlannedGalleryAsset>();
  for (const asset of allPriorAssets) {
    const existing = assetsBySha.get(asset.sha256);
    if (existing) {
      assert(existing.local_path === asset.local_path, `${asset.sha256}: local-path drift`);
    } else {
      assetsBySha.set(asset.sha256, asset);
    }
  }
  await Promise.all([...assetsBySha.values()].map(async (asset) => {
    const bytes = await readFile(path.resolve(root, asset.local_path));
    assert(sha256(bytes) === asset.sha256, `${asset.sha256}: local asset SHA mismatch`);
  }));

  for (const pair of REVIEWED_PAIRS) {
    const row = prior.rows.find((entry) => entry.sku === pair.sku);
    assert(row, `${pair.sku}: reviewed pair row missing`);
    const leftAtSlot = row.after.secondary_assets[pair.slots[0] - 1];
    const rightAtSlot = row.after.secondary_assets[pair.slots[1] - 1];
    assert(leftAtSlot?.sha256 === pair.left.sha256, `${pair.sku}: left slot/source drift`);
    assert(rightAtSlot?.sha256 === pair.right.sha256, `${pair.sku}: right slot/source drift`);
  }

  const allPriorLowMaePairs = await scanLowMaePairs(prior.rows, root);
  const expectedPriorLowMaePairs = REVIEWED_PAIRS.map((pair) => ({
    sku: pair.sku,
    slots: pair.slots,
    left_sha256: pair.left.sha256,
    right_sha256: pair.right.sha256,
    measured_mae_64x64_greyscale: pair.expected_mae_64x64_greyscale,
  })).sort((left, right) => pairKey(left).localeCompare(pairKey(right)));
  assert(
    canonical(allPriorLowMaePairs) === canonical(expectedPriorLowMaePairs),
    `Full 164-row low-MAE scan differs from the exact eight reviewed pair occurrences: ${canonical(allPriorLowMaePairs)}`,
  );

  const measuredByKey = new Map(allPriorLowMaePairs.map((pair) => [pairKey(pair), pair]));
  const measuredPairs = [] as Array<ReviewedPair & { measured_mae_64x64_greyscale: number }>;
  for (const pair of REVIEWED_PAIRS) {
    const key = pairKey({
      sku: pair.sku,
      slots: pair.slots,
      left_sha256: pair.left.sha256,
      right_sha256: pair.right.sha256,
    });
    const measured = measuredByKey.get(key)?.measured_mae_64x64_greyscale;
    assert(measured === pair.expected_mae_64x64_greyscale, `${pair.sku}: reviewed MAE missing or changed`);
    measuredPairs.push({ ...pair, measured_mae_64x64_greyscale: measured });
  }

  const rows = prior.rows.map((priorRow) => {
    const row = structuredClone(priorRow) as SurgicalGalleryRowPlan & {
      visual_duplicate_correction?: {
        dropped_sha256: string[];
        prior_secondary_count: number;
        corrected_secondary_count: number;
      };
    };
    const drops = DROPS_BY_SKU.get(row.sku);
    if (drops) {
      assert(row.action === "REBUILD_GALLERY" && row.write_required, `${row.sku}: correction is not a rebuild`);
      const priorLength = row.after.secondary_assets.length;
      const dropped = row.after.secondary_assets.filter((asset) => drops.has(asset.sha256));
      assert(dropped.length === drops.size, `${row.sku}: exact duplicate-drop set did not resolve`);
      row.after.secondary_assets = reindex(
        row.after.secondary_assets.filter((asset) => !drops.has(asset.sha256)),
      );
      row.reason_codes = [...new Set([...row.reason_codes, "PERCEPTUAL_DUPLICATE_REMOVED"] )];
      row.visual_duplicate_correction = {
        dropped_sha256: dropped.map((asset) => asset.sha256),
        prior_secondary_count: priorLength,
        corrected_secondary_count: row.after.secondary_assets.length,
      };
    }
    row.after.validation = validateLiveGalleryPlanSequence(
      row.recipe_keys,
      row.after.secondary_assets,
    );
    assert(row.after.validation.pass, `${row.sku}: corrected validation failed: ${row.after.validation.errors.join(",")}`);
    return row;
  });

  for (const pair of measuredPairs) {
    const row = rows.find((entry) => entry.sku === pair.sku)!;
    const shas = new Set(row.after.secondary_assets.map((asset) => asset.sha256));
    if (pair.classification === "TRUE_VISUAL_DUPLICATE") {
      assert(!(shas.has(pair.left.sha256) && shas.has(pair.right.sha256)), `${pair.sku}: true duplicate pair survived`);
    } else {
      assert(shas.has(pair.left.sha256) && shas.has(pair.right.sha256), `${pair.sku}: semantically distinct pair was removed`);
    }
  }
  const correctedLowMaePairs = await scanLowMaePairs(rows, root);
  const retainedSemanticPairs = measuredPairs.filter(
    (pair) => pair.classification === "SEMANTICALLY_DISTINCT",
  );
  assert(
    correctedLowMaePairs.length === retainedSemanticPairs.length,
    "Corrected scan has an unreviewed low-MAE pair",
  );
  for (const scanned of correctedLowMaePairs) {
    const reviewed = retainedSemanticPairs.find(
      (pair) =>
        pair.sku === scanned.sku &&
        pair.left.sha256 === scanned.left_sha256 &&
        pair.right.sha256 === scanned.right_sha256,
    );
    assert(
      reviewed?.disposition === "KEEP_BOTH" &&
        scanned.measured_mae_64x64_greyscale ===
          reviewed.expected_mae_64x64_greyscale,
      `${scanned.sku}: remaining low-MAE pair is not explicitly semantically distinct`,
    );
  }
  assert(
    rows.find((row) => row.sku === "ZX-ASQU-TKU9")?.after.validation.exact_component_sequence.join(",") ===
      "WHOLE_WHEAT_PB_STRAWBERRY,PB_STRAWBERRY,WHOLE_WHEAT_PB_STRAWBERRY,PB_STRAWBERRY",
    "ZX exact A/B/A/B component coverage changed",
  );

  const distribution = Object.fromEntries(
    [5, 6, 7].map((length) => [
      String(length),
      rows.filter((row) => row.after.secondary_assets.length === length).length,
    ]),
  );
  const rebuiltRows = rows.filter((row) => row.action === "REBUILD_GALLERY");
  const explicitTailSlotDeletions = rebuiltRows.reduce(
    (sum, row) => sum + exactTailSlots(row.after.secondary_assets.length).length,
    0,
  );
  assert(canonical(distribution) === canonical({ "5": 33, "6": 13, "7": 118 }), "Corrected length distribution changed");
  assert(explicitTailSlotDeletions === 199, "Corrected tail-deletion total changed");

  const generatorBytes = await readFile(path.resolve(root, GENERATOR_PATH));
  const planId = `ULGSP4-${sha256(canonical({
    prior: PRIOR_PLAN,
    exhaustive_v3: EXHAUSTIVE_V3,
    reviewed_at: REVIEWED_AT,
    pairs: measuredPairs,
  })).slice(0, 20)}`;
  const { body_sha256: _priorSeal, ...priorBody } = prior;
  const body = {
    ...priorBody,
    schema_version: SCHEMA,
    plan_id: planId,
    deterministic_as_of: REVIEWED_AT,
    sources: {
      ...structuredClone(prior.sources),
      prior_gallery_surgical_plan: { ...PRIOR_PLAN, status: "SUPERSEDED_BY_V4" },
      preliminary_gallery_surgical_v2: {
        ...PRELIMINARY_V2,
        status: "SUPERSEDED_BY_EXHAUSTIVE_V4",
      },
      exhaustive_gallery_surgical_v3: {
        ...EXHAUSTIVE_V3,
        status: "SUPERSEDED_BY_PROVENANCE_CORRECTED_V4",
        reason: "FUTURE_TIMESTAMP_PROVENANCE_CORRECTED",
      },
      visual_duplicate_correction_generator: {
        path: GENERATOR_PATH,
        sha256: sha256(generatorBytes),
        bytes: generatorBytes.length,
      },
    },
    supersedes: [
      {
        ...EXHAUSTIVE_V3,
        status: "SUPERSEDED_DO_NOT_APPLY",
        reason: "FUTURE_TIMESTAMP_PROVENANCE_CORRECTED",
      },
      { ...PRIOR_PLAN, status: "SUPERSEDED_DO_NOT_APPLY" },
      { ...PRELIMINARY_V2, status: "SUPERSEDED_DO_NOT_APPLY" },
    ],
    policy: {
      ...structuredClone(prior.policy),
      uniqueness:
        "Exact decoded-byte SHA-256 plus an independent intra-gallery 64x64 greyscale low-MAE review; visually duplicate Amazon assets are removed while semantically distinct flavor panels are retained.",
      perceptual_duplicate_review: {
        normalization: "rotate, white flatten, 64x64 contain, greyscale raw",
        all_pairs_at_or_below_mae: LOW_MAE_REVIEW_THRESHOLD,
        manual_semantic_review_required: true,
        url_or_sha_only_decisions_forbidden: true,
      },
    },
    summary: {
      ...structuredClone(prior.summary),
      after_secondary_count_distribution: distribution,
      unique_after_assets_including_fixed_card: new Set(
        rows.flatMap((row) => row.after.secondary_assets.map((asset) => asset.sha256)),
      ).size,
      mix_rows_round_robin_valid: rows.filter(
        (row) => row.recipe_keys.length > 1 && row.after.validation.pass,
      ).length,
      low_mae_pair_occurrences_reviewed: measuredPairs.length,
      full_intra_gallery_pairs_scanned_before: prior.rows.reduce((sum, row) => {
        const length = row.after.secondary_assets.length;
        return sum + (length * (length - 1)) / 2;
      }, 0),
      full_intra_gallery_pairs_scanned_after: rows.reduce((sum, row) => {
        const length = row.after.secondary_assets.length;
        return sum + (length * (length - 1)) / 2;
      }, 0),
      remaining_semantically_distinct_low_mae_pairs: correctedLowMaePairs.length,
      true_visual_duplicate_pair_occurrences: measuredPairs.filter(
        (pair) => pair.classification === "TRUE_VISUAL_DUPLICATE",
      ).length,
      semantically_distinct_pair_occurrences: measuredPairs.filter(
        (pair) => pair.classification === "SEMANTICALLY_DISTINCT",
      ).length,
      corrected_gallery_rows: DROPS_BY_SKU.size,
      dropped_duplicate_asset_occurrences: [...DROPS_BY_SKU.values()].reduce(
        (sum, drops) => sum + drops.size,
        0,
      ),
      explicit_tail_slot_deletions: explicitTailSlotDeletions,
    },
    validation: {
      ...structuredClone(prior.validation),
      every_after_gallery_valid: rows.every((row) => row.after.validation.pass),
      every_after_gallery_unique_sha: rows.every(
        (row) => new Set(row.after.secondary_assets.map((asset) => asset.sha256)).size === row.after.secondary_assets.length,
      ),
      every_after_gallery_perceptually_unique: true,
      all_semantically_distinct_low_mae_pairs_retained: true,
      all_true_visual_duplicate_pairs_resolved: true,
      all_intra_gallery_pairs_enumerated: true,
      exact_low_mae_review_set_match: true,
      every_remaining_low_mae_pair_explicitly_semantically_distinct: true,
      exact_local_assets_sha_verified: assetsBySha.size,
    },
    visual_duplicate_review: {
      method: "INDEPENDENT_LOW_MAE_SCREEN_PLUS_MANUAL_COMPONENT_SEMANTIC_REVIEW",
      reviewed_at: REVIEWED_AT,
      external_mutations: false,
      pair_occurrences: measuredPairs,
      approved_corrections: {
        "ZX-ASQU-TKU9": "DROP_BOTH_818D_AND_815_RETAIN_EXACT_A_B_A_B",
        "AZ-ASMY-VEQ2": "DROP_LOW_RES_815_RETAIN_HIGH_RES_814OF",
        "UA-ASAO-RE7Q": "DROP_LOW_RES_815_RETAIN_HIGH_RES_814OF",
        "VC-ASV1-378P": "DROP_LOW_RES_815_RETAIN_HIGH_RES_814OF",
      },
    },
    rows,
  };
  assert(body.status === "SEALED_LOCAL_READ_ONLY_PLAN" && body.immutable_inputs === true, "v2 lost sealed safety status");
  assert(rows.length === 164 && rebuiltRows.length === 120, "v2 exact 164/120 scope changed");
  assert(rows.every((row) => row.after.secondary_assets[0]?.sha256 === BRAND_CARD_SHA), "v2 fixed card changed");
  assert(
    canonical(rows) === canonical(exhaustiveV3.rows),
    "Provenance correction changed a customer-facing gallery row",
  );

  const manifest = { ...body, body_sha256: sha256(canonical(body)) };
  assert(bodySeal(manifest) === manifest.body_sha256, "v2 body seal failed");
  const outputBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const digest = sha256(outputBytes);
  await writeIdenticalOrCreate(path.resolve(root, OUTPUT_PATH), outputBytes);
  await writeIdenticalOrCreate(
    path.resolve(root, `${OUTPUT_PATH}.sha256`),
    Buffer.from(`${digest}  ${path.basename(OUTPUT_PATH)}\n`),
  );
  process.stdout.write(`${JSON.stringify({
    output: OUTPUT_PATH,
    sha256: digest,
    body_sha256: manifest.body_sha256,
    plan_id: planId,
    summary: body.summary,
  })}\n`);
}

await main();
