/**
 * Convert the sealed 164-row gallery surgical plan into the production
 * DesiredRepairManifest consumed by repair-uncrustables-surgical.ts.
 *
 * Local reads and immutable local writes only. No Amazon, R2, database, or
 * network access exists in this script.
 *
 * Run:
 *   npx tsx scripts/build-uncrustables-gallery-desired-manifest.ts
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GALLERY_PLAN_PATH =
  "data/audits/uncrustables-live-gallery-surgical-plan-20260718-v1.json";
const GALLERY_PLAN_FILE_SHA256 =
  "1a2f23305b3328e7d5cd6a46ffcc598961fcbb4c70c924a6ea659341c7155598";
const GALLERY_PLAN_BODY_SHA256 =
  "aaf053c537f3413e03933cd4d6bebc15402f0e3e647d261d506c8900b5b6aa9c";
const REVIEWED_OVERRIDES_PATH =
  "data/repairs/uncrustables-reviewed-overrides-20260717.json";
const REVIEWED_OVERRIDES_FILE_SHA256 =
  "170250cb1761a8dbf9a10d18a83a4c38ca9758ec3294bb1341c2a23106e02238";
const SOURCE_LEDGER_SHA256 =
  "46a80e727880d83bd9e52a1c58c753eeeede0cb8cbdd3443e825aba9cbaaa02f";
const OUTPUT_PATH =
  "data/repairs/uncrustables-gallery-merged-desired-20260718-v1.json";
const GALLERY_PLAN_SCHEMA =
  "uncrustables-live-gallery-surgical-plan/v1.0";
const DESIRED_MANIFEST_SCHEMA = "uncrustables-surgical-desired/v1";
const VERIFIED_BRAND_CARD_REHOST_URL =
  "https://m.media-amazon.com/images/I/81OibsvvU0L.jpg";

interface DesiredRepairEntry extends Record<string, unknown> {
  sku: string;
  review?: {
    confidence: "HIGH" | "MEDIUM" | "LOW";
    rationale: string;
    evidence: string[];
  };
  media?: {
    main_image_url?: string;
    gallery_image_urls?: string[];
    delete_gallery_slots?: number[];
  };
}

interface DesiredRepairManifest {
  schema_version: string;
  immutable?: true;
  source_ledger_sha256?: string;
  reviewed_at?: string;
  repairs: DesiredRepairEntry[];
}

interface GalleryAsset {
  slot_index: number;
  source_url: string;
  sha256: string;
  policy_issues: string[];
}

interface GalleryPlanRow {
  ordinal: number;
  sku: string;
  asin: string;
  action: "KEEP" | "REBUILD_GALLERY";
  write_required: boolean;
  after: {
    secondary_assets: GalleryAsset[];
    validation: {
      pass: boolean;
      errors: string[];
      secondary_count: number;
      unique_sha_count: number;
    };
  };
}

interface GalleryPlanArtifact extends Record<string, unknown> {
  schema_version: string;
  plan_id: string;
  deterministic_as_of: string;
  status: string;
  immutable_inputs: boolean;
  body_sha256: string;
  sources: {
    source_ledger: { sha256: string };
    source_reviewed_overrides: { sha256: string; source_ledger_sha256: string };
  };
  summary: {
    listing_rows: number;
    keep_no_write: number;
    rebuild_gallery: number;
    write_required_rows: number;
    after_validation_fail: number;
  };
  rows: GalleryPlanRow[];
}

interface MergedDesiredManifest extends DesiredRepairManifest {
  source_artifacts: {
    gallery_surgical_plan: {
      path: string;
      sha256: string;
      body_sha256: string;
      plan_id: string;
    };
    reviewed_overrides: {
      path: string;
      sha256: string;
      repair_count: number;
    };
  };
  merge_summary: {
    source_gallery_rows: number;
    source_gallery_keep_no_write: number;
    source_gallery_rebuild: number;
    source_override_repairs: number;
    overlapping_repairs: number;
    merged_repairs: number;
    media_repairs: number;
    ordered_gallery_replacements: number;
    explicit_tail_slot_deletions: number;
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
  const canonicalValue = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonicalValue);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, canonicalValue(nested)]),
      );
    }
    return entry;
  };
  return JSON.stringify(canonicalValue(value));
}

function verifyGalleryPlanBodySeal(manifest: GalleryPlanArtifact): boolean {
  if (!/^[a-f0-9]{64}$/.test(manifest.body_sha256)) return false;
  const body = { ...manifest } as Record<string, unknown>;
  delete body.body_sha256;
  return sha256(canonical(body)) === manifest.body_sha256;
}

function expectedTailSlots(galleryLength: number): number[] {
  return Array.from(
    { length: 8 - galleryLength },
    (_, index) => galleryLength + 1 + index,
  );
}

function assertExactPinnedFile(
  label: string,
  bytes: Buffer,
  expectedSha256: string,
): void {
  const actual = sha256(bytes);
  assert(
    actual === expectedSha256,
    `${label} SHA-256 mismatch: expected ${expectedSha256}, got ${actual}.`,
  );
}

async function writeIdenticalOrCreate(
  absolutePath: string,
  bytes: Buffer,
): Promise<void> {
  try {
    const existing = await readFile(absolutePath);
    assert(
      existing.equals(bytes),
      `Refusing to overwrite immutable artifact with different bytes: ${absolutePath}`,
    );
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
  assert(
    process.argv.length === 2,
    "This pinned deterministic builder does not accept runtime input overrides.",
  );
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const galleryBytes = await readFile(path.resolve(root, GALLERY_PLAN_PATH));
  const overridesBytes = await readFile(
    path.resolve(root, REVIEWED_OVERRIDES_PATH),
  );
  assertExactPinnedFile(
    "Gallery surgical plan",
    galleryBytes,
    GALLERY_PLAN_FILE_SHA256,
  );
  assertExactPinnedFile(
    "Reviewed overrides",
    overridesBytes,
    REVIEWED_OVERRIDES_FILE_SHA256,
  );

  const galleryPlan = JSON.parse(
    galleryBytes.toString("utf8"),
  ) as GalleryPlanArtifact;
  const reviewed = JSON.parse(
    overridesBytes.toString("utf8"),
  ) as DesiredRepairManifest;

  assert(
    galleryPlan.schema_version === GALLERY_PLAN_SCHEMA,
    `Unexpected gallery-plan schema ${galleryPlan.schema_version}.`,
  );
  assert(
    galleryPlan.status === "SEALED_LOCAL_READ_ONLY_PLAN" &&
      galleryPlan.immutable_inputs === true,
    "Gallery surgical plan is not sealed and immutable.",
  );
  assert(
    galleryPlan.body_sha256 === GALLERY_PLAN_BODY_SHA256 &&
      verifyGalleryPlanBodySeal(galleryPlan),
    "Gallery surgical-plan body seal verification failed.",
  );
  assert(
    reviewed.schema_version === DESIRED_MANIFEST_SCHEMA &&
      reviewed.immutable === true &&
      reviewed.source_ledger_sha256 === SOURCE_LEDGER_SHA256,
    "Reviewed overrides are not the expected immutable desired manifest.",
  );
  assert(
    galleryPlan.sources.source_ledger.sha256 === SOURCE_LEDGER_SHA256 &&
      galleryPlan.sources.source_reviewed_overrides.sha256 ===
        REVIEWED_OVERRIDES_FILE_SHA256 &&
      galleryPlan.sources.source_reviewed_overrides.source_ledger_sha256 ===
        SOURCE_LEDGER_SHA256,
    "Gallery plan source pins do not match the exact reviewed inputs.",
  );
  assert(
    galleryPlan.summary.listing_rows === 164 &&
      galleryPlan.summary.keep_no_write === 44 &&
      galleryPlan.summary.rebuild_gallery === 120 &&
      galleryPlan.summary.write_required_rows === 120 &&
      galleryPlan.summary.after_validation_fail === 0 &&
      galleryPlan.rows.length === 164,
    "Gallery plan does not have the exact reviewed 164/44/120 scope.",
  );
  assert(
    reviewed.repairs.length === 4,
    `Expected exactly four reviewed overrides, got ${reviewed.repairs.length}.`,
  );

  const gallerySkus = new Set<string>();
  const baseRepairs = new Map(
    reviewed.repairs.map((repair) => [repair.sku, structuredClone(repair)]),
  );
  assert(
    baseRepairs.size === reviewed.repairs.length,
    "Reviewed overrides contain duplicate SKUs.",
  );
  const mergedRepairs = new Map(
    reviewed.repairs.map((repair) => [repair.sku, structuredClone(repair)]),
  );
  let mediaRepairs = 0;
  let explicitTailSlotDeletions = 0;
  let overlapCount = 0;

  for (const row of [...galleryPlan.rows].sort(
    (left, right) => left.ordinal - right.ordinal,
  )) {
    assert(
      Number.isInteger(row.ordinal) && row.ordinal >= 1 && row.ordinal <= 164,
      `Invalid gallery ordinal ${row.ordinal}.`,
    );
    assert(!gallerySkus.has(row.sku), `Duplicate gallery SKU ${row.sku}.`);
    gallerySkus.add(row.sku);
    assert(
      row.after.validation.pass === true &&
        row.after.validation.errors.length === 0,
      `Gallery after-state is not valid for ${row.sku}.`,
    );
    if (row.action === "KEEP") {
      assert(row.write_required === false, `KEEP row ${row.sku} requests a write.`);
      continue;
    }
    assert(
      row.action === "REBUILD_GALLERY" && row.write_required === true,
      `Unexpected gallery action for ${row.sku}.`,
    );
    const assets = row.after.secondary_assets;
    assert(
      assets.length >= 5 && assets.length <= 7,
      `${row.sku} must have card plus 4-6 product/context assets.`,
    );
    assert(
      row.after.validation.secondary_count === assets.length &&
        row.after.validation.unique_sha_count === assets.length,
      `${row.sku} gallery counts do not match its sealed validation.`,
    );
    assert(
      assets.every((asset, index) => asset.slot_index === index + 1),
      `${row.sku} gallery slots are not exact and contiguous.`,
    );
    assert(
      assets[0].source_url === VERIFIED_BRAND_CARD_REHOST_URL &&
        assets[0].sha256 ===
          "0becbfd6f8d54afcb84a183f6829fe78f234360df0a76149845263d5eafbb7eb",
      `${row.sku} slot 1 is not the byte-verified Amazon card rehost.`,
    );
    assert(
      assets.every(
        (asset) =>
          /^https:\/\//.test(asset.source_url) &&
          /^[a-f0-9]{64}$/.test(asset.sha256) &&
          asset.policy_issues.length === 0,
      ),
      `${row.sku} has an invalid or policy-blocked gallery asset.`,
    );
    assert(
      new Set(assets.map((asset) => asset.source_url)).size === assets.length &&
        new Set(assets.map((asset) => asset.sha256)).size === assets.length,
      `${row.sku} gallery contains duplicate assets.`,
    );

    const galleryUrls = assets.map((asset) => asset.source_url);
    const deleteGallerySlots = expectedTailSlots(galleryUrls.length);
    assert(
      deleteGallerySlots.length >= 1,
      `${row.sku} must explicitly delete at least slot 8.`,
    );
    const prior = mergedRepairs.get(row.sku);
    if (prior) overlapCount++;
    const galleryReview = {
      confidence: "HIGH" as const,
      rationale:
        "The sealed local gallery audit maps this exact ordered card-plus-product gallery to the listing recipe and validates policy, uniqueness, and component coverage.",
      evidence: [
        `Gallery plan ${galleryPlan.plan_id}, row ${row.ordinal}, action REBUILD_GALLERY, after.validation.pass=true.`,
        `Ordered asset SHA-256: ${assets.map((asset) => asset.sha256).join(",")}.`,
        `Explicit stale-tail deletion: ${deleteGallerySlots.join(",")}.`,
      ],
    };
    mergedRepairs.set(row.sku, {
      ...(prior ?? { sku: row.sku, review: galleryReview }),
      media: {
        gallery_image_urls: galleryUrls,
        delete_gallery_slots: deleteGallerySlots,
      },
    });
    mediaRepairs++;
    explicitTailSlotDeletions += deleteGallerySlots.length;
  }

  assert(gallerySkus.size === 164, `Expected 164 gallery SKUs, got ${gallerySkus.size}.`);
  assert(mediaRepairs === 120, `Expected 120 media repairs, got ${mediaRepairs}.`);
  assert(overlapCount === 2, `Expected two override/gallery overlaps, got ${overlapCount}.`);

  for (const [sku, original] of baseRepairs) {
    const merged = mergedRepairs.get(sku);
    assert(merged, `Reviewed override ${sku} was lost during merge.`);
    const withoutAddedMedia = structuredClone(merged);
    delete withoutAddedMedia.media;
    assert(
      canonical(withoutAddedMedia) === canonical(original),
      `Reviewed override ${sku} changed during gallery merge.`,
    );
  }

  const repairs = [...mergedRepairs.values()].sort((left, right) =>
    left.sku.localeCompare(right.sku),
  );
  const body = {
    schema_version: DESIRED_MANIFEST_SCHEMA,
    immutable: true as const,
    source_ledger_sha256: SOURCE_LEDGER_SHA256,
    reviewed_at: galleryPlan.deterministic_as_of,
    source_artifacts: {
      gallery_surgical_plan: {
        path: GALLERY_PLAN_PATH,
        sha256: GALLERY_PLAN_FILE_SHA256,
        body_sha256: GALLERY_PLAN_BODY_SHA256,
        plan_id: galleryPlan.plan_id,
      },
      reviewed_overrides: {
        path: REVIEWED_OVERRIDES_PATH,
        sha256: REVIEWED_OVERRIDES_FILE_SHA256,
        repair_count: reviewed.repairs.length,
      },
    },
    merge_summary: {
      source_gallery_rows: galleryPlan.rows.length,
      source_gallery_keep_no_write: galleryPlan.summary.keep_no_write,
      source_gallery_rebuild: galleryPlan.summary.rebuild_gallery,
      source_override_repairs: reviewed.repairs.length,
      overlapping_repairs: overlapCount,
      merged_repairs: repairs.length,
      media_repairs: mediaRepairs,
      ordered_gallery_replacements: mediaRepairs,
      explicit_tail_slot_deletions: explicitTailSlotDeletions,
    },
    repairs,
  };
  const manifest: MergedDesiredManifest = {
    ...body,
    body_sha256: sha256(canonical(body)),
  };
  assert(
    manifest.merge_summary.merged_repairs === 122,
    `Expected 122 merged repair rows, got ${manifest.merge_summary.merged_repairs}.`,
  );

  const outputBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const outputAbsolute = path.resolve(root, OUTPUT_PATH);
  await writeIdenticalOrCreate(outputAbsolute, outputBytes);
  const sidecarPath = `${outputAbsolute}.sha256`;
  const sidecarBytes = Buffer.from(
    `${sha256(outputBytes)}  ${path.basename(outputAbsolute)}\n`,
  );
  await writeIdenticalOrCreate(sidecarPath, sidecarBytes);

  console.log(
    JSON.stringify(
      {
        output: OUTPUT_PATH,
        file_sha256: sha256(outputBytes),
        body_sha256: manifest.body_sha256,
        ...manifest.merge_summary,
        external_writes: { amazon: 0, r2: 0, database: 0, network: 0 },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
