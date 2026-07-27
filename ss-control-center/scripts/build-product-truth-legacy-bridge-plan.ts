import { createClient, type Client } from "@libsql/client";
import {
  mkdir,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION,
  PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
  compileProductTruthLegacyBridgePlan,
  productTruthLegacyBridgeBytesSha256,
  renderProductTruthLegacyBridgePlan,
  renderProductTruthLegacyBridgeSnapshot,
  type ProductTruthLegacyBridgeComponentRow,
  type ProductTruthLegacyBridgeDonorRow,
  type ProductTruthLegacyBridgeListingRow,
  type ProductTruthLegacyBridgeOfferRow,
  type ProductTruthLegacyBridgeSnapshot,
} from "../src/lib/sourcing/product-truth-legacy-bridge";
import {
  PHASE1_SCOPE_MANIFEST_VERSION,
  renderPhase1ScopeManifestJson,
  validatePhase1ScopeManifestV3Policy,
  type Phase1ScopeManifest,
} from "../src/lib/sourcing/phase1-scope-manifest";
import {
  resolveProductTruthDatabaseTarget,
} from "../src/lib/sourcing/product-truth-database-target";
import { renderProductTruthOperationalJson } from "../src/lib/sourcing/product-truth-operational-run-contract";

type CliOptions = {
  url: string;
  authTokenEnv: string | null;
  allowRemote: boolean;
  manifestPath: string;
  capturedAt: string;
  outDir: string;
};

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function usage(): string {
  return [
    "Usage:",
    "  node --import tsx scripts/build-product-truth-legacy-bridge-plan.ts",
    "    (--url URL | --url-env ENV_NAME)",
    "    --manifest ABS_PATH --captured-at ISO --out ABS_NEW_DIR",
    "    [--allow-remote --auth-token-env ENV_NAME]",
    "",
    "Safety: read-only SQL, zero provider/retailer calls, zero database writes.",
  ].join("\n");
}

function parseOptions(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  let allowRemote = false;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--allow-remote") {
      if (allowRemote) fail("CLI_ARGUMENT_DUPLICATE", item);
      allowRemote = true;
      continue;
    }
    if (!["--url", "--url-env", "--auth-token-env", "--manifest", "--captured-at", "--out"].includes(item)) {
      fail("CLI_ARGUMENT_UNKNOWN", item);
    }
    if (values.has(item)) fail("CLI_ARGUMENT_DUPLICATE", item);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail("CLI_ARGUMENT_VALUE_REQUIRED", item);
    values.set(item, value);
    index += 1;
  }
  const required = (flag: string): string => {
    const value = values.get(flag)?.trim();
    if (!value) fail("CLI_ARGUMENT_REQUIRED", flag);
    return value;
  };
  const capturedAt = required("--captured-at");
  if (!Number.isFinite(Date.parse(capturedAt))) fail("CAPTURED_AT_INVALID", capturedAt);
  const manifestPath = required("--manifest");
  const outDir = required("--out");
  if (!isAbsolute(manifestPath) || !isAbsolute(outDir)) {
    fail("ABSOLUTE_PATH_REQUIRED", "--manifest and --out must be absolute paths");
  }
  const literalUrl = values.get("--url")?.trim() || null;
  const urlEnv = values.get("--url-env")?.trim() || null;
  if ((literalUrl ? 1 : 0) + (urlEnv ? 1 : 0) !== 1) {
    fail("DATABASE_URL_SOURCE_INVALID", "provide exactly one of --url or --url-env");
  }
  const url = literalUrl ?? process.env[urlEnv!]?.trim();
  if (!url) fail("DATABASE_URL_ENV_EMPTY", urlEnv!);
  return {
    url,
    authTokenEnv: values.get("--auth-token-env")?.trim() || null,
    allowRemote,
    manifestPath,
    capturedAt: new Date(capturedAt).toISOString(),
    outDir,
  };
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) fail("DATABASE_ROW_INVALID", `${label} must be text`);
  return value;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isFinite(result)) fail("DATABASE_ROW_INVALID", `${label} must be finite`);
  return result;
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

async function loadManifest(path: string): Promise<{
  manifest: Phase1ScopeManifest;
  json: string;
  sha256: string;
}> {
  const resolved = await realpath(path);
  const json = await readFile(resolved, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    fail("MANIFEST_JSON_INVALID", resolved);
  }
  const manifest = parsed as Phase1ScopeManifest;
  if (manifest.schemaVersion !== PHASE1_SCOPE_MANIFEST_VERSION) {
    fail("MANIFEST_VERSION_INVALID", String(manifest.schemaVersion));
  }
  const errors = validatePhase1ScopeManifestV3Policy(manifest);
  if (errors.length) fail("MANIFEST_POLICY_INVALID", errors.join("; "));
  if (!manifest.authoritative || manifest.blockers.length || !manifest.listings.length) {
    fail("MANIFEST_NOT_AUTHORITATIVE", "manifest must be authoritative with zero blockers");
  }
  if (renderPhase1ScopeManifestJson(manifest) !== json) {
    fail("MANIFEST_NOT_CANONICAL", "manifest bytes differ from canonical rendering");
  }
  return {
    manifest,
    json,
    sha256: productTruthLegacyBridgeBytesSha256(json),
  };
}

async function readListings(
  db: Client,
  manifest: Phase1ScopeManifest,
  manifestSha256: string,
): Promise<ProductTruthLegacyBridgeListingRow[]> {
  const result = await db.execute({
    sql: `SELECT
            scope.listingKey, scope.channel, scope.storeIndex, scope.sku,
            scope.manifestSha256,
            quality.gmv30d AS priorityGmv30d,
            quality.orders30d AS priorityOrders30d,
            quality.units30d AS priorityUnits30d,
            quality.scoredAt AS priorityObservedAt,
            shipping.upc AS listingUpc, shipping.upcSource AS listingUpcSource,
            shipping.productIdentity, shipping.updatedAt AS productIdentityUpdatedAt
          FROM ProductTruthListingScope scope
          LEFT JOIN SkuShippingData shipping ON shipping.sku=scope.sku
          LEFT JOIN WalmartListingQualityItem quality
            ON scope.channel='walmart'
           AND quality.storeIndex=scope.storeIndex
           AND quality.sku=scope.sku
          WHERE scope.manifestSha256=?
          ORDER BY scope.listingKey`,
    args: [manifestSha256],
  });
  const rows = result.rows.map((row): ProductTruthLegacyBridgeListingRow => ({
    listingKey: text(row.listingKey, "listingKey"),
    channel: text(row.channel, "channel") as "amazon" | "walmart",
    storeIndex: numberValue(row.storeIndex, "storeIndex"),
    sku: text(row.sku, "sku"),
    listingUpc: nullableText(row.listingUpc),
    listingUpcSource: nullableText(row.listingUpcSource),
    priorityGmv30d: nullableNumber(row.priorityGmv30d),
    priorityOrders30d: nullableNumber(row.priorityOrders30d),
    priorityUnits30d: nullableNumber(row.priorityUnits30d),
    priorityObservedAt: nullableText(row.priorityObservedAt),
    productIdentityJson: nullableText(row.productIdentity),
    productIdentityUpdatedAt: nullableText(row.productIdentityUpdatedAt),
  }));
  const expected = new Map(manifest.listings.map((row) => [row.listingKey, row]));
  if (rows.length !== expected.size) {
    fail("LISTING_SCOPE_COUNT_MISMATCH", `database=${rows.length} manifest=${manifest.listings.length}`);
  }
  for (const actual of rows) {
    const wanted = expected.get(actual.listingKey);
    if (
      !wanted
      || actual.channel !== wanted.channel
      || actual.storeIndex !== wanted.storeIndex
      || actual.sku !== wanted.sku
    ) {
      fail("LISTING_SCOPE_IDENTITY_MISMATCH", actual.listingKey);
    }
  }
  return rows.sort((left, right) => left.listingKey.localeCompare(right.listingKey));
}

async function readComponents(
  db: Client,
  skus: ReadonlySet<string>,
): Promise<ProductTruthLegacyBridgeComponentRow[]> {
  const result = await db.execute(`SELECT
    id, sku, idx, product, flavor, size, qty, costMethod, retailer, matchedTitle,
    perUnitCost, lineCost, donorProductId, contentDonorProductId,
    priceEvidenceDonorProductId, priceEvidenceOfferId
    FROM SkuComponent ORDER BY sku, idx, id`);
  return result.rows
    .filter((row) => skus.has(text(row.sku, "SkuComponent.sku")))
    .map((row): ProductTruthLegacyBridgeComponentRow => ({
      id: text(row.id, "SkuComponent.id"),
      sku: text(row.sku, "SkuComponent.sku"),
      idx: numberValue(row.idx, "SkuComponent.idx"),
      product: nullableText(row.product),
      flavor: nullableText(row.flavor),
      size: nullableText(row.size),
      qty: numberValue(row.qty, "SkuComponent.qty"),
      costMethod: nullableText(row.costMethod),
      retailer: nullableText(row.retailer),
      matchedTitle: nullableText(row.matchedTitle),
      perUnitCost: nullableNumber(row.perUnitCost),
      lineCost: nullableNumber(row.lineCost),
      donorProductId: nullableText(row.donorProductId),
      contentDonorProductId: nullableText(row.contentDonorProductId),
      priceEvidenceDonorProductId: nullableText(row.priceEvidenceDonorProductId),
      priceEvidenceOfferId: nullableText(row.priceEvidenceOfferId),
    }));
}

async function readDonors(db: Client): Promise<ProductTruthLegacyBridgeDonorRow[]> {
  const result = await db.execute(`SELECT
    id, brand, productLine, flavor, containerType, size, category, upc, gtin,
    title, description, bullets, attributes, nutritionFacts, ingredients,
    mainImageUrl, imageUrls, identityKey, identityStatus, createdAt, updatedAt
    FROM DonorProduct ORDER BY id`);
  return result.rows
    .map((row): ProductTruthLegacyBridgeDonorRow => ({
      id: text(row.id, "DonorProduct.id"),
      brand: nullableText(row.brand),
      productLine: nullableText(row.productLine),
      flavor: nullableText(row.flavor),
      containerType: nullableText(row.containerType),
      size: nullableText(row.size),
      category: nullableText(row.category),
      upc: nullableText(row.upc),
      gtin: nullableText(row.gtin),
      title: nullableText(row.title),
      description: nullableText(row.description),
      bullets: nullableText(row.bullets),
      attributes: nullableText(row.attributes),
      nutritionFacts: nullableText(row.nutritionFacts),
      ingredients: nullableText(row.ingredients),
      mainImageUrl: nullableText(row.mainImageUrl),
      imageUrls: nullableText(row.imageUrls),
      identityKey: text(row.identityKey, "DonorProduct.identityKey"),
      identityStatus: text(row.identityStatus, "DonorProduct.identityStatus"),
      createdAt: text(row.createdAt, "DonorProduct.createdAt"),
      updatedAt: text(row.updatedAt, "DonorProduct.updatedAt"),
    }));
}

async function readOffers(db: Client): Promise<ProductTruthLegacyBridgeOfferRow[]> {
  const result = await db.execute(`SELECT
    id, donorProductId, retailer, retailerProductId, via, price, packSizeSeen,
    pricePerUnit, currency, zip, localityEvidence, inStock, productUrl,
    isFirstParty, sourceApi, fetchedAt
    FROM DonorOffer ORDER BY donorProductId, retailer, id`);
  return result.rows
    .map((row): ProductTruthLegacyBridgeOfferRow => ({
      id: text(row.id, "DonorOffer.id"),
      donorProductId: text(row.donorProductId, "DonorOffer.donorProductId"),
      retailer: text(row.retailer, "DonorOffer.retailer"),
      retailerProductId: text(row.retailerProductId, "DonorOffer.retailerProductId"),
      via: text(row.via, "DonorOffer.via"),
      price: nullableNumber(row.price),
      packSizeSeen: nullableNumber(row.packSizeSeen),
      pricePerUnit: nullableNumber(row.pricePerUnit),
      currency: text(row.currency, "DonorOffer.currency"),
      zip: nullableText(row.zip),
      localityEvidence: nullableText(row.localityEvidence),
      inStock: row.inStock == null ? null : booleanValue(row.inStock),
      productUrl: nullableText(row.productUrl),
      isFirstParty: booleanValue(row.isFirstParty),
      sourceApi: nullableText(row.sourceApi),
      fetchedAt: nullableText(row.fetchedAt),
    }));
}

async function buildSnapshot(
  db: Client,
  input: {
    capturedAt: string;
    targetFingerprint: string;
    manifest: Phase1ScopeManifest;
    manifestSha256: string;
  },
): Promise<ProductTruthLegacyBridgeSnapshot> {
  const listings = await readListings(db, input.manifest, input.manifestSha256);
  const skuSet = new Set(listings.map((row) => row.sku));
  const components = await readComponents(db, skuSet);
  const [donors, offers] = await Promise.all([
    readDonors(db),
    readOffers(db),
  ]);
  return {
    schemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_SNAPSHOT_VERSION,
    capturedAt: input.capturedAt,
    targetFingerprint: input.targetFingerprint,
    manifest: {
      schemaVersion: input.manifest.schemaVersion,
      sha256: input.manifestSha256,
      asOf: input.manifest.asOf,
      listingCount: input.manifest.listings.length,
    },
    listings,
    components,
    donors,
    offers,
  };
}

async function writeNewFile(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

async function run(options: CliOptions): Promise<void> {
  const target = resolveProductTruthDatabaseTarget(options.url, process.cwd());
  if (target.kind === "remote" && !options.allowRemote) {
    fail("REMOTE_DATABASE_REQUIRES_EXPLICIT_FLAG", "pass --allow-remote");
  }
  if (target.kind === "local" && options.authTokenEnv) {
    fail("LOCAL_DATABASE_AUTH_FORBIDDEN", "--auth-token-env is only valid for remote targets");
  }
  const authToken = options.authTokenEnv ? process.env[options.authTokenEnv]?.trim() : undefined;
  if (target.kind === "remote" && (!options.authTokenEnv || !authToken)) {
    fail("REMOTE_DATABASE_AUTH_REQUIRED", "--auth-token-env must name a populated environment variable");
  }
  const manifest = await loadManifest(options.manifestPath);
  const db = createClient({ url: target.clientUrl, ...(authToken ? { authToken } : {}) });
  try {
    const snapshot = await buildSnapshot(db, {
      capturedAt: options.capturedAt,
      targetFingerprint: target.fingerprint,
      manifest: manifest.manifest,
      manifestSha256: manifest.sha256,
    });
    const snapshotJson = renderProductTruthLegacyBridgeSnapshot(snapshot);
    const snapshotSha256 = productTruthLegacyBridgeBytesSha256(snapshotJson);
    const plan = compileProductTruthLegacyBridgePlan({
      snapshot,
      snapshotJson,
      snapshotSha256,
      generatedAt: options.capturedAt,
    });
    const planJson = renderProductTruthLegacyBridgePlan(plan);
    const planSha256 = productTruthLegacyBridgeBytesSha256(planJson);
    const summary = {
      schemaVersion: "product-truth-legacy-bridge-artifact-index/1.0.0",
      generatedAt: options.capturedAt,
      target: {
        kind: target.kind,
        displayUrl: target.displayUrl,
        fingerprint: target.fingerprint,
      },
      manifestSha256: manifest.sha256,
      bridgePlanSchemaVersion: PRODUCT_TRUTH_LEGACY_BRIDGE_PLAN_VERSION,
      safety: plan.safety,
      counts: plan.counts,
      artifacts: [
        { role: "source_snapshot", file: "source-snapshot.json", sha256: snapshotSha256 },
        { role: "bridge_plan", file: "bridge-plan.json", sha256: planSha256 },
      ],
    };
    const summaryJson = renderProductTruthOperationalJson(summary);
    const summarySha256 = productTruthLegacyBridgeBytesSha256(summaryJson);

    await mkdir(dirname(options.outDir), { recursive: true, mode: 0o700 });
    await mkdir(options.outDir, { recursive: false, mode: 0o700 });
    await Promise.all([
      writeNewFile(resolve(options.outDir, "source-snapshot.json"), snapshotJson),
      writeNewFile(resolve(options.outDir, "source-snapshot.sha256"), `${snapshotSha256}\n`),
      writeNewFile(resolve(options.outDir, "bridge-plan.json"), planJson),
      writeNewFile(resolve(options.outDir, "bridge-plan.sha256"), `${planSha256}\n`),
      writeNewFile(resolve(options.outDir, "artifact-index.json"), summaryJson),
      writeNewFile(resolve(options.outDir, "artifact-index.sha256"), `${summarySha256}\n`),
    ]);
    process.stdout.write(`${summaryJson}`);
  } finally {
    db.close();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  await run(parseOptions(argv));
}

const invoked = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
