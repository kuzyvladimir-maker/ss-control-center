/** Convert the provenance-corrected gallery surgical v4 plan into a pure MEDIA
 * desired-state carrier. Offline exact reads and immutable local writes only.
 * The customer-facing MEDIA payload must stay identical to carrier v4. */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DesiredRepairManifest } from
  "../src/lib/bundle-factory/repair/uncrustables-surgical";
import type { SurgicalGalleryRowPlan } from
  "../src/lib/bundle-factory/repair/uncrustables-live-gallery-surgical-plan";

const PLAN = {
  path: "data/audits/uncrustables-live-gallery-surgical-plan-20260718-v4.json",
  sha256: "ae345407a4b95232941cdcaa3836fc85ba87ca6d9cf94988f797253d90025469",
  body_sha256: "1a3f88771d7f3acce217f447fe13d28de570f3c0f50defeadbde817d6eb1586d",
  plan_id: "ULGSP4-cf5c5288f7c44536d202",
} as const;
const PRELIMINARY_CARRIER = {
  path: "data/repairs/uncrustables-gallery-media-desired-20260718-v3.json",
  sha256: "dffafb52b56c690edab63c51378dcd19d6c2f9c863f0e69429d99b62f87eb85b",
  body_sha256: "e733975f98672c6a7e546c502f9c33c0a471c882f232821bea4b67f1312ad1a2",
} as const;
const FUTURE_TIMESTAMP_CARRIER_V4 = {
  path: "data/repairs/uncrustables-gallery-media-desired-20260718-v4.json",
  sha256: "9e01d4d5e61ec36edb6245d9147ea55f03ed0b0661b3e6241d8c8ad8447ff713",
  body_sha256: "78cc3feec6ca3541a7de86c9d041c9f941cb30af191c5739942bdc2dd2ba9120",
} as const;
const LEDGER_SHA =
  "46a80e727880d83bd9e52a1c58c753eeeede0cb8cbdd3443e825aba9cbaaa02f";
const OUTPUT_PATH =
  "data/repairs/uncrustables-gallery-media-desired-20260718-v5.json";
const REVIEWED_AT = "2026-07-18T05:55:00.000Z";
const BRAND_CARD = "https://m.media-amazon.com/images/I/81OibsvvU0L.jpg";
const BRAND_CARD_SHA =
  "0becbfd6f8d54afcb84a183f6829fe78f234360df0a76149845263d5eafbb7eb";

interface GalleryPlan extends Record<string, unknown> {
  schema_version: string;
  plan_id: string;
  deterministic_as_of: string;
  status: string;
  immutable_inputs: boolean;
  body_sha256: string;
  sources: { source_ledger: { sha256: string } };
  summary: {
    listing_rows: number;
    keep_no_write: number;
    rebuild_gallery: number;
    after_validation_fail: number;
    explicit_tail_slot_deletions: number;
    corrected_gallery_rows: number;
    low_mae_pair_occurrences_reviewed: number;
    full_intra_gallery_pairs_scanned_before: number;
    full_intra_gallery_pairs_scanned_after: number;
  };
  validation: {
    every_after_gallery_perceptually_unique: boolean;
    all_true_visual_duplicate_pairs_resolved: boolean;
    all_semantically_distinct_low_mae_pairs_retained: boolean;
    all_intra_gallery_pairs_enumerated: boolean;
    exact_low_mae_review_set_match: boolean;
    every_remaining_low_mae_pair_explicitly_semantically_distinct: boolean;
  };
  rows: Array<SurgicalGalleryRowPlan & {
    visual_duplicate_correction?: {
      dropped_sha256: string[];
      prior_secondary_count: number;
      corrected_secondary_count: number;
    };
  }>;
}

interface MediaCarrier extends DesiredRepairManifest {
  source_artifacts: {
    gallery_surgical_plan_v4: typeof PLAN;
  };
  supersedes: Array<{
    path: string;
    sha256: string;
    body_sha256: string;
    status: "SUPERSEDED_DO_NOT_APPLY";
    reason: string;
  }>;
  carrier_policy: {
    media_only: true;
    main_image_excluded: true;
    exact_ordered_gallery: true;
    exact_tail_complement: true;
    perceptual_duplicate_review_required: true;
  };
  summary: {
    exact_live_scope: 164;
    keep_no_write: 44;
    media_repairs: 120;
    corrected_duplicate_rows: 4;
    explicit_tail_slot_deletions: 199;
  };
  body_sha256: string;
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

function exactTailSlots(length: number): number[] {
  return Array.from({ length: 8 - length }, (_, index) => length + 1 + index);
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

async function main(): Promise<void> {
  assert(process.argv.length === 2, "This pinned builder accepts no runtime overrides");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const [planBytes, preliminaryBytes, priorCarrierBytes] = await Promise.all([
    readFile(path.resolve(root, PLAN.path)),
    readFile(path.resolve(root, PRELIMINARY_CARRIER.path)),
    readFile(path.resolve(root, FUTURE_TIMESTAMP_CARRIER_V4.path)),
  ]);
  assert(sha256(planBytes) === PLAN.sha256, "Gallery v4 file SHA mismatch");
  assert(sha256(preliminaryBytes) === PRELIMINARY_CARRIER.sha256, "Preliminary carrier SHA mismatch");
  assert(
    sha256(priorCarrierBytes) === FUTURE_TIMESTAMP_CARRIER_V4.sha256,
    "Future-timestamp carrier v4 SHA mismatch",
  );
  const preliminary = JSON.parse(preliminaryBytes.toString("utf8")) as Record<string, unknown>;
  assert(
    preliminary.body_sha256 === PRELIMINARY_CARRIER.body_sha256 &&
      bodySeal(preliminary) === preliminary.body_sha256,
    "Preliminary carrier body seal failed",
  );
  const priorCarrier = JSON.parse(priorCarrierBytes.toString("utf8")) as
    DesiredRepairManifest & Record<string, unknown> & { body_sha256?: string };
  assert(
    priorCarrier.body_sha256 === FUTURE_TIMESTAMP_CARRIER_V4.body_sha256 &&
      bodySeal(priorCarrier) === priorCarrier.body_sha256,
    "Future-timestamp carrier v4 body seal failed",
  );
  const plan = JSON.parse(planBytes.toString("utf8")) as GalleryPlan;
  assert(
    plan.schema_version === "uncrustables-live-gallery-surgical-plan/v4.0" &&
      plan.plan_id === PLAN.plan_id &&
      plan.status === "SEALED_LOCAL_READ_ONLY_PLAN" &&
      plan.immutable_inputs === true,
    "Gallery v4 is not the exact sealed plan",
  );
  assert(plan.body_sha256 === PLAN.body_sha256 && bodySeal(plan) === plan.body_sha256, "Gallery v4 body seal failed");
  assert(plan.sources.source_ledger.sha256 === LEDGER_SHA, "Gallery v4 ledger pin mismatch");
  assert(
    plan.summary.listing_rows === 164 &&
      plan.summary.keep_no_write === 44 &&
      plan.summary.rebuild_gallery === 120 &&
      plan.summary.after_validation_fail === 0 &&
      plan.summary.explicit_tail_slot_deletions === 199 &&
      plan.summary.corrected_gallery_rows === 4 &&
      plan.summary.low_mae_pair_occurrences_reviewed === 8 &&
      plan.summary.full_intra_gallery_pairs_scanned_before === 3032 &&
      plan.summary.full_intra_gallery_pairs_scanned_after === 3003 &&
      plan.rows.length === 164,
    "Gallery v4 exact reviewed scope changed",
  );
  assert(
    plan.validation.every_after_gallery_perceptually_unique === true &&
      plan.validation.all_true_visual_duplicate_pairs_resolved === true &&
      plan.validation.all_semantically_distinct_low_mae_pairs_retained === true &&
      plan.validation.all_intra_gallery_pairs_enumerated === true &&
      plan.validation.exact_low_mae_review_set_match === true &&
      plan.validation.every_remaining_low_mae_pair_explicitly_semantically_distinct === true,
    "Gallery v4 perceptual review gates did not pass",
  );

  let tailDeletions = 0;
  const repairs: DesiredRepairManifest["repairs"] = [];
  for (const row of plan.rows.sort((left, right) => left.sku.localeCompare(right.sku))) {
    assert(row.after.validation.pass && row.after.validation.errors.length === 0, `${row.sku}: invalid after-gallery`);
    if (row.action === "KEEP") {
      assert(row.write_required === false, `${row.sku}: KEEP unexpectedly writes`);
      continue;
    }
    assert(row.action === "REBUILD_GALLERY" && row.write_required === true, `${row.sku}: unexpected action`);
    const assets = row.after.secondary_assets;
    assert(assets.length >= 5 && assets.length <= 7, `${row.sku}: gallery length out of range`);
    assert(
      assets.every((asset, index) =>
        asset.slot_index === index + 1 &&
        asset.slot === `GALLERY_${index + 1}` &&
        asset.policy_issues.length === 0 &&
        /^https:\/\//.test(asset.source_url) &&
        /^[a-f0-9]{64}$/.test(asset.sha256)
      ),
      `${row.sku}: invalid ordered gallery asset`,
    );
    assert(assets[0].source_url === BRAND_CARD && assets[0].sha256 === BRAND_CARD_SHA, `${row.sku}: slot1 changed`);
    assert(new Set(assets.map((asset) => asset.source_url)).size === assets.length, `${row.sku}: duplicate URLs`);
    assert(new Set(assets.map((asset) => asset.sha256)).size === assets.length, `${row.sku}: duplicate bytes`);
    const gallery = assets.map((asset) => asset.source_url);
    const deletions = exactTailSlots(gallery.length);
    tailDeletions += deletions.length;
    repairs.push({
      sku: row.sku,
      review: {
        confidence: "HIGH",
        rationale:
          "The sealed gallery v4 plan binds this exact ordered secondary gallery to the listing recipe, removes true visual duplicates, retains semantically distinct flavor panels, and specifies the exact stale-tail complement.",
        evidence: [
          `Gallery plan ${PLAN.plan_id} (${PLAN.sha256}), row ${row.ordinal}, after.validation.pass=true.`,
          `Ordered asset SHA-256: ${assets.map((asset) => asset.sha256).join(",")}.`,
          `Explicit stale-tail deletion: ${deletions.join(",")}.`,
          ...(row.visual_duplicate_correction
            ? [`Perceptual duplicate correction dropped: ${row.visual_duplicate_correction.dropped_sha256.join(",")}.`]
            : []),
        ],
      },
      media: {
        gallery_image_urls: gallery,
        delete_gallery_slots: deletions,
      },
    });
  }
  assert(repairs.length === 120, `Expected 120 media repairs, got ${repairs.length}`);
  assert(tailDeletions === 199, `Expected 199 tail deletions, got ${tailDeletions}`);
  assert(repairs.every((repair) => repair.media?.main_image_url == null), "MEDIA carrier contains MAIN");
  assert(
    repairs.every((repair) => repair.text_count == null && repair.offer == null && repair.structured_attributes == null),
    "MEDIA carrier contains non-media desired state",
  );
  const customerMedia = (rows: DesiredRepairManifest["repairs"]) => rows
    .map((repair) => ({ sku: repair.sku, media: repair.media }))
    .sort((left, right) => left.sku.localeCompare(right.sku));
  assert(
    canonical(customerMedia(repairs)) === canonical(customerMedia(priorCarrier.repairs)),
    "Provenance correction changed the customer-facing carrier v4 MEDIA payload",
  );

  const body: Omit<MediaCarrier, "body_sha256"> = {
    schema_version: "uncrustables-surgical-desired/v1",
    immutable: true,
    source_ledger_sha256: LEDGER_SHA,
    reviewed_at: REVIEWED_AT,
    source_artifacts: { gallery_surgical_plan_v4: PLAN },
    supersedes: [
      {
        ...FUTURE_TIMESTAMP_CARRIER_V4,
        status: "SUPERSEDED_DO_NOT_APPLY",
        reason: "FUTURE_TIMESTAMP_PROVENANCE_CORRECTED",
      },
      {
        ...PRELIMINARY_CARRIER,
        status: "SUPERSEDED_DO_NOT_APPLY",
        reason: "STALE_GALLERY_VERSION_LABEL_AND_FUTURE_TIMESTAMP",
      },
    ],
    carrier_policy: {
      media_only: true,
      main_image_excluded: true,
      exact_ordered_gallery: true,
      exact_tail_complement: true,
      perceptual_duplicate_review_required: true,
    },
    summary: {
      exact_live_scope: 164,
      keep_no_write: 44,
      media_repairs: 120,
      corrected_duplicate_rows: 4,
      explicit_tail_slot_deletions: 199,
    },
    repairs,
  };
  assert(
    !/gallery\s+v[12]\b/i.test(canonical(body)),
    "Final carrier contains a stale gallery v1/v2 label outside supersedes provenance",
  );
  const manifest: MediaCarrier = { ...body, body_sha256: sha256(canonical(body)) };
  assert(
    bodySeal(manifest as unknown as Record<string, unknown>) === manifest.body_sha256,
    "MEDIA carrier body seal failed",
  );
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
    summary: manifest.summary,
  })}\n`);
}

await main();
