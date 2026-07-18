/**
 * Production-safe verified product-gallery pipeline for the 164 Uncrustables
 * repair targets.
 *
 * Default (no --apply):
 *   - reads the immutable hero preflight + newest offline ledger;
 *   - performs SELECT-only reads for the exact 20 reviewed donor IDs;
 *   - downloads/decodes every candidate and enforces minimum dimensions;
 *   - selects a deterministic balanced 4-6 image gallery for every SKU;
 *   - writes an immutable source audit and content-addressed contact sheets.
 *
 * Apply is deliberately separate and requires all three review locks:
 *   --apply
 *   --audit=PATH
 *   --reviewed-audit-sha256=<exact SHA-256>
 *   --confirm=UPLOAD-UNCRUSTABLES-GALLERY-<first 16 SHA chars>
 *
 * Apply re-reads the exact preflight/ledger bytes, re-downloads every selected
 * source, verifies both source and normalized-asset SHA before the first PUT,
 * and uploads only immutable content-addressed JPEGs. It never calls Amazon and
 * never writes the database.
 *
 * Run:
 *   npx tsx scripts/build-uncrustables-product-gallery.ts
 */

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createClient, type Client } from "@libsql/client";
import { config } from "dotenv";
import { open, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

import {
  PRODUCT_GALLERY_AUDIT_SCHEMA,
  PRODUCT_GALLERY_CURATED_ASSET_EXCLUSIONS,
  PRODUCT_GALLERY_MANIFEST_SCHEMA,
  PRODUCT_GALLERY_MAX_IMAGES,
  PRODUCT_GALLERY_MIN_IMAGES,
  PRODUCT_GALLERY_SEMANTIC_POLICY_VERSION,
  PRODUCT_GALLERY_TARGET,
  assertHttpsUrl,
  isSha256,
  productGalleryConfirmationToken,
  productGalleryHighResolutionUrl,
  productGalleryObjectKey,
  productGallerySemanticExclusion,
  selectBalancedGallery,
  sha256,
  type GalleryCandidate,
  type GalleryComponentCandidates,
  type GalleryLineage,
  type ProductGallerySemanticExclusion,
  type ValidatedGalleryCandidate,
} from "@/lib/bundle-factory/repair/uncrustables-product-gallery";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

const DEFAULT_PREFLIGHT =
  "data/audits/uncrustables-hero-preflight-20260717T231622479Z.json";
const DEFAULT_LEDGER =
  "data/audits/uncrustables-ledger-20260717T232140568Z-offline.json";
const DEFAULT_OUTPUT_DIR = "data/audits";
const EXPECTED_DONOR_COUNT = 20;
const NORMALIZATION_VERSION = "uncrustables-gallery-jpeg/v1";
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const CONTACT_SHEET_ROWS = 6;

interface Options {
  preflight: string;
  ledger: string;
  outputDir: string;
  apply: boolean;
  audit: string | null;
  reviewedAuditSha256: string | null;
  confirm: string | null;
  concurrency: number;
  minWidth: number;
  minHeight: number;
}

interface PreflightPlanItem {
  flavor: string;
  donor_id: string;
  donor_title: string;
  source_url: string;
  source_reviewed: boolean;
  retail_pack: number;
  recipe_qty: number;
  candidate_count: number;
  visible_boxes: number;
}

interface PreflightRow {
  sku: string;
  asin: string;
  draft_id: string;
  pass: boolean;
  expected_flavors: string[];
  plan: PreflightPlanItem[];
}

interface PreflightArtifact {
  schema_version: string;
  immutable: boolean;
  summary: { target: number; passed: number; failed: number };
  rows: PreflightRow[];
}

interface LedgerRow {
  sku: string;
  asin: string | null;
  live?: { fetched?: boolean } | null;
}

interface LedgerArtifact {
  schema_version?: string;
  audit_id?: string;
  immutable?: boolean;
  rows?: LedgerRow[];
}

interface DonorOfferLineage {
  retailer: string;
  retailerProductId: string;
  productUrl: string;
  isFirstParty: boolean;
  via: string;
  sourceApi: string | null;
  fetchedAt: string | null;
}

interface DonorRecord {
  id: string;
  title: string;
  identityKey: string;
  needsReview: boolean;
  mainImageUrl: string;
  imageUrls: string[];
  lineage: DonorOfferLineage[];
}

interface ImageValidation {
  source_url: string;
  source_sha256: string;
  source_bytes: number;
  asset_sha256: string;
  asset_bytes: number;
  width: number;
  height: number;
  source_format: string;
  asset_format: "jpeg";
  asset: Buffer;
}

interface RejectedCandidate {
  donor_id: string;
  source_url: string;
  stage: "semantic-policy" | "technical-validation";
  reason: string;
  category?: ProductGallerySemanticExclusion["category"];
  retailer_asset_id?: string;
  matched_by?: ProductGallerySemanticExclusion["matched_by"];
}

function recordRejectedCandidate(
  rejected: RejectedCandidate[],
  candidate: RejectedCandidate,
): void {
  const duplicate = rejected.some(
    (item) =>
      item.donor_id === candidate.donor_id &&
      item.source_url === candidate.source_url &&
      item.stage === candidate.stage &&
      item.reason === candidate.reason,
  );
  if (!duplicate) rejected.push(candidate);
}

interface SourceAuditRow {
  sku: string;
  asin: string;
  draft_id: string;
  pass: boolean;
  expected_flavors: string[];
  selected_images: ValidatedGalleryCandidate[];
  error?: string;
}

interface ContactSheetRecord {
  path: string;
  sha256: string;
  byte_length: number;
  skus: string[];
}

interface SourceAuditArtifact {
  schema_version: typeof PRODUCT_GALLERY_AUDIT_SCHEMA;
  immutable: true;
  created_at: string;
  external_mutations: {
    database_writes: 0;
    amazon_calls: 0;
    r2_uploads: 0;
  };
  source_preflight: {
    path: string;
    sha256: string;
    schema_version: string;
  };
  source_ledger: {
    path: string;
    sha256: string;
    schema_version: string | null;
    audit_id: string | null;
  };
  selection_policy: {
    normalization_version: typeof NORMALIZATION_VERSION;
    min_width: number;
    min_height: number;
    min_images: typeof PRODUCT_GALLERY_MIN_IMAGES;
    max_images: typeof PRODUCT_GALLERY_MAX_IMAGES;
    uniqueness: "normalized_asset_sha256";
    balancing: "recipe_component_round_robin";
    semantic_exclusions_version: typeof PRODUCT_GALLERY_SEMANTIC_POLICY_VERSION;
    curated_asset_exclusions: typeof PRODUCT_GALLERY_CURATED_ASSET_EXCLUSIONS;
  };
  donor_evidence: Array<{
    donor_id: string;
    title: string;
    identity_key: string;
    needs_review: false;
    source_lineage: GalleryLineage[];
    candidate_urls: string[];
  }>;
  rejected_candidates: RejectedCandidate[];
  contact_sheets: ContactSheetRecord[];
  summary: {
    target: number;
    passed: number;
    failed: number;
    donor_ids: number;
    selected_images: number;
    unique_selected_assets: number;
  };
  rows: SourceAuditRow[];
}

interface UploadedAsset {
  asset_sha256: string;
  key: string;
  url: string;
  byte_length: number;
  uploaded: boolean;
}

function usage(): string {
  return [
    "Verified Uncrustables product gallery (default: read-only audit)",
    "",
    `  --preflight=PATH             default ${DEFAULT_PREFLIGHT}`,
    `  --ledger=PATH                default ${DEFAULT_LEDGER}`,
    `  --output-dir=DIR             default ${DEFAULT_OUTPUT_DIR}`,
    "  --concurrency=N              image downloads, 1-8 (default 4)",
    "  --min-width=N                default 1000",
    "  --min-height=N               default 1000",
    "",
    "Apply-only review locks:",
    "  --apply",
    "  --audit=PATH",
    "  --reviewed-audit-sha256=<64 hex>",
    "  --confirm=<token printed by the audit>",
  ].join("\n");
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    preflight: DEFAULT_PREFLIGHT,
    ledger: DEFAULT_LEDGER,
    outputDir: DEFAULT_OUTPUT_DIR,
    apply: false,
    audit: null,
    reviewedAuditSha256: null,
    confirm: null,
    concurrency: 4,
    minWidth: 1000,
    minHeight: 1000,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--apply") options.apply = true;
    else if (arg.startsWith("--preflight=")) options.preflight = arg.slice(12).trim();
    else if (arg.startsWith("--ledger=")) options.ledger = arg.slice(9).trim();
    else if (arg.startsWith("--output-dir=")) options.outputDir = arg.slice(13).trim();
    else if (arg.startsWith("--audit=")) options.audit = arg.slice(8).trim();
    else if (arg.startsWith("--reviewed-audit-sha256=")) {
      options.reviewedAuditSha256 = arg
        .slice("--reviewed-audit-sha256=".length)
        .trim()
        .toLowerCase();
    } else if (arg.startsWith("--confirm=")) options.confirm = arg.slice(10).trim();
    else if (arg.startsWith("--concurrency=")) options.concurrency = Number(arg.slice(14));
    else if (arg.startsWith("--min-width=")) options.minWidth = Number(arg.slice(12));
    else if (arg.startsWith("--min-height=")) options.minHeight = Number(arg.slice(13));
    else throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) {
    throw new Error("--concurrency must be an integer from 1 to 8.");
  }
  if (!Number.isInteger(options.minWidth) || options.minWidth < 500) {
    throw new Error("--min-width must be an integer >= 500.");
  }
  if (!Number.isInteger(options.minHeight) || options.minHeight < 500) {
    throw new Error("--min-height must be an integer >= 500.");
  }
  if (options.apply) {
    if (!options.audit) throw new Error("Apply requires --audit=PATH.");
    if (!options.reviewedAuditSha256 || !isSha256(options.reviewedAuditSha256)) {
      throw new Error("Apply requires --reviewed-audit-sha256=<64 hex>.");
    }
    const expected = productGalleryConfirmationToken(options.reviewedAuditSha256);
    if (options.confirm !== expected) {
      throw new Error(`Apply requires exact --confirm=${expected}`);
    }
  } else if (options.audit || options.reviewedAuditSha256 || options.confirm) {
    throw new Error("--audit/--reviewed-audit-sha256/--confirm are apply-only options.");
  }
  return options;
}

function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function requiredEnv(name: string): string {
  const value = cleanEnv(process.env[name]);
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(".", "");
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function forbiddenSyntheticSource(value: string): boolean {
  const parsed = new URL(value);
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  return (
    host === "placehold.co" ||
    host.endsWith("r2.dev") ||
    host.endsWith("cloudflarestorage.com") ||
    pathname.includes("/bf-cooler/") ||
    pathname.includes("/bf-composite/") ||
    pathname.includes("/prod/draft-")
  );
}

function parseInputs(
  preflightPath: string,
  preflightBytes: Buffer,
  ledgerPath: string,
  ledgerBytes: Buffer,
): {
  preflight: PreflightArtifact;
  ledger: LedgerArtifact;
  donorIds: string[];
  preflightSha: string;
  ledgerSha: string;
} {
  const preflight = JSON.parse(preflightBytes.toString("utf8")) as PreflightArtifact;
  const ledger = JSON.parse(ledgerBytes.toString("utf8")) as LedgerArtifact;
  if (
    preflight.schema_version !== "uncrustables-hero-preflight/v1.0" ||
    preflight.immutable !== true ||
    preflight.summary?.target !== PRODUCT_GALLERY_TARGET ||
    preflight.summary?.passed !== PRODUCT_GALLERY_TARGET ||
    preflight.summary?.failed !== 0 ||
    !Array.isArray(preflight.rows) ||
    preflight.rows.length !== PRODUCT_GALLERY_TARGET
  ) {
    throw new Error(`${preflightPath} is not the complete reviewed 164-row hero preflight.`);
  }
  if (!Array.isArray(ledger.rows)) throw new Error(`${ledgerPath} has no rows array.`);

  const ledgerBySku = new Map(ledger.rows.map((row) => [row.sku, row]));
  const skus = new Set<string>();
  const asins = new Set<string>();
  const donorIds: string[] = [];
  for (const row of preflight.rows) {
    if (!row.pass || !nonEmpty(row.sku) || !nonEmpty(row.asin) || !Array.isArray(row.plan) || !row.plan.length) {
      throw new Error(`Invalid preflight row for ${row.sku || "(missing SKU)"}.`);
    }
    if (skus.has(row.sku)) throw new Error(`Duplicate preflight SKU ${row.sku}.`);
    if (asins.has(row.asin)) throw new Error(`Duplicate preflight ASIN ${row.asin}.`);
    skus.add(row.sku);
    asins.add(row.asin);
    const current = ledgerBySku.get(row.sku);
    if (!current || current.asin !== row.asin || current.live?.fetched !== true) {
      throw new Error(`Newest ledger is missing the fetched SKU/ASIN pair ${row.sku}/${row.asin}.`);
    }
    row.plan.forEach((item, index) => {
      if (
        !nonEmpty(item.donor_id) ||
        !nonEmpty(item.donor_title) ||
        !nonEmpty(item.flavor) ||
        item.source_reviewed !== true
      ) {
        throw new Error(`${row.sku} plan component ${index + 1} is not donor-reviewed.`);
      }
      assertHttpsUrl(`${row.sku} plan source ${index + 1}`, item.source_url);
      if (forbiddenSyntheticSource(item.source_url)) {
        throw new Error(`${row.sku} plan source ${index + 1} is a generated/internal asset.`);
      }
      donorIds.push(item.donor_id);
    });
  }
  const exactDonorIds = unique(donorIds).sort();
  if (exactDonorIds.length !== EXPECTED_DONOR_COUNT) {
    throw new Error(
      `Expected exactly ${EXPECTED_DONOR_COUNT} chosen donor IDs; found ${exactDonorIds.length}.`,
    );
  }
  return {
    preflight,
    ledger,
    donorIds: exactDonorIds,
    preflightSha: sha256(preflightBytes),
    ledgerSha: sha256(ledgerBytes),
  };
}

function readOnlyClient(): Client {
  const tursoUrl = cleanEnv(process.env.TURSO_DATABASE_URL);
  const tursoToken = cleanEnv(process.env.TURSO_AUTH_TOKEN);
  const databaseUrl = cleanEnv(process.env.DATABASE_URL);
  if (tursoUrl) return createClient({ url: tursoUrl, authToken: tursoToken });
  if (databaseUrl) return createClient({ url: databaseUrl });
  return createClient({ url: `file:${path.resolve("dev.db")}` });
}

async function loadExactDonors(client: Client, ids: string[]): Promise<Map<string, DonorRecord>> {
  const placeholders = ids.map(() => "?").join(",");
  // These are intentionally literal SELECT statements. This script has no SQL
  // mutation path and never imports Prisma's create/update/delete delegates.
  const donorResult = await client.execute({
    sql:
      `SELECT id, title, identityKey, needsReview, mainImageUrl, imageUrls ` +
      `FROM "DonorProduct" WHERE id IN (${placeholders}) ORDER BY id`,
    args: ids,
  });
  const offerResult = await client.execute({
    sql:
      `SELECT donorProductId, retailer, retailerProductId, productUrl, ` +
      `isFirstParty, via, sourceApi, fetchedAt ` +
      `FROM "DonorOffer" WHERE donorProductId IN (${placeholders}) ` +
      `ORDER BY donorProductId, retailer, retailerProductId`,
    args: ids,
  });

  const offersByDonor = new Map<string, DonorOfferLineage[]>();
  for (const row of offerResult.rows) {
    const donorId = nonEmpty(row.donorProductId);
    const retailer = nonEmpty(row.retailer);
    const retailerProductId = nonEmpty(row.retailerProductId);
    const productUrl = nonEmpty(row.productUrl);
    if (!donorId || !retailer || !retailerProductId || !productUrl) continue;
    try {
      assertHttpsUrl(`${donorId} offer productUrl`, productUrl);
    } catch {
      continue;
    }
    const list = offersByDonor.get(donorId) ?? [];
    list.push({
      retailer,
      retailerProductId,
      productUrl,
      isFirstParty: Boolean(row.isFirstParty),
      via: nonEmpty(row.via) ?? "unknown",
      sourceApi: nonEmpty(row.sourceApi),
      fetchedAt: nonEmpty(row.fetchedAt),
    });
    offersByDonor.set(donorId, list);
  }

  const records = new Map<string, DonorRecord>();
  for (const row of donorResult.rows) {
    const id = nonEmpty(row.id);
    const title = nonEmpty(row.title);
    const identityKey = nonEmpty(row.identityKey);
    const mainImageUrl = nonEmpty(row.mainImageUrl);
    if (!id || !title || !identityKey || !mainImageUrl) {
      throw new Error(`Donor ${id ?? "(missing id)"} lacks title/identity/main image.`);
    }
    if (Boolean(row.needsReview)) throw new Error(`Chosen donor ${id} has needsReview=true.`);
    assertHttpsUrl(`${id} mainImageUrl`, mainImageUrl);
    if (forbiddenSyntheticSource(mainImageUrl)) {
      throw new Error(`Chosen donor ${id} main image is an internal/generated asset.`);
    }
    let imageUrls: unknown;
    try {
      imageUrls = row.imageUrls ? JSON.parse(String(row.imageUrls)) : [];
    } catch {
      throw new Error(`Chosen donor ${id} imageUrls is malformed JSON.`);
    }
    if (!Array.isArray(imageUrls) || imageUrls.some((value) => typeof value !== "string")) {
      throw new Error(`Chosen donor ${id} imageUrls must be a JSON string array.`);
    }
    const lineage = (offersByDonor.get(id) ?? []).filter(
      (offer) => offer.isFirstParty && offer.via === "direct",
    );
    if (lineage.length === 0) {
      throw new Error(
        `Chosen donor ${id} has no first-party direct retailer/product URL lineage.`,
      );
    }
    records.set(id, {
      id,
      title,
      identityKey,
      needsReview: false,
      mainImageUrl,
      imageUrls: imageUrls.map(String),
      lineage,
    });
  }
  const missing = ids.filter((id) => !records.has(id));
  if (missing.length > 0 || records.size !== ids.length) {
    throw new Error(`Exact donor query missed ${missing.length} ID(s): ${missing.join(", ")}`);
  }
  return records;
}

function lineageEvidence(donor: DonorRecord): GalleryLineage[] {
  return donor.lineage.map((item) => ({
    retailer: item.retailer,
    retailer_product_id: item.retailerProductId,
    product_url: item.productUrl,
    source_api: item.sourceApi,
    fetched_at: item.fetchedAt,
    first_party: item.isFirstParty,
    via: item.via,
  }));
}

function candidateUrlsForDonor(
  donor: DonorRecord,
  plannedSourceUrl: string,
  rejected: RejectedCandidate[],
): Array<{ url: string; kind: GalleryCandidate["source_kind"]; ordinal: number }> {
  const upgradedMain = productGalleryHighResolutionUrl(donor.mainImageUrl);
  if (plannedSourceUrl !== donor.mainImageUrl && plannedSourceUrl !== upgradedMain) {
    throw new Error(
      `Preflight source for ${donor.id} no longer derives from its current main image.`,
    );
  }
  const candidates = [
    {
      url: productGalleryHighResolutionUrl(plannedSourceUrl),
      kind: "preflight-reviewed-front" as const,
      ordinal: 0,
    },
    { url: upgradedMain, kind: "donor-main" as const, ordinal: 0 },
    ...donor.imageUrls.map((value, index) => ({
      url: productGalleryHighResolutionUrl(value.trim()),
      kind: "donor-gallery" as const,
      ordinal: index,
    })),
  ];
  const byUrl = new Map<
    string,
    { url: string; kind: GalleryCandidate["source_kind"]; ordinal: number }
  >();
  for (const candidate of candidates) {
    if (!candidate.url) continue;
    assertHttpsUrl(`${donor.id} candidate`, candidate.url);
    if (forbiddenSyntheticSource(candidate.url)) continue;
    const semanticExclusion = productGallerySemanticExclusion(candidate.url);
    if (semanticExclusion) {
      recordRejectedCandidate(rejected, {
        donor_id: donor.id,
        source_url: candidate.url,
        stage: "semantic-policy",
        category: semanticExclusion.category,
        retailer_asset_id: semanticExclusion.retailer_asset_id,
        matched_by: semanticExclusion.matched_by,
        reason: semanticExclusion.reason,
      });
      continue;
    }
    if (!byUrl.has(candidate.url)) byUrl.set(candidate.url, candidate);
  }
  return [...byUrl.values()];
}

async function fetchSource(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: {
      "user-agent": "SS-Command-Center-Uncrustables-Gallery-Audit/1.0",
      accept: "image/jpeg,image/png,image/webp,image/*;q=0.8",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (new URL(response.url).protocol !== "https:") throw new Error("redirected away from HTTPS");
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_DOWNLOAD_BYTES) throw new Error(`content-length ${length} exceeds limit`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error("empty response");
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error(`download ${bytes.length} exceeds limit`);
  return bytes;
}

async function validateAndNormalizeImage(
  sourceUrl: string,
  source: Buffer,
  minWidth: number,
  minHeight: number,
): Promise<ImageValidation> {
  const decoded = await sharp(source, {
    failOn: "error",
    limitInputPixels: 100_000_000,
    sequentialRead: true,
  })
    .rotate()
    .toBuffer({ resolveWithObject: true });
  const width = decoded.info.width;
  const height = decoded.info.height;
  const sourceFormat = decoded.info.format;
  if (!width || !height) throw new Error("decoder returned no dimensions");
  if (width < minWidth || height < minHeight) {
    throw new Error(`${width}x${height} is below ${minWidth}x${minHeight}`);
  }
  if (!sourceFormat || !["jpeg", "png", "webp", "tiff"].includes(sourceFormat)) {
    throw new Error(`unsupported decoded format ${sourceFormat || "unknown"}`);
  }
  // Fixed transform: auto-orient, flatten on white, sRGB, metadata-free JPEG.
  // The resulting SHA is stable and is the only value allowed in the R2 key.
  const asset = await sharp(source, {
    failOn: "error",
    limitInputPixels: 100_000_000,
    sequentialRead: true,
  })
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .toColourspace("srgb")
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4", progressive: false })
    .toBuffer();
  return {
    source_url: sourceUrl,
    source_sha256: sha256(source),
    source_bytes: source.length,
    asset_sha256: sha256(asset),
    asset_bytes: asset.length,
    width,
    height,
    source_format: sourceFormat,
    asset_format: "jpeg",
    asset,
  };
}

async function parallelMap<T, R>(
  values: T[],
  concurrency: number,
  fn: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      output[index] = await fn(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return output;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function short(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

async function writeExclusive(file: string, bytes: Buffer | string): Promise<void> {
  const handle = await open(file, "wx");
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

async function renderContactSheets(
  rows: SourceAuditRow[],
  assets: Map<string, Buffer>,
  outputDir: string,
  runStamp: string,
  ledgerSha: string,
): Promise<ContactSheetRecord[]> {
  const passed = rows.filter((row) => row.pass);
  const pages = Math.ceil(passed.length / CONTACT_SHEET_ROWS);
  const records: ContactSheetRecord[] = [];
  const width = 2100;
  const headerHeight = 92;
  const rowHeight = 282;
  const labelWidth = 400;
  const tileWidth = 275;
  const imageSize = 230;

  for (let page = 0; page < pages; page++) {
    const pageRows = passed.slice(page * CONTACT_SHEET_ROWS, (page + 1) * CONTACT_SHEET_ROWS);
    const height = headerHeight + pageRows.length * rowHeight + 20;
    const labels: string[] = [
      `<rect width="${width}" height="${height}" fill="#f5f5f2"/>`,
      `<text x="28" y="38" font-family="Arial,sans-serif" font-size="26" font-weight="700" fill="#111">Uncrustables product-gallery review</text>`,
      `<text x="28" y="70" font-family="monospace" font-size="16" fill="#555">sheet ${page + 1}/${pages} · ledger ${ledgerSha.slice(0, 16)} · source images only</text>`,
    ];
    const composites: sharp.OverlayOptions[] = [];
    for (let rowIndex = 0; rowIndex < pageRows.length; rowIndex++) {
      const row = pageRows[rowIndex];
      const top = headerHeight + rowIndex * rowHeight;
      labels.push(
        `<rect x="12" y="${top}" width="${width - 24}" height="${rowHeight - 8}" rx="8" fill="${rowIndex % 2 ? "#ffffff" : "#ebece8"}"/>`,
        `<text x="30" y="${top + 40}" font-family="monospace" font-size="22" font-weight="700" fill="#111">${escapeXml(row.sku)}</text>`,
        `<text x="30" y="${top + 70}" font-family="monospace" font-size="17" fill="#444">${escapeXml(row.asin)}</text>`,
        `<text x="30" y="${top + 104}" font-family="Arial,sans-serif" font-size="16" fill="#333">${escapeXml(short(row.expected_flavors.join(" + "), 43))}</text>`,
        `<text x="30" y="${top + 136}" font-family="Arial,sans-serif" font-size="15" fill="#666">${row.selected_images.length} verified candidates</text>`,
      );
      for (let imageIndex = 0; imageIndex < row.selected_images.length; imageIndex++) {
        const selected = row.selected_images[imageIndex];
        const asset = assets.get(selected.asset_sha256);
        if (!asset) throw new Error(`Contact-sheet asset missing: ${selected.asset_sha256}`);
        const left = labelWidth + imageIndex * tileWidth + 18;
        const imageTop = top + 18;
        const thumb = await sharp(asset)
          .resize(imageSize, imageSize, {
            fit: "contain",
            background: { r: 255, g: 255, b: 255 },
          })
          .jpeg({ quality: 90 })
          .toBuffer();
        composites.push({ input: thumb, left, top: imageTop });
        labels.push(
          `<text x="${left}" y="${top + 263}" font-family="monospace" font-size="13" fill="#333">${imageIndex + 1} · ${escapeXml(short(selected.donor_id, 8))} · ${selected.width}x${selected.height}</text>`,
        );
      }
    }
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${labels.join("")}</svg>`,
    );
    const png = await sharp({
      create: { width, height, channels: 3, background: { r: 245, g: 245, b: 242 } },
    })
      .composite([{ input: svg, left: 0, top: 0 }, ...composites])
      .png({ compressionLevel: 9 })
      .toBuffer();
    const digest = sha256(png);
    const file = path.join(
      outputDir,
      `uncrustables-gallery-review-${runStamp}-sheet-${String(page + 1).padStart(3, "0")}-${digest.slice(0, 12)}.png`,
    );
    await writeExclusive(file, png);
    records.push({
      path: file,
      sha256: digest,
      byte_length: png.length,
      skus: pageRows.map((row) => row.sku),
    });
  }
  return records;
}

async function runAudit(options: Options): Promise<void> {
  const preflightPath = path.resolve(options.preflight);
  const ledgerPath = path.resolve(options.ledger);
  const [preflightBytes, ledgerBytes] = await Promise.all([
    readFile(preflightPath),
    readFile(ledgerPath),
  ]);
  const inputs = parseInputs(preflightPath, preflightBytes, ledgerPath, ledgerBytes);
  const client = readOnlyClient();
  let donors: Map<string, DonorRecord>;
  try {
    donors = await loadExactDonors(client, inputs.donorIds);
  } finally {
    client.close();
  }

  const candidateUrls = new Set<string>();
  const rejected: RejectedCandidate[] = [];
  const candidatesByDonor = new Map<
    string,
    Array<{ url: string; kind: GalleryCandidate["source_kind"]; ordinal: number }>
  >();
  for (const row of inputs.preflight.rows) {
    for (const item of row.plan) {
      const donor = donors.get(item.donor_id)!;
      const candidates = candidateUrlsForDonor(donor, item.source_url, rejected);
      const prior = candidatesByDonor.get(donor.id);
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(candidates)) {
          throw new Error(`Non-deterministic candidate set for donor ${donor.id}.`);
        }
      } else {
        candidatesByDonor.set(donor.id, candidates);
      }
      candidates.forEach((candidate) => candidateUrls.add(candidate.url));
    }
  }

  const validationByUrl = new Map<string, ImageValidation>();
  const sortedUrls = [...candidateUrls].sort();
  await parallelMap(sortedUrls, options.concurrency, async (url, index) => {
    try {
      const source = await fetchSource(url);
      const validation = await validateAndNormalizeImage(
        url,
        source,
        options.minWidth,
        options.minHeight,
      );
      const semanticExclusion = productGallerySemanticExclusion(
        url,
        validation.asset_sha256,
      );
      if (semanticExclusion) {
        const donorIds = [...candidatesByDonor.entries()]
          .filter(([, values]) => values.some((candidate) => candidate.url === url))
          .map(([donorId]) => donorId)
          .sort();
        for (const donorId of donorIds) {
          recordRejectedCandidate(rejected, {
            donor_id: donorId,
            source_url: url,
            stage: "semantic-policy",
            category: semanticExclusion.category,
            retailer_asset_id: semanticExclusion.retailer_asset_id,
            matched_by: semanticExclusion.matched_by,
            reason: semanticExclusion.reason,
          });
        }
        console.log(
          `AUDIT ${String(index + 1).padStart(3, "0")}/${sortedUrls.length} REJECT ${semanticExclusion.category} ${url}`,
        );
        return;
      }
      validationByUrl.set(url, validation);
      console.log(
        `AUDIT ${String(index + 1).padStart(3, "0")}/${sortedUrls.length} PASS ${validation.width}x${validation.height} ${url}`,
      );
    } catch (error) {
      const donorId = [...candidatesByDonor.entries()].find(([, values]) =>
        values.some((candidate) => candidate.url === url),
      )?.[0] ?? "unknown";
      const reason = error instanceof Error ? error.message : String(error);
      recordRejectedCandidate(rejected, {
        donor_id: donorId,
        source_url: url,
        stage: "technical-validation",
        reason,
      });
      console.log(
        `AUDIT ${String(index + 1).padStart(3, "0")}/${sortedUrls.length} REJECT ${reason} ${url}`,
      );
    }
  });

  const rows: SourceAuditRow[] = [];
  for (const sourceRow of inputs.preflight.rows) {
    try {
      const groups: GalleryComponentCandidates[] = sourceRow.plan.map((item, componentIndex) => {
        const donor = donors.get(item.donor_id)!;
        const lineage = lineageEvidence(donor);
        const candidates: ValidatedGalleryCandidate[] = [];
        for (const source of candidatesByDonor.get(donor.id) ?? []) {
          const validation = validationByUrl.get(source.url);
          if (!validation) continue;
          candidates.push({
            component_index: componentIndex,
            component_key: `${componentIndex}:${donor.id}:${item.flavor}`,
            flavor: item.flavor,
            donor_id: donor.id,
            donor_title: donor.title,
            source_kind: source.kind,
            source_ordinal: source.ordinal,
            source_url: source.url,
            lineage,
            source_sha256: validation.source_sha256,
            source_bytes: validation.source_bytes,
            asset_sha256: validation.asset_sha256,
            asset_bytes: validation.asset_bytes,
            width: validation.width,
            height: validation.height,
            source_format: validation.source_format,
            asset_format: "jpeg",
          });
        }
        return {
          component_index: componentIndex,
          component_key: `${componentIndex}:${donor.id}:${item.flavor}`,
          flavor: item.flavor,
          candidates,
        };
      });
      rows.push({
        sku: sourceRow.sku,
        asin: sourceRow.asin,
        draft_id: sourceRow.draft_id,
        pass: true,
        expected_flavors: sourceRow.expected_flavors,
        selected_images: selectBalancedGallery(groups),
      });
    } catch (error) {
      rows.push({
        sku: sourceRow.sku,
        asin: sourceRow.asin,
        draft_id: sourceRow.draft_id,
        pass: false,
        expected_flavors: sourceRow.expected_flavors,
        selected_images: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const outputDir = path.resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const now = new Date();
  const runStamp = stamp(now);
  const selectedAssetBuffers = new Map<string, Buffer>();
  for (const row of rows) {
    for (const image of row.selected_images) {
      const validation = validationByUrl.get(image.source_url);
      if (validation) selectedAssetBuffers.set(image.asset_sha256, validation.asset);
    }
  }
  const contactSheets = await renderContactSheets(
    rows,
    selectedAssetBuffers,
    outputDir,
    runStamp,
    inputs.ledgerSha,
  );
  const failed = rows.filter((row) => !row.pass);
  const payload: SourceAuditArtifact = {
    schema_version: PRODUCT_GALLERY_AUDIT_SCHEMA,
    immutable: true,
    created_at: now.toISOString(),
    external_mutations: { database_writes: 0, amazon_calls: 0, r2_uploads: 0 },
    source_preflight: {
      path: preflightPath,
      sha256: inputs.preflightSha,
      schema_version: inputs.preflight.schema_version,
    },
    source_ledger: {
      path: ledgerPath,
      sha256: inputs.ledgerSha,
      schema_version: inputs.ledger.schema_version ?? null,
      audit_id: inputs.ledger.audit_id ?? null,
    },
    selection_policy: {
      normalization_version: NORMALIZATION_VERSION,
      min_width: options.minWidth,
      min_height: options.minHeight,
      min_images: PRODUCT_GALLERY_MIN_IMAGES,
      max_images: PRODUCT_GALLERY_MAX_IMAGES,
      uniqueness: "normalized_asset_sha256",
      balancing: "recipe_component_round_robin",
      semantic_exclusions_version: PRODUCT_GALLERY_SEMANTIC_POLICY_VERSION,
      curated_asset_exclusions: PRODUCT_GALLERY_CURATED_ASSET_EXCLUSIONS,
    },
    donor_evidence: [...donors.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((donor) => ({
        donor_id: donor.id,
        title: donor.title,
        identity_key: donor.identityKey,
        needs_review: false,
        source_lineage: lineageEvidence(donor),
        candidate_urls: (candidatesByDonor.get(donor.id) ?? []).map((candidate) => candidate.url),
      })),
    rejected_candidates: rejected.sort(
      (left, right) =>
        left.donor_id.localeCompare(right.donor_id) || left.source_url.localeCompare(right.source_url),
    ),
    contact_sheets: contactSheets,
    summary: {
      target: rows.length,
      passed: rows.length - failed.length,
      failed: failed.length,
      donor_ids: donors.size,
      selected_images: rows.reduce((sum, row) => sum + row.selected_images.length, 0),
      unique_selected_assets: selectedAssetBuffers.size,
    },
    rows,
  };
  const auditPath = path.join(
    outputDir,
    `uncrustables-gallery-source-audit-${runStamp}-${inputs.ledgerSha.slice(0, 12)}.json`,
  );
  const auditBytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
  await writeExclusive(auditPath, auditBytes);
  const auditSha = sha256(auditBytes);
  console.log(`Source audit: ${auditPath}`);
  console.log(`Source audit SHA-256: ${auditSha}`);
  console.log(`Contact sheets: ${contactSheets.length}`);
  console.log(JSON.stringify(payload.summary, null, 2));
  if (failed.length === 0 && rows.length === PRODUCT_GALLERY_TARGET) {
    console.log("After visual review, apply requires:");
    console.log(`  --audit=${auditPath}`);
    console.log(`  --reviewed-audit-sha256=${auditSha}`);
    console.log(`  --confirm=${productGalleryConfirmationToken(auditSha)}`);
  } else {
    process.exitCode = 2;
  }
}

function assertSourceAudit(
  audit: SourceAuditArtifact,
  auditPath: string,
  preflightSha: string,
  ledgerSha: string,
): void {
  if (
    audit.schema_version !== PRODUCT_GALLERY_AUDIT_SCHEMA ||
    audit.immutable !== true ||
    audit.source_preflight?.sha256 !== preflightSha ||
    audit.source_ledger?.sha256 !== ledgerSha ||
    audit.selection_policy?.normalization_version !== NORMALIZATION_VERSION ||
    audit.selection_policy?.semantic_exclusions_version !==
      PRODUCT_GALLERY_SEMANTIC_POLICY_VERSION ||
    JSON.stringify(audit.selection_policy?.curated_asset_exclusions) !==
      JSON.stringify(PRODUCT_GALLERY_CURATED_ASSET_EXCLUSIONS) ||
    audit.summary?.target !== PRODUCT_GALLERY_TARGET ||
    audit.summary?.passed !== PRODUCT_GALLERY_TARGET ||
    audit.summary?.failed !== 0 ||
    !Array.isArray(audit.rows) ||
    audit.rows.length !== PRODUCT_GALLERY_TARGET
  ) {
    throw new Error(`${auditPath} is not a complete gallery source audit for these source bytes.`);
  }
  const seen = new Set<string>();
  for (const row of audit.rows) {
    if (seen.has(row.sku)) throw new Error(`Source audit contains duplicate SKU ${row.sku}.`);
    seen.add(row.sku);
    if (!row.pass || row.selected_images.length < 4 || row.selected_images.length > 6) {
      throw new Error(`Source audit row ${row.sku} is not a passing 4-6 image selection.`);
    }
    const assets = new Set<string>();
    for (const image of row.selected_images) {
      assertHttpsUrl(`${row.sku} audited source`, image.source_url);
      const semanticExclusion = productGallerySemanticExclusion(
        image.source_url,
        image.asset_sha256,
      );
      if (semanticExclusion) {
        throw new Error(
          `Source audit contains denied ${semanticExclusion.category} asset for ${row.sku}.`,
        );
      }
      if (
        !isSha256(image.source_sha256) ||
        !isSha256(image.asset_sha256) ||
        image.width < audit.selection_policy.min_width ||
        image.height < audit.selection_policy.min_height ||
        image.asset_format !== "jpeg"
      ) {
        throw new Error(`Source audit image evidence is invalid for ${row.sku}.`);
      }
      if (assets.has(image.asset_sha256)) {
        throw new Error(`Source audit has duplicate image content for ${row.sku}.`);
      }
      assets.add(image.asset_sha256);
    }
  }
}

function r2Client(): S3Client {
  const accountId = requiredEnv("R2_ACCOUNT_ID");
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
    },
  });
}

function isNotFound(error: unknown): boolean {
  const value = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return value?.$metadata?.httpStatusCode === 404 || /NotFound|NoSuchKey/.test(value?.name ?? "");
}

async function readR2Object(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<Buffer | null> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) throw new Error(`R2 object ${key} has no body.`);
  return Buffer.from(await response.Body.transformToByteArray());
}

async function uploadContentAddressedAsset(
  client: S3Client,
  bucket: string,
  publicBase: string,
  assetSha: string,
  bytes: Buffer,
): Promise<UploadedAsset> {
  if (sha256(bytes) !== assetSha) throw new Error(`In-memory asset SHA mismatch for ${assetSha}.`);
  const key = productGalleryObjectKey(assetSha);
  const existing = await readR2Object(client, bucket, key);
  if (existing) {
    if (sha256(existing) !== assetSha) {
      throw new Error(`Existing content-addressed R2 object has wrong bytes: ${key}`);
    }
    return {
      asset_sha256: assetSha,
      key,
      url: `${publicBase}/${key}`,
      byte_length: bytes.length,
      uploaded: false,
    };
  }
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: bytes,
        ContentType: "image/jpeg",
        CacheControl: "public, max-age=31536000, immutable",
        Metadata: {
          sha256: assetSha,
          pipeline: "uncrustables-product-gallery-v1",
        },
        IfNoneMatch: "*",
      }),
    );
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status !== 409 && status !== 412) throw error;
  }
  const uploaded = await readR2Object(client, bucket, key);
  if (!uploaded || sha256(uploaded) !== assetSha) {
    throw new Error(`R2 read-after-write verification failed for ${key}.`);
  }
  return {
    asset_sha256: assetSha,
    key,
    url: `${publicBase}/${key}`,
    byte_length: bytes.length,
    uploaded: true,
  };
}

async function runApply(options: Options): Promise<void> {
  const preflightPath = path.resolve(options.preflight);
  const ledgerPath = path.resolve(options.ledger);
  const auditPath = path.resolve(options.audit!);
  const [preflightBytes, ledgerBytes, auditBytes] = await Promise.all([
    readFile(preflightPath),
    readFile(ledgerPath),
    readFile(auditPath),
  ]);
  const inputs = parseInputs(preflightPath, preflightBytes, ledgerPath, ledgerBytes);
  const actualAuditSha = sha256(auditBytes);
  if (actualAuditSha !== options.reviewedAuditSha256) {
    throw new Error(
      `Reviewed audit SHA mismatch: expected ${options.reviewedAuditSha256}, read ${actualAuditSha}.`,
    );
  }
  const audit = JSON.parse(auditBytes.toString("utf8")) as SourceAuditArtifact;
  assertSourceAudit(audit, auditPath, inputs.preflightSha, inputs.ledgerSha);
  const preflightBySku = new Map(inputs.preflight.rows.map((row) => [row.sku, row]));
  for (const row of audit.rows) {
    const source = preflightBySku.get(row.sku);
    if (!source || source.asin !== row.asin) {
      throw new Error(`Audit SKU/ASIN no longer matches preflight: ${row.sku}/${row.asin}.`);
    }
  }

  // Stage 1: repeat and verify every external read. No R2 client is created and
  // no PUT can occur until all source and normalized hashes match the review.
  const uniqueAuditedBySource = new Map<string, ValidatedGalleryCandidate>();
  for (const row of audit.rows) {
    for (const image of row.selected_images) {
      const prior = uniqueAuditedBySource.get(image.source_url);
      if (prior && (prior.source_sha256 !== image.source_sha256 || prior.asset_sha256 !== image.asset_sha256)) {
        throw new Error(`Conflicting audit evidence for ${image.source_url}.`);
      }
      uniqueAuditedBySource.set(image.source_url, image);
    }
  }
  const auditedImages = [...uniqueAuditedBySource.values()].sort((left, right) =>
    left.source_url.localeCompare(right.source_url),
  );
  const verifiedAssets = new Map<string, Buffer>();
  await parallelMap(auditedImages, options.concurrency, async (image, index) => {
    const source = await fetchSource(image.source_url);
    if (sha256(source) !== image.source_sha256 || source.length !== image.source_bytes) {
      throw new Error(`Reviewed source bytes changed: ${image.source_url}`);
    }
    const verified = await validateAndNormalizeImage(
      image.source_url,
      source,
      audit.selection_policy.min_width,
      audit.selection_policy.min_height,
    );
    if (
      verified.asset_sha256 !== image.asset_sha256 ||
      verified.asset_bytes !== image.asset_bytes ||
      verified.width !== image.width ||
      verified.height !== image.height
    ) {
      throw new Error(`Reviewed normalized asset changed: ${image.source_url}`);
    }
    const prior = verifiedAssets.get(verified.asset_sha256);
    if (prior && !prior.equals(verified.asset)) {
      throw new Error(`Asset SHA collision for ${verified.asset_sha256}.`);
    }
    verifiedAssets.set(verified.asset_sha256, verified.asset);
    console.log(
      `VERIFY ${String(index + 1).padStart(3, "0")}/${auditedImages.length} ${image.asset_sha256.slice(0, 12)} ${image.source_url}`,
    );
  });

  // Stage 2: the only external mutation in the entire pipeline.
  const bucket = requiredEnv("R2_BUCKET_NAME");
  const publicBase = requiredEnv("R2_PUBLIC_URL").replace(/\/+$/, "");
  assertHttpsUrl("R2_PUBLIC_URL", publicBase);
  const client = r2Client();
  const uploadedBySha = new Map<string, UploadedAsset>();
  const sortedAssets = [...verifiedAssets.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  try {
    for (let index = 0; index < sortedAssets.length; index++) {
      const [assetSha, bytes] = sortedAssets[index];
      const result = await uploadContentAddressedAsset(
        client,
        bucket,
        publicBase,
        assetSha,
        bytes,
      );
      uploadedBySha.set(assetSha, result);
      console.log(
        `R2 ${String(index + 1).padStart(3, "0")}/${sortedAssets.length} ${result.uploaded ? "UPLOAD" : "EXISTS"} ${result.key}`,
      );
    }
  } finally {
    client.destroy();
  }

  const manifestRows = audit.rows.map((row) => {
    const assets = row.selected_images.map((image) => {
      const uploaded = uploadedBySha.get(image.asset_sha256);
      if (!uploaded) throw new Error(`Uploaded asset missing for ${row.sku}.`);
      return { image, uploaded };
    });
    const urls = assets.map(({ uploaded }) => uploaded.url);
    if (urls.length < 4 || urls.length > 6 || new Set(urls).size !== urls.length) {
      throw new Error(`Final R2 gallery invariant failed for ${row.sku}.`);
    }
    return {
      sku: row.sku,
      asin: row.asin,
      verified: true as const,
      image_urls: urls,
      evidence: assets.map(
        ({ image, uploaded }) =>
          `donor=${image.donor_id};source_sha256=${image.source_sha256};asset_sha256=${image.asset_sha256};dimensions=${image.width}x${image.height};r2_key=${uploaded.key}`,
      ),
      assets: assets.map(({ image, uploaded }) => ({
        donor_id: image.donor_id,
        donor_title: image.donor_title,
        flavor: image.flavor,
        source_url: image.source_url,
        source_sha256: image.source_sha256,
        asset_sha256: image.asset_sha256,
        dimensions: { width: image.width, height: image.height },
        r2_key: uploaded.key,
        r2_url: uploaded.url,
      })),
    };
  });
  if (manifestRows.length !== PRODUCT_GALLERY_TARGET) {
    throw new Error(`Refusing incomplete manifest: ${manifestRows.length}/${PRODUCT_GALLERY_TARGET}.`);
  }
  const now = new Date();
  const manifest = {
    schema_version: PRODUCT_GALLERY_MANIFEST_SCHEMA,
    immutable: true as const,
    created_at: now.toISOString(),
    source_ledger_sha256: inputs.ledgerSha,
    source_ledger: {
      path: ledgerPath,
      sha256: inputs.ledgerSha,
      schema_version: inputs.ledger.schema_version ?? null,
      audit_id: inputs.ledger.audit_id ?? null,
    },
    source_preflight: {
      path: preflightPath,
      sha256: inputs.preflightSha,
      schema_version: inputs.preflight.schema_version,
    },
    reviewed_source_audit: {
      path: auditPath,
      sha256: actualAuditSha,
      confirmation: options.confirm,
    },
    external_mutations: {
      r2_assets_uploaded: [...uploadedBySha.values()].filter((item) => item.uploaded).length,
      r2_assets_already_verified: [...uploadedBySha.values()].filter((item) => !item.uploaded).length,
      amazon_calls: 0,
      database_writes: 0,
    },
    summary: { target: PRODUCT_GALLERY_TARGET, passed: PRODUCT_GALLERY_TARGET, failed: 0 },
    rows: manifestRows,
  };
  const outputDir = path.resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const manifestPath = path.join(
    outputDir,
    `uncrustables-product-gallery-${stamp(now)}-${inputs.ledgerSha.slice(0, 12)}-${actualAuditSha.slice(0, 12)}.json`,
  );
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeExclusive(manifestPath, manifestBytes);
  console.log(`Immutable product-gallery manifest: ${manifestPath}`);
  console.log(`Manifest SHA-256: ${sha256(manifestBytes)}`);
  console.log(JSON.stringify(manifest.summary, null, 2));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.apply) await runApply(options);
  else await runAudit(options);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
