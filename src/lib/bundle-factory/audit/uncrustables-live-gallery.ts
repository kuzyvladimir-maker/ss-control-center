import { createHash } from "node:crypto";

export const UNCRUSTABLES_LIVE_GALLERY_EXPECTED_ROWS = 164;

export const UNCRUSTABLES_LIVE_GALLERY_ALLOWED_HOSTS = new Set([
  "m.media-amazon.com",
  "images-na.ssl-images-amazon.com",
]);

export type LiveGallerySlot = "MAIN" | `GALLERY_${number}`;

export interface LiveGalleryRecipeComponent {
  product_name: string;
  flavor: string | null;
  qty: number;
}

export interface LiveGalleryMapping {
  mapping_ordinal: number;
  row_ordinal: number;
  ledger_row_index: number;
  sku: string;
  asin: string;
  title: string | null;
  slot: LiveGallerySlot;
  slot_index: number;
  requested_url: string;
  canonical_total_units: number;
  reviewed_total_units: number | null;
  expected_total_units: number;
  expected_total_source: "CANONICAL" | "HIGH_REVIEWED_OVERRIDE";
  recipe_components: LiveGalleryRecipeComponent[];
}

export interface LiveGalleryRow {
  ordinal: number;
  ledger_row_index: number;
  sku: string;
  asin: string;
  title: string | null;
  canonical_total_units: number;
  reviewed_total_units: number | null;
  expected_total_units: number;
  expected_total_source: "CANONICAL" | "HIGH_REVIEWED_OVERRIDE";
  recipe_components: LiveGalleryRecipeComponent[];
  images: LiveGalleryMapping[];
}

export interface ReviewedTotalOverride {
  sku: string;
  total_units: number;
  confidence: "HIGH";
  rationale: string;
}

export interface SealedLiveGallerySelection {
  schema_version: string | null;
  audit_id: string | null;
  marketplace_observed_at: string | null;
  rows: LiveGalleryRow[];
  mappings: LiveGalleryMapping[];
}

interface LedgerRowLike {
  sku?: unknown;
  asin?: unknown;
  canonical?: {
    total_units?: unknown;
    components?: unknown;
  } | null;
  live?: {
    fetched?: unknown;
    title?: unknown;
    main_image_url?: unknown;
    gallery_image_urls?: unknown;
  } | null;
}

interface LedgerLike {
  schema_version?: unknown;
  audit_id?: unknown;
  marketplace_observed_at?: unknown;
  immutable?: unknown;
  complete?: unknown;
  rows?: unknown;
}

interface ReviewedRepairLike {
  sku?: unknown;
  review?: {
    confidence?: unknown;
    rationale?: unknown;
  } | null;
  text_count?: {
    unit_count?: unknown;
  } | null;
}

interface ReviewedOverridesLike {
  schema_version?: unknown;
  immutable?: unknown;
  source_ledger_sha256?: unknown;
  reviewed_at?: unknown;
  repairs?: unknown;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) > 0
    ? (value as number)
    : null;
}

export function assertAllowedLiveGalleryUrl(
  value: string,
  allowedHosts: ReadonlySet<string> = UNCRUSTABLES_LIVE_GALLERY_ALLOWED_HOSTS,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid live gallery URL: ${value}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Live gallery URL must use HTTPS: ${value}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Live gallery URL must not contain credentials: ${value}`);
  }
  if (parsed.port && parsed.port !== "443") {
    throw new Error(`Live gallery URL uses a disallowed port: ${value}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!allowedHosts.has(hostname)) {
    throw new Error(`Live gallery host is not allow-listed: ${hostname || "<empty>"}`);
  }
  return parsed;
}

/**
 * Read only HIGH-reviewed count corrections from an independently byte-pinned
 * artifact. The caller is responsible for checking the artifact's own file
 * SHA before invoking this function.
 */
export function selectReviewedTotalOverrides(
  input: unknown,
  expectedLedgerSha256: string,
): Map<string, ReviewedTotalOverride> {
  if (!/^[a-f0-9]{64}$/.test(expectedLedgerSha256)) {
    throw new Error("expectedLedgerSha256 must be a lowercase SHA-256 digest");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Reviewed override artifact must be a JSON object");
  }
  const artifact = input as ReviewedOverridesLike;
  if (artifact.immutable !== true) {
    throw new Error("Reviewed override artifact must declare immutable=true");
  }
  if (artifact.source_ledger_sha256 !== expectedLedgerSha256) {
    throw new Error(
      "Reviewed override artifact is not bound to the exact sealed ledger SHA",
    );
  }
  if (!nonEmptyString(artifact.schema_version) || !nonEmptyString(artifact.reviewed_at)) {
    throw new Error("Reviewed override artifact lacks schema_version/reviewed_at");
  }
  if (!Array.isArray(artifact.repairs)) {
    throw new Error("Reviewed override artifact has no repairs array");
  }

  const totals = new Map<string, ReviewedTotalOverride>();
  for (const [index, rawRepair] of artifact.repairs.entries()) {
    if (!rawRepair || typeof rawRepair !== "object" || Array.isArray(rawRepair)) {
      throw new Error(`Reviewed repair ${index} is not an object`);
    }
    const repair = rawRepair as ReviewedRepairLike;
    const total = positiveInteger(repair.text_count?.unit_count);
    if (total == null) continue;
    const sku = nonEmptyString(repair.sku);
    const confidence = repair.review?.confidence;
    const rationale = nonEmptyString(repair.review?.rationale);
    if (!sku) throw new Error(`Reviewed count repair ${index} has no SKU`);
    if (confidence !== "HIGH") {
      throw new Error(`Reviewed count repair ${sku} is not HIGH confidence`);
    }
    if (!rationale) {
      throw new Error(`Reviewed count repair ${sku} has no rationale`);
    }
    if (totals.has(sku)) {
      throw new Error(`Duplicate reviewed count repair for SKU ${sku}`);
    }
    totals.set(sku, {
      sku,
      total_units: total,
      confidence: "HIGH",
      rationale,
    });
  }
  return totals;
}

function parseRecipeComponents(
  value: unknown,
  sku: string,
  asin: string,
): LiveGalleryRecipeComponent[] {
  if (!Array.isArray(value) || value.length < 1) {
    throw new Error(`Fetched ledger row ${sku}/${asin} has no canonical recipe`);
  }
  return value.map((rawComponent, index) => {
    if (
      !rawComponent ||
      typeof rawComponent !== "object" ||
      Array.isArray(rawComponent)
    ) {
      throw new Error(`Canonical component ${index} for ${sku}/${asin} is invalid`);
    }
    const component = rawComponent as Record<string, unknown>;
    const productName = nonEmptyString(component.product_name);
    const flavor = nonEmptyString(component.flavor);
    const qty = positiveInteger(component.qty);
    if (!productName || qty == null) {
      throw new Error(`Canonical component ${index} for ${sku}/${asin} is incomplete`);
    }
    return { product_name: productName, flavor, qty };
  });
}

/**
 * Select every live MAIN and gallery slot from exactly 164 fetched ledger rows.
 * No prior `verified` flag is consulted; only the sealed ledger bytes and the
 * separately SHA-pinned HIGH-reviewed count overrides are accepted as input.
 */
export function selectSealedLiveGallery(
  input: unknown,
  reviewedTotals: ReadonlyMap<string, ReviewedTotalOverride>,
  options: {
    expectedRows?: number;
    allowedHosts?: ReadonlySet<string>;
  } = {},
): SealedLiveGallerySelection {
  const expectedRows =
    options.expectedRows ?? UNCRUSTABLES_LIVE_GALLERY_EXPECTED_ROWS;
  const allowedHosts =
    options.allowedHosts ?? UNCRUSTABLES_LIVE_GALLERY_ALLOWED_HOSTS;
  if (!Number.isInteger(expectedRows) || expectedRows < 1) {
    throw new Error("expectedRows must be a positive integer");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Ledger must be a JSON object");
  }
  const ledger = input as LedgerLike;
  if (ledger.immutable !== true || ledger.complete !== true) {
    throw new Error("Ledger must declare immutable=true and complete=true");
  }
  if (!Array.isArray(ledger.rows)) throw new Error("Ledger has no rows array");

  const rows: LiveGalleryRow[] = [];
  const mappings: LiveGalleryMapping[] = [];
  const seenSkus = new Set<string>();
  const seenAsins = new Set<string>();
  for (const [ledgerRowIndex, rawRow] of ledger.rows.entries()) {
    if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) {
      throw new Error(`Ledger row ${ledgerRowIndex} is not an object`);
    }
    const row = rawRow as LedgerRowLike;
    if (row.live?.fetched !== true) continue;

    const sku = nonEmptyString(row.sku);
    const asin = nonEmptyString(row.asin);
    if (!sku) throw new Error(`Fetched ledger row ${ledgerRowIndex} has no SKU`);
    if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) {
      throw new Error(`Fetched ledger row ${sku} has an invalid ASIN`);
    }
    if (seenSkus.has(sku)) throw new Error(`Duplicate fetched SKU: ${sku}`);
    if (seenAsins.has(asin)) throw new Error(`Duplicate fetched ASIN: ${asin}`);
    seenSkus.add(sku);
    seenAsins.add(asin);

    const canonicalTotal = positiveInteger(row.canonical?.total_units);
    if (canonicalTotal == null) {
      throw new Error(`Fetched ledger row ${sku}/${asin} has no canonical total`);
    }
    const recipeComponents = parseRecipeComponents(
      row.canonical?.components,
      sku,
      asin,
    );
    const componentTotal = recipeComponents.reduce(
      (sum, component) => sum + component.qty,
      0,
    );
    const reviewed = reviewedTotals.get(sku) ?? null;
    if (componentTotal !== canonicalTotal && reviewed == null) {
      throw new Error(
        `${sku}/${asin} canonical total ${canonicalTotal} conflicts with ` +
          `component allocation ${componentTotal}; HIGH-reviewed override required`,
      );
    }
    if (reviewed && reviewed.total_units !== componentTotal) {
      throw new Error(
        `${sku}/${asin} reviewed total ${reviewed.total_units} conflicts with ` +
          `component allocation ${componentTotal}`,
      );
    }
    const expectedTotal = reviewed?.total_units ?? canonicalTotal;
    const expectedSource = reviewed
      ? ("HIGH_REVIEWED_OVERRIDE" as const)
      : ("CANONICAL" as const);

    const mainUrl = nonEmptyString(row.live.main_image_url);
    if (!mainUrl) {
      throw new Error(`Fetched ledger row ${sku}/${asin} has no live MAIN URL`);
    }
    assertAllowedLiveGalleryUrl(mainUrl, allowedHosts);
    if (!Array.isArray(row.live.gallery_image_urls)) {
      throw new Error(`Fetched ledger row ${sku}/${asin} has no gallery array`);
    }
    const galleryUrls = row.live.gallery_image_urls.map((value, index) => {
      const url = nonEmptyString(value);
      if (!url) {
        throw new Error(`Fetched ledger row ${sku}/${asin} gallery ${index + 1} is invalid`);
      }
      assertAllowedLiveGalleryUrl(url, allowedHosts);
      return url;
    });
    if (galleryUrls.length < 1) {
      throw new Error(`Fetched ledger row ${sku}/${asin} has an empty gallery`);
    }

    const rowOrdinal = rows.length + 1;
    const rowMappings: LiveGalleryMapping[] = [mainUrl, ...galleryUrls].map(
      (requestedUrl, imageIndex) => ({
        mapping_ordinal: mappings.length + imageIndex + 1,
        row_ordinal: rowOrdinal,
        ledger_row_index: ledgerRowIndex,
        sku,
        asin,
        title: nonEmptyString(row.live?.title),
        slot: imageIndex === 0 ? "MAIN" : (`GALLERY_${imageIndex}` as const),
        slot_index: imageIndex,
        requested_url: requestedUrl,
        canonical_total_units: canonicalTotal,
        reviewed_total_units: reviewed?.total_units ?? null,
        expected_total_units: expectedTotal,
        expected_total_source: expectedSource,
        recipe_components: recipeComponents,
      }),
    );
    mappings.push(...rowMappings);
    rows.push({
      ordinal: rowOrdinal,
      ledger_row_index: ledgerRowIndex,
      sku,
      asin,
      title: nonEmptyString(row.live.title),
      canonical_total_units: canonicalTotal,
      reviewed_total_units: reviewed?.total_units ?? null,
      expected_total_units: expectedTotal,
      expected_total_source: expectedSource,
      recipe_components: recipeComponents,
      images: rowMappings,
    });
  }

  if (rows.length !== expectedRows) {
    throw new Error(
      `Expected exactly ${expectedRows} fetched live gallery rows; found ${rows.length}`,
    );
  }
  for (const sku of reviewedTotals.keys()) {
    if (!seenSkus.has(sku)) {
      throw new Error(`Reviewed count override targets unknown fetched SKU ${sku}`);
    }
  }

  return {
    schema_version: nonEmptyString(ledger.schema_version),
    audit_id: nonEmptyString(ledger.audit_id),
    marketplace_observed_at: nonEmptyString(ledger.marketplace_observed_at),
    rows,
    mappings,
  };
}

export interface ExactUrlGroup {
  requested_url: string;
  mappings: LiveGalleryMapping[];
}

export function groupLiveGalleryMappingsByExactUrl(
  mappings: readonly LiveGalleryMapping[],
): ExactUrlGroup[] {
  const groups = new Map<string, ExactUrlGroup>();
  for (const mapping of mappings) {
    const existing = groups.get(mapping.requested_url);
    if (existing) existing.mappings.push(mapping);
    else {
      groups.set(mapping.requested_url, {
        requested_url: mapping.requested_url,
        mappings: [mapping],
      });
    }
  }
  return [...groups.values()];
}

export interface ExactHashReference {
  sha256: string;
  url_ordinal: number;
  mapping_ordinals: number[];
}

export interface ExactHashReferenceGroup {
  sha256: string;
  url_ordinals: number[];
  mapping_ordinals: number[];
}

export function groupLiveGalleryReferencesByExactSha256(
  references: readonly ExactHashReference[],
): ExactHashReferenceGroup[] {
  const groups = new Map<string, ExactHashReferenceGroup>();
  const seenUrlOrdinals = new Set<number>();
  for (const reference of references) {
    if (!/^[a-f0-9]{64}$/.test(reference.sha256)) {
      throw new Error(`Invalid exact asset SHA-256: ${reference.sha256}`);
    }
    if (!Number.isInteger(reference.url_ordinal) || reference.url_ordinal < 1) {
      throw new Error("Exact hash reference has an invalid URL ordinal");
    }
    if (seenUrlOrdinals.has(reference.url_ordinal)) {
      throw new Error(`Duplicate exact URL ordinal ${reference.url_ordinal}`);
    }
    seenUrlOrdinals.add(reference.url_ordinal);
    if (
      reference.mapping_ordinals.length < 1 ||
      reference.mapping_ordinals.some(
        (ordinal) => !Number.isInteger(ordinal) || ordinal < 1,
      )
    ) {
      throw new Error(
        `Exact URL ordinal ${reference.url_ordinal} has invalid mapping ordinals`,
      );
    }
    const existing = groups.get(reference.sha256);
    if (existing) {
      existing.url_ordinals.push(reference.url_ordinal);
      existing.mapping_ordinals.push(...reference.mapping_ordinals);
      existing.mapping_ordinals = [...new Set(existing.mapping_ordinals)].sort(
        (left, right) => left - right,
      );
    } else {
      groups.set(reference.sha256, {
        sha256: reference.sha256,
        url_ordinals: [reference.url_ordinal],
        mapping_ordinals: [...new Set(reference.mapping_ordinals)].sort(
          (left, right) => left - right,
        ),
      });
    }
  }
  return [...groups.values()].sort((left, right) =>
    left.sha256.localeCompare(right.sha256),
  );
}

export function uncrustablesLiveGalleryRecipeLabel(
  row: Pick<LiveGalleryRow, "recipe_components">,
): string {
  return row.recipe_components
    .map((component) => {
      const identity = component.flavor ?? component.product_name;
      return `${component.qty}x ${identity}`;
    })
    .join(" + ");
}

export function uncrustablesLiveGalleryTotalLabel(
  row: Pick<
    LiveGalleryRow,
    | "canonical_total_units"
    | "reviewed_total_units"
    | "expected_total_units"
    | "expected_total_source"
  >,
): string {
  if (
    row.expected_total_source === "HIGH_REVIEWED_OVERRIDE" &&
    row.reviewed_total_units != null &&
    row.reviewed_total_units !== row.canonical_total_units
  ) {
    return (
      `expected ${row.expected_total_units} (HIGH reviewed; ` +
      `canonical ${row.canonical_total_units})`
    );
  }
  if (row.expected_total_source === "HIGH_REVIEWED_OVERRIDE") {
    return `expected ${row.expected_total_units} (HIGH reviewed)`;
  }
  return `expected ${row.expected_total_units} (canonical)`;
}

export const UNCRUSTABLES_LIVE_GALLERY_RETRYABLE_STATUSES = new Set([
  408,
  425,
  429,
  500,
  502,
  503,
  504,
]);

export function isUncrustablesLiveGalleryRetryableStatus(status: number): boolean {
  return UNCRUSTABLES_LIVE_GALLERY_RETRYABLE_STATUSES.has(status);
}

export function parseUncrustablesLiveGalleryRetryAfterMs(
  value: string | null,
  nowMs = Date.now(),
  maximumMs = 60_000,
): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(maximumMs, Math.ceil(seconds * 1_000));
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.min(maximumMs, Math.max(0, date - nowMs));
}

export function uncrustablesLiveGalleryRetryBackoffMs(
  failedAttempt: number,
  baseMs: number,
  random: () => number = Math.random,
): number {
  if (!Number.isInteger(failedAttempt) || failedAttempt < 1) {
    throw new Error("failedAttempt must be a positive integer");
  }
  if (!Number.isFinite(baseMs) || baseMs < 0) {
    throw new Error("baseMs must be non-negative");
  }
  const exponential = Math.min(30_000, baseMs * 2 ** (failedAttempt - 1));
  const jitter = Math.floor(Math.max(0, Math.min(1, random())) * baseMs * 0.25);
  return Math.round(exponential + jitter);
}

export function uncrustablesLiveGallerySha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function canonicalUncrustablesLiveGalleryJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sealUncrustablesLiveGalleryManifestBody(body: unknown): string {
  return uncrustablesLiveGallerySha256(
    canonicalUncrustablesLiveGalleryJson(body),
  );
}

export function verifyUncrustablesLiveGalleryManifestSeal(
  manifest: Record<string, unknown>,
  field = "body_sha256",
): boolean {
  const expected = manifest[field];
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) {
    return false;
  }
  const body = { ...manifest };
  delete body[field];
  return sealUncrustablesLiveGalleryManifestBody(body) === expected;
}

export function uncrustablesLiveGalleryFileExtension(format: string): string {
  const normalized = format.toLowerCase();
  if (normalized === "jpeg") return "jpg";
  if (["png", "webp", "gif", "avif", "heif", "tiff"].includes(normalized)) {
    return normalized === "tiff" ? "tif" : normalized;
  }
  throw new Error(`Unsupported decoded live gallery format: ${format}`);
}
