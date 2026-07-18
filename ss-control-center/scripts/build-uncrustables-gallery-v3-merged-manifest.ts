/**
 * Merge the provenance-corrected all-164 r6 factual repairs with the sealed
 * exhaustive gallery v4 plan through its pure-MEDIA v5 carrier.
 *
 * Offline only. Superseded manifests are read only to prove their exact
 * identity and customer-payload equivalence; they are never imported into the
 * final desired state.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DesiredRepairManifest } from
  "../src/lib/bundle-factory/repair/uncrustables-surgical";

const SOURCES = {
  ledger: {
    path: "data/audits/uncrustables-ledger-20260717T232140568Z-offline.json",
    sha256: "46a80e727880d83bd9e52a1c58c753eeeede0cb8cbdd3443e825aba9cbaaa02f",
  },
  factual_audit: {
    path: "data/audits/uncrustables-factual-content-audit-20260718-v6.json",
    sha256: "6e5338549db5eb6c3d9ab2cbe4388ecac44001415e7b7aa8dde1763328e318e6",
  },
  reviewed_content: {
    path: "data/repairs/uncrustables-reviewed-overrides-20260718-v3-r6.json",
    sha256: "f5df324ecc5b48c9de9549a980f0703dbdd83ec2c01e64a19e7204feb2fa0b06",
  },
  gallery_plan: {
    path: "data/audits/uncrustables-live-gallery-surgical-plan-20260718-v4.json",
    sha256: "ae345407a4b95232941cdcaa3836fc85ba87ca6d9cf94988f797253d90025469",
  },
  gallery_media_carrier: {
    path: "data/repairs/uncrustables-gallery-media-desired-20260718-v5.json",
    sha256: "a56a48a2da639e9848c54d5e18e2bb54c5b973156555b09dac97ff68e961eaf1",
  },
} as const;

const SUPERSEDED = [
  {
    path: "data/repairs/uncrustables-reviewed-overrides-20260717.json",
    sha256: "170250cb1761a8dbf9a10d18a83a4c38ca9758ec3294bb1341c2a23106e02238",
  },
  {
    path: "data/repairs/uncrustables-reviewed-overrides-20260718-v2.json",
    sha256: "07c4a12b11083471096fd88054564146d7ef823c5075f4468eb0cef96f49b885",
  },
  {
    path: "data/repairs/uncrustables-reviewed-overrides-20260718-v3.json",
    sha256: "304289aa7b0cff040da607d20b9958863f279805a3cf77108ca1dc7b458b08ee",
  },
  {
    path: "data/repairs/uncrustables-reviewed-overrides-20260718-v3-r2.json",
    sha256: "51fddd9fa0b38c52284d3434f27659b5dd90c94399e4a94f28c530eed43f652c",
  },
  {
    path: "data/repairs/uncrustables-reviewed-overrides-20260718-v3-r3.json",
    sha256: "d43fce88c710295239e9803e4684b2cf6445f48b894d1cf7ea4966316ebf5438",
  },
  {
    path: "data/repairs/uncrustables-reviewed-overrides-20260718-v3-r4.json",
    sha256: "640ccc2d35b9d683581884794193e5ef2fa09b2bdc4c23178af25fcbaa3e8cb9",
  },
  {
    path: "data/repairs/uncrustables-reviewed-overrides-20260718-v3-r5.json",
    sha256: "3cd84d9c0b467d40f9565c0f0633c0f7202f30789d2ececf45deec0bc987b1fc",
  },
  {
    path: "data/audits/uncrustables-factual-content-audit-20260718-v5.json",
    sha256: "71636419eb377804076fefa0e6443c8bcdc043b909cfbe20d9369a3e89eb662e",
  },
  {
    path: "data/repairs/uncrustables-gallery-nonmedia-merged-desired-20260718-v2.json",
    sha256: "c7e6841d00776a5df1a1e549d3740c3d176976d6a96e4d0903ca77aefe36ee54",
  },
  {
    path: "data/repairs/uncrustables-gallery-merged-desired-20260718-v1.json",
    sha256: "4b37083be7de15212b5988c02816f6722cd4649dadfb8a6a778223766d823dd6",
  },
  {
    path: "data/repairs/uncrustables-gallery-media-desired-20260718-v3.json",
    sha256: "dffafb52b56c690edab63c51378dcd19d6c2f9c863f0e69429d99b62f87eb85b",
  },
  {
    path: "data/repairs/uncrustables-gallery-media-desired-20260718-v4.json",
    sha256: "9e01d4d5e61ec36edb6245d9147ea55f03ed0b0661b3e6241d8c8ad8447ff713",
  },
  {
    path: "data/audits/uncrustables-live-gallery-surgical-plan-20260718-v1.json",
    sha256: "1a2f23305b3328e7d5cd6a46ffcc598961fcbb4c70c924a6ea659341c7155598",
  },
  {
    path: "data/audits/uncrustables-live-gallery-surgical-plan-20260718-v2.json",
    sha256: "911aa359568fa36614eef4acbb08dcacc43778e0d94211de840740d3e6de41bf",
  },
  {
    path: "data/audits/uncrustables-live-gallery-surgical-plan-20260718-v3.json",
    sha256: "7c3e3cc496f3d9dc9add6ea0cf80d3d7b9d7482a02b4ad96d50b73601d761646",
  },
] as const;

const OUTPUT_PATH =
  "data/repairs/uncrustables-gallery-nonmedia-merged-desired-20260718-v4.json";
const REVIEWED_AT = "2026-07-18T05:55:00.000Z";
const BRAND_CARD = "https://m.media-amazon.com/images/I/81OibsvvU0L.jpg";

interface SourceArtifact extends Record<string, unknown> {
  path: string;
  sha256: string;
}

interface FinalMergedManifest extends DesiredRepairManifest {
  source_artifacts: {
    ledger: SourceArtifact;
    factual_audit: SourceArtifact;
    reviewed_content_r6: SourceArtifact & { repair_count: 164 };
    gallery_surgical_plan_v4: SourceArtifact & {
      body_sha256: string;
      plan_id: string;
    };
    gallery_media_carrier_v5: SourceArtifact & {
      extraction: "MEDIA_ONLY";
      source_media_repairs: 120;
    };
  };
  supersedes: Array<SourceArtifact & { status: "SUPERSEDED_DO_NOT_APPLY" }>;
  merge_summary: {
    exact_live_scope: number;
    factual_text_repairs: number;
    explicit_offer_overrides: number;
    explicit_structured_overrides: number;
    secondary_gallery_repairs: number;
    overlapping_media_and_factual_repairs: number;
    final_repairs: number;
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

async function exactRead(
  root: string,
  source: { path: string; sha256: string },
): Promise<Buffer> {
  const bytes = await readFile(path.resolve(root, source.path));
  const actual = sha256(bytes);
  assert(
    actual === source.sha256,
    `${source.path} SHA-256 mismatch: expected ${source.sha256}, got ${actual}`,
  );
  return bytes;
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

function exactTailSlots(galleryLength: number): number[] {
  return Array.from(
    { length: 8 - galleryLength },
    (_, index) => galleryLength + 1 + index,
  );
}

function customerRepairProjection(
  rows: DesiredRepairManifest["repairs"],
): Array<Record<string, unknown>> {
  return rows
    .map((repair) => ({
      sku: repair.sku,
      ...(repair.text_count ? { text_count: repair.text_count } : {}),
      ...(repair.offer ? { offer: repair.offer } : {}),
      ...(repair.structured_attributes
        ? { structured_attributes: repair.structured_attributes }
        : {}),
      ...(repair.media ? { media: repair.media } : {}),
    }))
    .sort((left, right) => String(left.sku).localeCompare(String(right.sku)));
}

function combineReview(
  factual: NonNullable<DesiredRepairManifest["repairs"][number]["review"]>,
  media: NonNullable<DesiredRepairManifest["repairs"][number]["review"]>,
): NonNullable<DesiredRepairManifest["repairs"][number]["review"]> {
  return {
    confidence: "HIGH",
    rationale:
      `${factual.rationale} Separately, the sealed exhaustive secondary-gallery audit approves the exact ordered gallery and stale-tail deletions for this SKU.`,
    evidence: [...new Set([...factual.evidence, ...media.evidence])],
  };
}

function assertExactCorrectedGallery(
  mediaBySku: ReadonlyMap<string, DesiredRepairManifest["repairs"][number]>,
  sku: string,
  gallery: string[],
  deleteSlots: number[],
): void {
  const media = mediaBySku.get(sku)?.media;
  assert(media, `${sku}: corrected gallery is missing`);
  assert(
    canonical(media.gallery_image_urls) === canonical(gallery),
    `${sku}: corrected gallery differs from the reviewed exhaustive result`,
  );
  assert(
    canonical(media.delete_gallery_slots) === canonical(deleteSlots),
    `${sku}: corrected tail deletion differs from the reviewed exhaustive result`,
  );
}

async function main(): Promise<void> {
  assert(process.argv.length === 2, "This pinned builder accepts no runtime overrides");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const [
    ledgerBytes,
    auditBytes,
    contentBytes,
    galleryPlanBytes,
    mediaCarrierBytes,
  ] = await Promise.all([
    exactRead(root, SOURCES.ledger),
    exactRead(root, SOURCES.factual_audit),
    exactRead(root, SOURCES.reviewed_content),
    exactRead(root, SOURCES.gallery_plan),
    exactRead(root, SOURCES.gallery_media_carrier),
  ]);
  const supersededBytes = await Promise.all(
    SUPERSEDED.map((source) => exactRead(root, source)),
  );
  const supersededByPath = new Map(
    SUPERSEDED.map((source, index) => [source.path, supersededBytes[index]]),
  );
  assert(ledgerBytes.length > 0, "Exact ledger is empty");
  const audit = JSON.parse(auditBytes.toString("utf8")) as {
    created_at?: string;
    sources?: { ledger?: { sha256?: string } };
    policy?: { owner_fulfillment_source_pinned?: boolean };
    summary?: { live_rows?: number; full_rewrites?: number };
  };
  assert(audit.created_at === REVIEWED_AT, "Factual audit provenance cutoff changed");
  assert(audit.sources?.ledger?.sha256 === SOURCES.ledger.sha256, "Factual audit ledger pin mismatch");
  assert(
    audit.summary?.live_rows === 164 && audit.summary.full_rewrites === 164,
    "Factual audit does not cover the exact 164 live rows",
  );
  assert(
    audit.policy?.owner_fulfillment_source_pinned === true,
    "Factual audit lacks pinned owner fulfillment evidence",
  );

  const content = JSON.parse(contentBytes.toString("utf8")) as DesiredRepairManifest;
  assert(content.immutable === true, "r6 reviewed content must be immutable");
  assert(content.reviewed_at === REVIEWED_AT, "r6 reviewed-content provenance cutoff changed");
  assert(content.source_ledger_sha256 === SOURCES.ledger.sha256, "r6 ledger pin mismatch");
  assert(content.repairs.length === 164, `Expected 164 r6 repairs, got ${content.repairs.length}`);
  assert(
    new Set(content.repairs.map((repair) => repair.sku)).size === 164,
    "r6 has duplicate SKUs",
  );
  const futureR5Bytes = supersededByPath.get(
    "data/repairs/uncrustables-reviewed-overrides-20260718-v3-r5.json",
  );
  assert(futureR5Bytes, "Superseded r5 bytes are missing");
  const futureR5 = JSON.parse(futureR5Bytes.toString("utf8")) as DesiredRepairManifest;
  assert(
    canonical(content.repairs) === canonical(futureR5.repairs),
    "Provenance correction changed the exact 164-row factual repair payload",
  );

  const galleryPlan = JSON.parse(galleryPlanBytes.toString("utf8")) as {
    schema_version?: string;
    plan_id?: string;
    deterministic_as_of?: string;
    body_sha256?: string;
    sources?: { source_ledger?: { sha256?: string } };
    summary?: {
      listing_rows?: number;
      keep_no_write?: number;
      rebuild_gallery?: number;
      after_validation_pass?: number;
      after_validation_fail?: number;
      low_mae_pair_occurrences_reviewed?: number;
      remaining_semantically_distinct_low_mae_pairs?: number;
      true_visual_duplicate_pair_occurrences?: number;
      corrected_gallery_rows?: number;
      dropped_duplicate_asset_occurrences?: number;
      explicit_tail_slot_deletions?: number;
    };
  };
  assert(
    galleryPlan.schema_version === "uncrustables-live-gallery-surgical-plan/v4.0",
    "Gallery plan is not the sealed provenance-corrected v4 schema",
  );
  assert(
    galleryPlan.deterministic_as_of === REVIEWED_AT,
    "Gallery plan provenance cutoff changed",
  );
  assert(
    galleryPlan.sources?.source_ledger?.sha256 === SOURCES.ledger.sha256,
    "Gallery plan ledger pin mismatch",
  );
  assert(
    bodySeal(galleryPlan as unknown as Record<string, unknown>) === galleryPlan.body_sha256,
    "Gallery plan body seal is invalid",
  );
  assert(galleryPlan.summary?.listing_rows === 164, "Gallery plan scope is not 164 rows");
  assert(galleryPlan.summary?.keep_no_write === 44, "Gallery plan keep count changed");
  assert(galleryPlan.summary?.rebuild_gallery === 120, "Gallery plan repair count changed");
  assert(galleryPlan.summary?.after_validation_pass === 164, "Gallery plan lost a passing row");
  assert(galleryPlan.summary?.after_validation_fail === 0, "Gallery plan has a failing row");
  assert(
    galleryPlan.summary?.low_mae_pair_occurrences_reviewed === 8 &&
      galleryPlan.summary?.true_visual_duplicate_pair_occurrences === 4 &&
      galleryPlan.summary?.remaining_semantically_distinct_low_mae_pairs === 4,
    "Gallery plan exhaustive perceptual-duplicate gate changed",
  );
  assert(galleryPlan.summary?.corrected_gallery_rows === 4, "Corrected gallery count changed");
  assert(
    galleryPlan.summary?.dropped_duplicate_asset_occurrences === 5,
    "Dropped duplicate asset count changed",
  );
  assert(
    galleryPlan.summary?.explicit_tail_slot_deletions === 199,
    "Gallery plan tail deletion count changed",
  );

  const carrier = JSON.parse(mediaCarrierBytes.toString("utf8")) as
    DesiredRepairManifest & {
      body_sha256?: string;
      source_artifacts?: {
        gallery_surgical_plan_v4?: {
          sha256?: string;
          body_sha256?: string;
          plan_id?: string;
        };
      };
      summary?: {
        exact_live_scope?: number;
        keep_no_write?: number;
        media_repairs?: number;
        corrected_duplicate_rows?: number;
        explicit_tail_slot_deletions?: number;
      };
      carrier_policy?: {
        media_only?: boolean;
        main_image_excluded?: boolean;
        exact_ordered_gallery?: boolean;
        exact_tail_complement?: boolean;
        perceptual_duplicate_review_required?: boolean;
      };
    };
  assert(
    bodySeal(carrier as unknown as Record<string, unknown>) === carrier.body_sha256,
    "Gallery media carrier body seal is invalid",
  );
  assert(carrier.reviewed_at === REVIEWED_AT, "Gallery carrier provenance cutoff changed");
  assert(
    carrier.source_artifacts?.gallery_surgical_plan_v4?.sha256 === SOURCES.gallery_plan.sha256,
    "Gallery carrier plan pin mismatch",
  );
  assert(
    carrier.source_artifacts?.gallery_surgical_plan_v4?.body_sha256 === galleryPlan.body_sha256 &&
      carrier.source_artifacts?.gallery_surgical_plan_v4?.plan_id === galleryPlan.plan_id,
    "Gallery carrier does not bind the exact sealed plan body and plan id",
  );
  assert(
    carrier.summary?.exact_live_scope === 164 &&
      carrier.summary.keep_no_write === 44 &&
      carrier.summary.media_repairs === 120 &&
      carrier.summary.corrected_duplicate_rows === 4 &&
      carrier.summary.explicit_tail_slot_deletions === 199,
    "Gallery carrier summary changed",
  );
  assert(
    carrier.carrier_policy?.media_only === true &&
      carrier.carrier_policy.main_image_excluded === true &&
      carrier.carrier_policy.exact_ordered_gallery === true &&
      carrier.carrier_policy.exact_tail_complement === true &&
      carrier.carrier_policy.perceptual_duplicate_review_required === true,
    "Gallery carrier does not declare every required fail-closed MEDIA policy",
  );
  assert(carrier.repairs.length === 120, `Expected 120 carrier rows, got ${carrier.repairs.length}`);
  const mediaEntries = carrier.repairs;
  const mediaBySku = new Map(mediaEntries.map((repair) => [repair.sku, repair]));
  assert(mediaBySku.size === 120, "Gallery media carrier has duplicate SKUs");
  for (const entry of mediaEntries) {
    assert(entry.media, `${entry.sku}: carrier row has no MEDIA repair`);
    assert(entry.text_count == null, `${entry.sku}: carrier unexpectedly has TEXT_COUNT`);
    assert(entry.offer == null, `${entry.sku}: carrier unexpectedly has OFFER`);
    assert(
      entry.structured_attributes == null,
      `${entry.sku}: carrier unexpectedly has STRUCTURED_ATTRIBUTES`,
    );
    assert(
      Object.keys(entry).every((key) => ["sku", "review", "media"].includes(key)),
      `${entry.sku}: carrier contains an unrecognized non-MEDIA field`,
    );
    const gallery = entry.media?.gallery_image_urls ?? [];
    assert(entry.media?.main_image_url == null, `${entry.sku}: media carrier unexpectedly has MAIN`);
    assert(gallery.length >= 5 && gallery.length <= 7, `${entry.sku}: gallery length out of range`);
    assert(gallery[0] === BRAND_CARD, `${entry.sku}: slot 1 is not the verified brand card`);
    assert(new Set(gallery).size === gallery.length, `${entry.sku}: duplicate gallery URL`);
    assert(
      canonical(entry.media?.delete_gallery_slots) === canonical(exactTailSlots(gallery.length)),
      `${entry.sku}: stale-tail deletion is not the exact complement`,
    );
    assert(entry.review?.confidence === "HIGH", `${entry.sku}: gallery review is not HIGH`);
  }
  const commonCorrectedGallery = [
    BRAND_CARD,
    "https://m.media-amazon.com/images/I/81wkh7GbhQL.jpg",
    "https://m.media-amazon.com/images/I/81x9v1+WzTL.jpg",
    "https://m.media-amazon.com/images/I/814OFXhXOAL.jpg",
    "https://m.media-amazon.com/images/I/71nCABtrKCL.jpg",
    "https://m.media-amazon.com/images/I/81diZ9XbgwL.jpg",
  ];
  for (const sku of ["AZ-ASMY-VEQ2", "UA-ASAO-RE7Q", "VC-ASV1-378P"]) {
    assertExactCorrectedGallery(mediaBySku, sku, commonCorrectedGallery, [7, 8]);
  }
  assertExactCorrectedGallery(
    mediaBySku,
    "ZX-ASQU-TKU9",
    [
      BRAND_CARD,
      "https://m.media-amazon.com/images/I/81xVX0-EKWL.jpg",
      "https://m.media-amazon.com/images/I/81wkh7GbhQL.jpg",
      "https://m.media-amazon.com/images/I/814QzPWtCjL.jpg",
      "https://m.media-amazon.com/images/I/81x9v1+WzTL.jpg",
    ],
    [6, 7, 8],
  );

  const futureCarrierV4Bytes = supersededByPath.get(
    "data/repairs/uncrustables-gallery-media-desired-20260718-v4.json",
  );
  assert(futureCarrierV4Bytes, "Superseded carrier v4 bytes are missing");
  const futureCarrierV4 = JSON.parse(
    futureCarrierV4Bytes.toString("utf8"),
  ) as DesiredRepairManifest;
  const mediaProjection = (rows: DesiredRepairManifest["repairs"]) => rows
    .map((repair) => ({ sku: repair.sku, media: repair.media }))
    .sort((left, right) => left.sku.localeCompare(right.sku));
  assert(
    canonical(mediaProjection(carrier.repairs)) ===
      canonical(mediaProjection(futureCarrierV4.repairs)),
    "Provenance correction changed the exact carrier v4 customer MEDIA payload",
  );

  const repairs = content.repairs.map((factual) => {
    assert(factual.review?.confidence === "HIGH", `${factual.sku}: r6 review is not HIGH`);
    const media = mediaBySku.get(factual.sku);
    if (!media) return structuredClone(factual);
    assert(media.review, `${factual.sku}: gallery review is missing`);
    return {
      ...structuredClone(factual),
      review: combineReview(factual.review, media.review),
      media: structuredClone(media.media),
    };
  });
  assert(repairs.length === 164, "Merged manifest lost a live repair row");
  assert(
    repairs.filter((repair) => repair.media).length === 120,
    "Merged manifest lost a gallery repair",
  );
  const priorMediaBySku = new Map(
    futureCarrierV4.repairs.map((repair) => [repair.sku, repair.media]),
  );
  const expectedHistoricalCustomerPayload = futureR5.repairs.map((repair) => ({
    ...structuredClone(repair),
    ...(priorMediaBySku.get(repair.sku)
      ? { media: structuredClone(priorMediaBySku.get(repair.sku)) }
      : {}),
  }));
  assert(
    canonical(customerRepairProjection(repairs)) ===
      canonical(customerRepairProjection(expectedHistoricalCustomerPayload)),
    "Final merge changed customer payload beyond the approved r6 plus carrier v5 state",
  );

  const body: Omit<FinalMergedManifest, "body_sha256"> = {
    schema_version: "uncrustables-surgical-desired/v1",
    immutable: true,
    reviewed_at: REVIEWED_AT,
    source_ledger_sha256: SOURCES.ledger.sha256,
    source_artifacts: {
      ledger: { ...SOURCES.ledger },
      factual_audit: { ...SOURCES.factual_audit },
      reviewed_content_r6: { ...SOURCES.reviewed_content, repair_count: 164 },
      gallery_surgical_plan_v4: {
        ...SOURCES.gallery_plan,
        body_sha256: galleryPlan.body_sha256 as string,
        plan_id: galleryPlan.plan_id as string,
      },
      gallery_media_carrier_v5: {
        ...SOURCES.gallery_media_carrier,
        extraction: "MEDIA_ONLY",
        source_media_repairs: 120,
      },
    },
    supersedes: SUPERSEDED.map((source) => ({
      ...source,
      status: "SUPERSEDED_DO_NOT_APPLY" as const,
    })),
    merge_summary: {
      exact_live_scope: 164,
      factual_text_repairs: repairs.filter((repair) => repair.text_count?.title).length,
      explicit_offer_overrides: repairs.filter((repair) => repair.offer).length,
      explicit_structured_overrides: repairs.filter((repair) => repair.structured_attributes).length,
      secondary_gallery_repairs: 120,
      overlapping_media_and_factual_repairs: 120,
      final_repairs: 164,
      explicit_tail_slot_deletions: repairs.reduce(
        (sum, repair) => sum + (repair.media?.delete_gallery_slots?.length ?? 0),
        0,
      ),
    },
    repairs,
  };
  assert(body.merge_summary.factual_text_repairs === 164, "Not every row has full text");
  assert(body.merge_summary.explicit_offer_overrides === 2, "Explicit offer override count changed");
  assert(
    body.merge_summary.explicit_structured_overrides === 3,
    "Explicit structured override count changed",
  );
  assert(body.merge_summary.explicit_tail_slot_deletions === 199, "Tail deletion total changed");
  const bodyWithoutSupersedes = { ...body, supersedes: [] };
  assert(
    !/gallery\s+v[123]\b/i.test(canonical(bodyWithoutSupersedes)),
    "Final merged body contains a stale gallery version label",
  );
  const manifest: FinalMergedManifest = {
    ...body,
    body_sha256: sha256(canonical(body)),
  };
  assert(
    bodySeal(manifest as unknown as Record<string, unknown>) === manifest.body_sha256,
    "Final merged body seal failed",
  );

  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const digest = sha256(bytes);
  await writeIdenticalOrCreate(path.resolve(root, OUTPUT_PATH), bytes);
  await writeIdenticalOrCreate(
    path.resolve(root, `${OUTPUT_PATH}.sha256`),
    Buffer.from(`${digest}  ${path.basename(OUTPUT_PATH)}\n`),
  );
  process.stdout.write(`${JSON.stringify({
    output: OUTPUT_PATH,
    sha256: digest,
    body_sha256: manifest.body_sha256,
    merge_summary: manifest.merge_summary,
  })}\n`);
}

await main();
