import { createHash } from "node:crypto";

export const UNCRUSTABLES_LIVE_MAIN_EXPECTED_ROWS = 164;

export const DEFAULT_LIVE_MAIN_HOSTS = new Set([
  "m.media-amazon.com",
  "images-na.ssl-images-amazon.com",
]);

export interface LiveMainFetchTarget {
  ordinal: number;
  ledger_row_index: number;
  sku: string;
  asin: string;
  title: string | null;
  main_image_url: string;
  canonical_total_units: number;
  reviewed_total_units: number | null;
  effective_total_units: number;
  total_units_source: "LEDGER_CANONICAL" | "HIGH_REVIEWED_OVERRIDE";
  recipe_components: Array<{
    product_name: string;
    flavor: string | null;
    qty: number;
  }>;
}

export interface SealedLedgerIdentity {
  schema_version: string | null;
  audit_id: string | null;
  marketplace_observed_at: string | null;
  targets: LiveMainFetchTarget[];
}

interface LedgerRowLike {
  sku?: unknown;
  asin?: unknown;
  live?: {
    fetched?: unknown;
    title?: unknown;
    main_image_url?: unknown;
  } | null;
  canonical?: {
    total_units?: unknown;
    components?: unknown;
  } | null;
}

interface LedgerLike {
  immutable?: unknown;
  complete?: unknown;
  schema_version?: unknown;
  audit_id?: unknown;
  marketplace_observed_at?: unknown;
  rows?: unknown;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function assertAllowedLiveMainUrl(
  value: string,
  allowedHosts: ReadonlySet<string> = DEFAULT_LIVE_MAIN_HOSTS,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid live MAIN URL: ${value}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Live MAIN URL must use HTTPS: ${value}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Live MAIN URL must not contain credentials: ${value}`);
  }
  if (parsed.port && parsed.port !== "443") {
    throw new Error(`Live MAIN URL uses a disallowed port: ${value}`);
  }
  if (!allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error(
      `Live MAIN host is not allow-listed: ${parsed.hostname || "<empty>"}`,
    );
  }
  return parsed;
}

export function selectSealedLiveMainTargets(
  input: unknown,
  options: {
    expectedRows?: number;
    allowedHosts?: ReadonlySet<string>;
  } = {},
): SealedLedgerIdentity {
  const expectedRows =
    options.expectedRows ?? UNCRUSTABLES_LIVE_MAIN_EXPECTED_ROWS;
  const allowedHosts = options.allowedHosts ?? DEFAULT_LIVE_MAIN_HOSTS;
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
  if (!Array.isArray(ledger.rows)) {
    throw new Error("Ledger has no rows array");
  }

  const targets: LiveMainFetchTarget[] = [];
  const seenSkus = new Set<string>();
  const seenAsins = new Set<string>();
  for (const [ledgerRowIndex, rawRow] of ledger.rows.entries()) {
    if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) {
      throw new Error(`Ledger row ${ledgerRowIndex} is not an object`);
    }
    const row = rawRow as LedgerRowLike;
    if (row.live?.fetched !== true) continue;
    const sku = stringOrNull(row.sku);
    const asin = stringOrNull(row.asin);
    const mainImageUrl = stringOrNull(row.live.main_image_url);
    if (!sku) throw new Error(`Fetched ledger row ${ledgerRowIndex} has no SKU`);
    if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) {
      throw new Error(`Fetched ledger row ${sku} has an invalid ASIN`);
    }
    if (!mainImageUrl) {
      throw new Error(`Fetched ledger row ${sku}/${asin} has no live MAIN URL`);
    }
    const canonicalTotal = row.canonical?.total_units;
    if (!Number.isInteger(canonicalTotal) || (canonicalTotal as number) < 1) {
      throw new Error(`Fetched ledger row ${sku}/${asin} has no canonical total`);
    }
    if (!Array.isArray(row.canonical?.components) || row.canonical.components.length < 1) {
      throw new Error(`Fetched ledger row ${sku}/${asin} has no canonical recipe`);
    }
    const recipeComponents = row.canonical.components.map((rawComponent, index) => {
      if (!rawComponent || typeof rawComponent !== "object" || Array.isArray(rawComponent)) {
        throw new Error(`Canonical component ${index} for ${sku}/${asin} is invalid`);
      }
      const component = rawComponent as Record<string, unknown>;
      const productName = stringOrNull(component.product_name);
      const flavor = stringOrNull(component.flavor);
      const qty = component.qty;
      if (!productName || !Number.isInteger(qty) || (qty as number) < 1) {
        throw new Error(`Canonical component ${index} for ${sku}/${asin} is incomplete`);
      }
      return { product_name: productName, flavor, qty: qty as number };
    });
    assertAllowedLiveMainUrl(mainImageUrl, allowedHosts);
    if (seenSkus.has(sku)) throw new Error(`Duplicate fetched SKU: ${sku}`);
    if (seenAsins.has(asin)) throw new Error(`Duplicate fetched ASIN: ${asin}`);
    seenSkus.add(sku);
    seenAsins.add(asin);
    targets.push({
      ordinal: targets.length + 1,
      ledger_row_index: ledgerRowIndex,
      sku,
      asin,
      title: stringOrNull(row.live.title),
      main_image_url: mainImageUrl,
      canonical_total_units: canonicalTotal as number,
      reviewed_total_units: null,
      effective_total_units: canonicalTotal as number,
      total_units_source: "LEDGER_CANONICAL",
      recipe_components: recipeComponents,
    });
  }

  if (targets.length !== expectedRows) {
    throw new Error(
      `Expected exactly ${expectedRows} fetched live MAIN rows; found ${targets.length}`,
    );
  }

  return {
    schema_version: stringOrNull(ledger.schema_version),
    audit_id: stringOrNull(ledger.audit_id),
    marketplace_observed_at: stringOrNull(ledger.marketplace_observed_at),
    targets,
  };
}

export interface AppliedReviewedTotalOverride {
  sku: string;
  ledger_canonical_total_units: number;
  reviewed_total_units: number;
  confidence: "HIGH";
  rationale: string | null;
}

/**
 * Apply only explicit HIGH-reviewed customer-count overrides whose manifest is
 * immutable and bound to the exact ledger SHA. A canonical/component count
 * conflict must have such an override or the contact-sheet run fails closed.
 */
export function applyReviewedTotalOverrides(
  identity: SealedLedgerIdentity,
  input: unknown,
  sourceLedgerSha256: string,
): {
  identity: SealedLedgerIdentity;
  applied: AppliedReviewedTotalOverride[];
} {
  if (!/^[a-f0-9]{64}$/.test(sourceLedgerSha256)) {
    throw new Error("sourceLedgerSha256 must be a lowercase SHA-256 digest");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Reviewed override manifest must be a JSON object");
  }
  const manifest = input as Record<string, unknown>;
  if (manifest.immutable !== true) {
    throw new Error("Reviewed override manifest must declare immutable=true");
  }
  if (manifest.source_ledger_sha256 !== sourceLedgerSha256) {
    throw new Error("Reviewed override manifest is not bound to the sealed ledger SHA");
  }
  if (!Array.isArray(manifest.repairs)) {
    throw new Error("Reviewed override manifest has no repairs array");
  }

  const reviewedBySku = new Map<
    string,
    { total: number; rationale: string | null }
  >();
  for (const rawRepair of manifest.repairs) {
    if (!rawRepair || typeof rawRepair !== "object" || Array.isArray(rawRepair)) {
      throw new Error("Reviewed override repair is not an object");
    }
    const repair = rawRepair as Record<string, unknown>;
    const sku = stringOrNull(repair.sku);
    const review =
      repair.review && typeof repair.review === "object" && !Array.isArray(repair.review)
        ? (repair.review as Record<string, unknown>)
        : null;
    const textCount =
      repair.text_count &&
      typeof repair.text_count === "object" &&
      !Array.isArray(repair.text_count)
        ? (repair.text_count as Record<string, unknown>)
        : null;
    if (!sku || review?.confidence !== "HIGH" || !textCount) continue;
    const unitCount = textCount.unit_count;
    const numberOfItems = textCount.number_of_items;
    if (
      !Number.isInteger(unitCount) ||
      (unitCount as number) < 1 ||
      !Number.isInteger(numberOfItems) ||
      (numberOfItems as number) < 1 ||
      unitCount !== numberOfItems
    ) {
      // Some reviewed product-type repairs intentionally express unit_count in
      // ounces in a fallback. Only an exact Count/number_of_items pair is a
      // customer-total override for image classification.
      continue;
    }
    if (reviewedBySku.has(sku)) {
      throw new Error(`Duplicate HIGH reviewed total override for ${sku}`);
    }
    reviewedBySku.set(sku, {
      total: unitCount as number,
      rationale: stringOrNull(review.rationale),
    });
  }

  const applied: AppliedReviewedTotalOverride[] = [];
  const targets = identity.targets.map((target) => {
    const componentTotal = target.recipe_components.reduce(
      (total, component) => total + component.qty,
      0,
    );
    const reviewed = reviewedBySku.get(target.sku);
    if (componentTotal !== target.canonical_total_units && !reviewed) {
      throw new Error(
        `Ledger count conflict for ${target.sku}/${target.asin} ` +
          `(${target.canonical_total_units} canonical vs ${componentTotal} recipe) ` +
          "has no HIGH reviewed customer-total override",
      );
    }
    if (!reviewed) return target;
    if (reviewed.total !== componentTotal) {
      throw new Error(
        `Reviewed total ${reviewed.total} for ${target.sku}/${target.asin} ` +
          `does not equal recipe component total ${componentTotal}`,
      );
    }
    applied.push({
      sku: target.sku,
      ledger_canonical_total_units: target.canonical_total_units,
      reviewed_total_units: reviewed.total,
      confidence: "HIGH",
      rationale: reviewed.rationale,
    });
    return {
      ...target,
      reviewed_total_units: reviewed.total,
      effective_total_units: reviewed.total,
      total_units_source: "HIGH_REVIEWED_OVERRIDE" as const,
    };
  });
  return { identity: { ...identity, targets }, applied };
}

export const RETRYABLE_HTTP_STATUSES = new Set([
  408, 425, 429, 500, 502, 503, 504,
]);

export function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status);
}

export function parseRetryAfterMs(
  value: string | null,
  nowMs: number = Date.now(),
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

export function retryBackoffMs(
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

export function sha256(value: Buffer | string): string {
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

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sealManifestBody(body: unknown): string {
  return sha256(canonicalJson(body));
}

export function verifyManifestSeal(
  manifest: Record<string, unknown>,
  field = "body_sha256",
): boolean {
  const expected = manifest[field];
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) {
    return false;
  }
  const body = { ...manifest };
  delete body[field];
  return sealManifestBody(body) === expected;
}

export function safeFilePart(value: string, maximumLength = 80): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^[_.-]+|[_.-]+$/g, "")
    .slice(0, maximumLength);
  if (!cleaned) throw new Error("File label becomes empty after sanitization");
  return cleaned;
}

export function extensionForSharpFormat(format: string): string {
  const normalized = format.toLowerCase();
  if (normalized === "jpeg") return "jpg";
  if (["png", "webp", "gif", "avif", "tiff", "heif"].includes(normalized)) {
    return normalized === "tiff" ? "tif" : normalized;
  }
  return "img";
}
