/**
 * Exact, read-only 164-SKU Amazon Product Pricing audit.
 *
 * Safety properties:
 *  - identities come from a verified SHA-sealed 164-row UAPS snapshot;
 *  - the canonical base/floor/effective prices and arms come from a verified
 *    v4 launch-pricing proposal;
 *  - Amazon application calls are only individual getListingOffers GETs;
 *  - there are no Prisma, Listings PATCH/PUT/DELETE, Reports, or R2 calls;
 *  - output uses create-new-only writes and carries a canonical body SHA.
 *
 * Validate inputs without network access:
 *   npx tsx scripts/audit-uncrustables-live-prices-exact.ts
 *
 * Run all 164 GETs:
 *   npx tsx scripts/audit-uncrustables-live-prices-exact.ts --live
 */

import { config } from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  UNCRUSTABLES_EXACT_PRICE_AUDIT_SCOPE,
  UNCRUSTABLES_LIVE_PRICE_AUDIT_SCHEMA,
  auditSha256,
  livePriceAuditBodySha256,
  parseProductPricingObservation,
  productPricingErrorObservation,
  reconcileExactUncrustablesLivePrices,
  type ProductPricingObservation,
  type UncrustablesPriceIdentity,
} from "@/lib/bundle-factory/audit/uncrustables-live-price";
import type { UncrustablesLaunchPricingManifest } from "@/lib/bundle-factory/repair/uncrustables-launch-pricing";
import type { UncrustablesPreChangeSnapshot } from "@/lib/bundle-factory/repair/uncrustables-amazon-rollback";

config({ path: ".env.local" });
config({ path: ".env" });

const DEFAULT_IDENTITY_SNAPSHOT =
  "data/repairs/rollback/offer-canary-qx-v1-preapply-20260718T1511Z/" +
  "UAPS-20260718T151233207Z-46a80e727880-8096129d8101.json";
const DEFAULT_PROPOSAL =
  "data/repairs/launch-pricing/manifests-v4-proposal/" +
  "uncrustables-launch-pricing-20260718T181103000Z-75cebdca9037.json";

interface CliOptions {
  live: boolean;
  identitySnapshot: string;
  proposal: string;
  outputDir: string;
  delayMs: number;
  maxAttempts: number;
}

interface VerifiedFile {
  path: string;
  file_sha256: string;
  expected_sha256: string | null;
  sha256_matches: boolean | null;
  bytes: number;
}

function usage(): string {
  return [
    "Usage: npx tsx scripts/audit-uncrustables-live-prices-exact.ts [options]",
    "",
    "Options:",
    "  --live                    Execute the exact 164 read-only Product Pricing GETs.",
    `  --identity-snapshot=PATH  SHA-sealed 164 UAPS snapshot (default ${DEFAULT_IDENTITY_SNAPSHOT}).`,
    `  --proposal=PATH           SHA-sealed launch-pricing v4 proposal (default ${DEFAULT_PROPOSAL}).`,
    "  --output-dir=PATH         Immutable report directory (default data/audits/live-pricing).",
    "  --delay-ms=N              Minimum GET start interval, >=1000 (default 1100).",
    "  --max-attempts=N           Transient attempts per SKU, 1-5 (default 4).",
    "  --help                     Show this help.",
    "",
    "Without --live, only all local seals and exact 164/v4 coverage are validated.",
  ].join("\n");
}

function positiveInteger(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer; received ${raw}.`);
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    live: false,
    identitySnapshot: DEFAULT_IDENTITY_SNAPSHOT,
    proposal: DEFAULT_PROPOSAL,
    outputDir: "data/audits/live-pricing",
    delayMs: 1_100,
    maxAttempts: 4,
  };
  for (const arg of argv) {
    if (arg === "--live") options.live = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg.startsWith("--identity-snapshot=")) {
      options.identitySnapshot = arg.slice("--identity-snapshot=".length);
    } else if (arg.startsWith("--proposal=")) {
      options.proposal = arg.slice("--proposal=".length);
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length);
    } else if (arg.startsWith("--delay-ms=")) {
      options.delayMs = positiveInteger("--delay-ms", arg.slice("--delay-ms=".length));
    } else if (arg.startsWith("--max-attempts=")) {
      options.maxAttempts = positiveInteger(
        "--max-attempts",
        arg.slice("--max-attempts=".length),
      );
    } else {
      throw new Error(`Unknown argument ${arg}.\n\n${usage()}`);
    }
  }
  if (!options.identitySnapshot || !options.proposal || !options.outputDir) {
    throw new Error("Identity snapshot, proposal, and output directory cannot be empty.");
  }
  // Amazon's documented default getListingOffers rate is 1 request/second.
  if (options.delayMs < 1_000) {
    throw new Error("--delay-ms must be >=1000 for Product Pricing getListingOffers.");
  }
  if (options.maxAttempts > 5) {
    throw new Error("--max-attempts must be <=5.");
  }
  return options;
}

async function verifiedFile(
  file: string,
  expectedSha256: string | null = null,
): Promise<{ bytes: Buffer; evidence: VerifiedFile }> {
  const bytes = await readFile(file);
  const fileSha256 = auditSha256(bytes);
  const matches = expectedSha256 == null ? null : fileSha256 === expectedSha256;
  if (matches === false) {
    throw new Error(
      `SHA-256 mismatch for ${file}: expected ${expectedSha256}, got ${fileSha256}.`,
    );
  }
  return {
    bytes,
    evidence: {
      path: file,
      file_sha256: fileSha256,
      expected_sha256: expectedSha256,
      sha256_matches: matches,
      bytes: bytes.length,
    },
  };
}

function parseJson<T>(bytes: Buffer, label: string): T {
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

function absoluteReference(file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
}

function isoCompact(value: Date): string {
  return value.toISOString().replace(/[-:.]/g, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class GetPacer {
  private lastStartedAt = 0;

  constructor(private readonly intervalMs: number) {}

  async beforeGet(): Promise<void> {
    const waitMs = Math.max(0, this.lastStartedAt + this.intervalMs - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    this.lastStartedAt = Date.now();
  }
}

function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 1_000);
}

function retryableProductPricingError(message: string): boolean {
  return (
    /SP-API (429|500|502|503|504)\b/i.test(message) ||
    /rate limit|throttl|fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(
      message,
    )
  );
}

function productPricingErrorCode(message: string): string {
  const match = message.match(/SP-API (\d{3})\b/i);
  return match ? `SP_API_${match[1]}` : "PRODUCT_PRICING_REQUEST_FAILED";
}

async function immutableWrite(file: string, bytes: Buffer | string): Promise<void> {
  await writeFile(file, bytes, { flag: "wx" });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const identityInput = await verifiedFile(options.identitySnapshot);
  const proposalInput = await verifiedFile(options.proposal);

  const [{ readPreChangeSnapshot }, { verifyUncrustablesLaunchPricingManifest }] =
    await Promise.all([
      import("@/lib/bundle-factory/repair/uncrustables-amazon-rollback"),
      import("@/lib/bundle-factory/repair/uncrustables-launch-pricing"),
    ]);

  // readPreChangeSnapshot verifies its internal canonical body seal and exact 164
  // SKU/ASIN scope. Parse the already-read bytes only to retain exact input SHA.
  const snapshot = await readPreChangeSnapshot(
    options.identitySnapshot,
  ) as UncrustablesPreChangeSnapshot;
  const snapshotFromBytes = parseJson<UncrustablesPreChangeSnapshot>(
    identityInput.bytes,
    "Identity snapshot",
  );
  if (snapshotFromBytes.sha256 !== snapshot.sha256) {
    throw new Error("Identity snapshot changed while it was being verified.");
  }

  const manifest = verifyUncrustablesLaunchPricingManifest(
    parseJson<unknown>(proposalInput.bytes, "Launch-pricing proposal"),
  ) as UncrustablesLaunchPricingManifest;

  const sourceLedger = await verifiedFile(
    absoluteReference(snapshot.source_ledger.path),
    snapshot.source_ledger.sha256,
  );
  const reviewedOverrides = await verifiedFile(
    absoluteReference(snapshot.reviewed_overrides.path),
    snapshot.reviewed_overrides.sha256,
  );
  const proposalSources = await Promise.all(
    Object.values(manifest.source_artifacts).map((source) =>
      verifiedFile(absoluteReference(source.path), source.sha256),
    ),
  );

  const identities: UncrustablesPriceIdentity[] = snapshot.entries.map((entry) => ({
    sku: entry.sku,
    asin: entry.asin,
    store_index: entry.store_index,
  }));
  const placeholderObservations = identities.map((identity) =>
    productPricingErrorObservation({
      identity,
      observedAt: new Date().toISOString(),
      requestAttempts: 0,
      requestErrors: [],
      errorCode: "LOCAL_INPUT_VALIDATION_ONLY",
      errorMessage: "No live GET was requested.",
    }),
  );
  // Fail before network access unless the UAPS identities, v4 rows, TY exclusion,
  // and VN pre-assignment exclusion form one exact 164-member cohort.
  reconcileExactUncrustablesLivePrices({
    identities,
    manifest,
    observations: placeholderObservations,
  });

  const inputSummary = {
    exact_identities: identities.length,
    unique_skus: new Set(identities.map((row) => row.sku)).size,
    unique_asins: new Set(identities.map((row) => row.asin)).size,
    stores: [...new Set(identities.map((row) => row.store_index))].sort(
      (left, right) => left - right,
    ),
    active_proposal_rows: manifest.scope.active_rows,
    assigned_exclusions: manifest.scope.excluded_rows,
    pre_assignment_exclusions: manifest.scope.pre_assignment_excluded_rows,
  };
  console.log(JSON.stringify({ mode: options.live ? "LIVE_GET" : "LOCAL_VALIDATE", ...inputSummary }));
  if (!options.live) return;

  const { MARKETPLACE_ID, spApiGet } = await import("@/lib/amazon-sp-api/client");
  if (
    MARKETPLACE_ID !== snapshot.policy.marketplace_id ||
    MARKETPLACE_ID !== "ATVPDKIKX0DER"
  ) {
    throw new Error(
      `Marketplace mismatch: runtime ${MARKETPLACE_ID}, snapshot ${snapshot.policy.marketplace_id}.`,
    );
  }

  const startedAt = new Date();
  const pacer = new GetPacer(options.delayMs);
  const observations: ProductPricingObservation[] = [];
  let requestCount = 0;
  let retriedSkus = 0;

  for (const [index, identity] of identities.entries()) {
    const errors: string[] = [];
    let observation: ProductPricingObservation | null = null;
    for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
      await pacer.beforeGet();
      requestCount++;
      try {
        const responseBody = await spApiGet(
          `/products/pricing/v0/listings/${encodeURIComponent(identity.sku)}/offers`,
          {
            storeId: `store${identity.store_index}`,
            params: {
              MarketplaceId: MARKETPLACE_ID,
              ItemCondition: "New",
            },
            retries: 1,
          },
        );
        observation = parseProductPricingObservation({
          identity,
          responseBody,
          observedAt: new Date().toISOString(),
          requestAttempts: attempt,
          requestErrors: errors,
        });
        break;
      } catch (error) {
        const message = compactError(error);
        errors.push(message);
        if (attempt < options.maxAttempts && retryableProductPricingError(message)) {
          await sleep(Math.min(8_000, 1_000 * 2 ** (attempt - 1)));
          continue;
        }
        observation = productPricingErrorObservation({
          identity,
          observedAt: new Date().toISOString(),
          requestAttempts: attempt,
          requestErrors: errors,
          errorCode: productPricingErrorCode(message),
          errorMessage: message,
        });
        break;
      }
    }
    if (!observation) {
      throw new Error(`Internal error: ${identity.sku} produced no terminal observation.`);
    }
    if (observation.request_attempts > 1) retriedSkus++;
    observations.push(observation);
    if ((index + 1) % 10 === 0 || index + 1 === identities.length) {
      const errorsSoFar = observations.filter((row) => row.state === "ERROR").length;
      const noOfferSoFar = observations.filter((row) => row.state === "NO_OFFER").length;
      console.error(
        `Product Pricing GET ${index + 1}/${identities.length}; errors=${errorsSoFar}; no_offer=${noOfferSoFar}`,
      );
    }
  }

  const completedAt = new Date();
  const reconciliation = reconcileExactUncrustablesLivePrices({
    identities,
    manifest,
    observations,
  });
  const reportId =
    `ULPA-${isoCompact(startedAt)}-` +
    `${snapshot.sha256.slice(0, 12)}-${manifest.body_sha256.slice(0, 12)}`;
  const reportBody = {
    schema_version: UNCRUSTABLES_LIVE_PRICE_AUDIT_SCHEMA,
    immutable: true as const,
    audit_id: reportId,
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    capture_mode: "LIVE_SP_API_PRODUCT_PRICING_SINGLE_GET" as const,
    external_mutations: false as const,
    safety: {
      amazon_application_http_methods: ["GET"] as const,
      amazon_mutation_calls: 0,
      database_reads: 0,
      database_writes: 0,
      r2_reads: 0,
      r2_writes: 0,
      local_writes: "NEW_IMMUTABLE_REPORT_AND_SHA_SIDECARS_ONLY" as const,
    },
    request_policy: {
      operation: "getListingOffers",
      endpoint: "/products/pricing/v0/listings/{SellerSKU}/offers",
      marketplace_id: MARKETPLACE_ID,
      item_condition: "New",
      documented_default_rate_requests_per_second: 1,
      minimum_start_interval_ms: options.delayMs,
      max_attempts_per_sku: options.maxAttempts,
      transient_backoff: "EXPONENTIAL_1S_TO_8S",
      total_get_attempts: requestCount,
      retried_skus: retriedSkus,
    },
    sources: {
      identity_snapshot: {
        ...identityInput.evidence,
        internal_body_sha256: snapshot.sha256,
        snapshot_id: snapshot.snapshot_id,
        source_ledger: sourceLedger.evidence,
        reviewed_overrides: reviewedOverrides.evidence,
      },
      launch_pricing_proposal: {
        ...proposalInput.evidence,
        internal_body_sha256: manifest.body_sha256,
        schema_version: manifest.schema_version,
        revision_status: manifest.decision.revision_status,
        source_artifacts: proposalSources.map((source) => source.evidence),
      },
    },
    pricing_semantics: {
      effective_live_price:
        "The sole MyOffer ListingPrice.Amount returned by Product Pricing for this seller SKU and New condition.",
      shipping:
        "Recorded separately; canonical proposal prices are compared to item ListingPrice, not landed price.",
      no_competitor_substitution: true,
      coupon_limit:
        "A separate Amazon coupon is not subtracted by this endpoint; during the active window Arm A is expected to retain canonical base ListingPrice.",
      sale_price_behavior:
        "During the active window Arm B is expected to expose the canonical effective Sale Price as ListingPrice.",
    },
    scope: {
      expected: UNCRUSTABLES_EXACT_PRICE_AUDIT_SCOPE,
      outcomes_recorded: reconciliation.rows.length,
      unique_skus: new Set(reconciliation.rows.map((row) => row.sku)).size,
      unique_asins: new Set(reconciliation.rows.map((row) => row.asin)).size,
      active_rows: manifest.scope.active_rows,
      assigned_excluded_rows: manifest.scope.excluded_rows,
      pre_assignment_excluded_rows: manifest.scope.pre_assignment_excluded_rows,
      exact_scope_complete: reconciliation.rows.length === UNCRUSTABLES_EXACT_PRICE_AUDIT_SCOPE,
      marketplace_reads_complete: reconciliation.summary.error === 0,
    },
    launch_window: {
      start_at: manifest.scope.start_at,
      end_at: manifest.scope.end_at,
    },
    summary: reconciliation.summary,
    rows: reconciliation.rows,
  };
  const bodySha256 = livePriceAuditBodySha256(reportBody);
  const report = { ...reportBody, body_sha256: bodySha256 };
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  const reportFileSha256 = auditSha256(reportBytes);

  await mkdir(options.outputDir, { recursive: true });
  const reportFile = path.join(options.outputDir, `${reportId}-${bodySha256.slice(0, 12)}.json`);
  const bodyShaFile = `${reportFile}.body.sha256`;
  const fileShaFile = `${reportFile}.sha256`;
  await immutableWrite(reportFile, reportBytes);
  await immutableWrite(bodyShaFile, `${bodySha256}  BODY ${path.basename(reportFile)}\n`);
  await immutableWrite(fileShaFile, `${reportFileSha256}  ${path.basename(reportFile)}\n`);

  console.log(
    JSON.stringify(
      {
        report: reportFile,
        body_sha256: bodySha256,
        file_sha256: reportFileSha256,
        summary: reconciliation.summary,
      },
      null,
      2,
    ),
  );
  if (reconciliation.summary.error > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
