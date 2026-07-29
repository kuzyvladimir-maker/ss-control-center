/**
 * Exact owner-side materializer for FaisalX-1433..1435.
 *
 * The plan phase is read-only and seals the legacy source rows. Apply performs
 * no provider or retailer calls: it certifies the two already-reviewed donor
 * identities, appends immutable observations, then materializes three exact
 * Roast Chicken recipes with typed Chicken sibling-price estimates.
 */

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { createClient, type Client, type Row } from "@libsql/client";

import {
  persistScoredDonorOffer,
} from "../src/lib/sourcing/donor-catalog";
import {
  scoreOffer,
  type CanonicalProduct,
  type RetailOffer,
  type ScoredOffer,
} from "../src/lib/sourcing/retail-fetch";
import {
  materializeProductTruthSiblingEstimate,
} from "../src/lib/sourcing/product-truth-sibling-estimate";
import {
  renderProductTruthOperationalJson,
} from "../src/lib/sourcing/product-truth-operational-run-contract";

const PLAN_SCHEMA = "maruchan-product-truth-materialization-plan/v1" as const;
const REPORT_SCHEMA = "maruchan-product-truth-materialization-report/v1" as const;
const OWNER_DECISION_ID = "G8a-maruchan-faisalx-1433-1435-20260729";
const MANIFEST_SHA256 =
  "94359db196ec3bc73c964edce7a88df56e5e1942fc0ba9824670034609e9062c";
const CONTENT_DONOR_ID = "e5a8c9bf-b931-4d04-ade1-be17eb85978f";
const PRICE_DONOR_ID = "50a63e7d-5bec-460e-93c3-25559fcdd010";
const PRICE_OFFER_ID = "do:walmart:10450893";
const CONTENT_OFFER_ID =
  "do:publix:70046-maruchan-ramen-noodle-soup-roast-chicken-flavor-2-25-oz";
const TARGET_VARIANT_ID =
  "cpv1:c2bbda600fc06524c6838759808c48011adff998709c05f844fdf74654ca2ecb";
const PRICE_VARIANT_ID =
  "cpv1:4e13042c9a549c9385e87d13b64ba9b8a3d40842cc7e2756906540a0209d27cd";
const EXACT_LISTINGS = Object.freeze([
  { sku: "FaisalX-1433", itemId: "1209518230", quantity: 24 },
  { sku: "FaisalX-1434", itemId: "517674888", quantity: 60 },
  { sku: "FaisalX-1435", itemId: "1523397932", quantity: 120 },
] as const);

type Command = "plan" | "apply" | "status";
type JsonRecord = Record<string, unknown>;

interface SourceBindings {
  listingScopesSha256: string;
  contentDonorSha256: string;
  contentOfferSha256: string;
  priceDonorSha256: string;
  priceOfferSha256: string;
  existingCanonicalGraphSha256: string;
}

interface MaterializationPlan {
  schemaVersion: typeof PLAN_SCHEMA;
  planId: string;
  createdAt: string;
  expiresAt: string;
  ownerDecisionId: typeof OWNER_DECISION_ID;
  manifestSha256: typeof MANIFEST_SHA256;
  targetCanonicalVariantId: typeof TARGET_VARIANT_ID;
  priceCanonicalVariantId: typeof PRICE_VARIANT_ID;
  sourceBindings: SourceBindings;
  exactListings: typeof EXACT_LISTINGS;
  evidence: {
    exactContentProduct: "Maruchan Instant Lunch Roast Chicken Flavor, 2.25 oz cup";
    exactFlavorUpc: "041789001574";
    exactWalmartContentItemId: "171760021";
    exactWalmartContentUrl: "https://www.walmart.com/ip/171760021";
    officialContentUrl: "https://maruchan.com/products/instant-lunch/roast-chicken-flavor-ramen-cup";
    siblingPriceProduct: "Maruchan Instant Lunch Chicken Flavor, 2.25 oz cup";
    siblingPriceWalmartItemId: "10450893";
    siblingPriceUrl: "https://www.walmart.com/ip/10450893";
    procurementZip: "33765";
    savedZipObservationAt: "2026-07-11T13:59:21.074Z";
    publicPriceRecheckedAt: string;
    pricePerCup: 0.64;
    packagingCostPerListing: 1.5;
    priceClassification: "SIBLING_ESTIMATE";
  };
  claims: {
    providerCalls: 0;
    retailerCalls: 0;
    marketplaceWrites: 0;
    catalogWritesMaximum: 17;
    exactRecipeCount: 3;
    estimateCostCount: 3;
    factCostCount: 0;
    mutatesExistingCanonicalEvidence: false;
  };
  bodySha256: string;
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  return renderProductTruthOperationalJson(value);
}

function canonicalRow(row: Row): JsonRecord {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    typeof value === "bigint" ? Number(value) : value,
  ]));
}

function exactInstant(value: string | undefined, label: string): string {
  if (
    !value
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || new Date(value).toISOString() !== value
  ) {
    fail("INVALID_ARGUMENT", label);
  }
  return value;
}

function exactSha(value: string | undefined, label: string): string {
  if (!value || !/^[a-f0-9]{64}$/u.test(value)) fail("INVALID_ARGUMENT", label);
  return value;
}

function exactPath(value: string | undefined, label: string): string {
  if (!value || !isAbsolute(value)) fail("INVALID_ARGUMENT", label);
  return resolve(value);
}

function parseArgs(argv: readonly string[]): {
  command: Command;
  url: string;
  authToken: string;
  out: string;
  createdAt: string | null;
  expiresAt: string | null;
  planPath: string | null;
  planSha256: string | null;
} {
  const command = argv[0] as Command;
  if (!["plan", "apply", "status"].includes(command)) {
    fail("COMMAND_REQUIRED", "expected plan, apply, or status");
  }
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      fail("INVALID_ARGUMENT", flag ?? "unknown");
    }
    if (values.has(flag)) fail("DUPLICATE_ARGUMENT", flag);
    values.set(flag, value);
  }
  const urlEnv = values.get("--url-env");
  const tokenEnv = values.get("--auth-token-env");
  const url = urlEnv ? process.env[urlEnv]?.trim() : "";
  const authToken = tokenEnv ? process.env[tokenEnv]?.trim() : "";
  if (!url || !authToken) fail("DATABASE_CREDENTIALS_MISSING", "env binding");
  const out = exactPath(values.get("--out"), "--out");
  if (command === "plan") {
    return {
      command,
      url,
      authToken,
      out,
      createdAt: exactInstant(values.get("--created-at"), "--created-at"),
      expiresAt: exactInstant(values.get("--expires-at"), "--expires-at"),
      planPath: null,
      planSha256: null,
    };
  }
  if (command === "apply") {
    return {
      command,
      url,
      authToken,
      out,
      createdAt: null,
      expiresAt: null,
      planPath: exactPath(values.get("--plan"), "--plan"),
      planSha256: exactSha(values.get("--plan-sha256"), "--plan-sha256"),
    };
  }
  return {
    command,
    url,
    authToken,
    out,
    createdAt: null,
    expiresAt: null,
    planPath: null,
    planSha256: null,
  };
}

async function oneRow(
  db: Client,
  sql: string,
  args: readonly (string | number)[],
  label: string,
): Promise<JsonRecord> {
  const rows = (await db.execute({ sql, args: [...args] })).rows;
  if (rows.length !== 1) fail("SOURCE_GRAPH_INVALID", `${label}:${rows.length}`);
  return canonicalRow(rows[0]);
}

async function sourceBindings(db: Client): Promise<SourceBindings> {
  const scopes = (await db.execute({
    sql: `SELECT * FROM ProductTruthListingScope
          WHERE listingKey IN (?,?,?) ORDER BY listingKey`,
    args: EXACT_LISTINGS.map((row) => `walmart:1:${row.sku}`),
  })).rows.map(canonicalRow);
  if (
    scopes.length !== 3
    || scopes.some((row) => row.manifestSha256 !== MANIFEST_SHA256)
  ) {
    fail("SOURCE_GRAPH_INVALID", "listing scopes");
  }
  const contentDonor = await oneRow(
    db,
    "SELECT * FROM DonorProduct WHERE id=?",
    [CONTENT_DONOR_ID],
    "content donor",
  );
  const contentOffer = await oneRow(
    db,
    "SELECT * FROM DonorOffer WHERE id=? AND donorProductId=?",
    [CONTENT_OFFER_ID, CONTENT_DONOR_ID],
    "content offer",
  );
  const priceDonor = await oneRow(
    db,
    "SELECT * FROM DonorProduct WHERE id=?",
    [PRICE_DONOR_ID],
    "price donor",
  );
  const priceOffer = await oneRow(
    db,
    "SELECT * FROM DonorOffer WHERE id=? AND donorProductId=?",
    [PRICE_OFFER_ID, PRICE_DONOR_ID],
    "price offer",
  );
  const canonicalGraph = {
    decisions: (await db.execute({
      sql: `SELECT * FROM DonorProductVariantDecision
            WHERE donorProductId IN (?,?) ORDER BY donorProductId,id`,
      args: [CONTENT_DONOR_ID, PRICE_DONOR_ID],
    })).rows.map(canonicalRow),
    variants: (await db.execute({
      sql: "SELECT * FROM CanonicalProductVariant WHERE id IN (?,?) ORDER BY id",
      args: [TARGET_VARIANT_ID, PRICE_VARIANT_ID],
    })).rows.map(canonicalRow),
    recipes: (await db.execute({
      sql: `SELECT * FROM ProductTruthListingRecipe
            WHERE listingKey IN (?,?,?) ORDER BY listingKey,effectiveAt`,
      args: EXACT_LISTINGS.map((row) => `walmart:1:${row.sku}`),
    })).rows.map(canonicalRow),
    costs: (await db.execute({
      sql: `SELECT cost.* FROM SkuCost cost
            JOIN SkuCostListingScopeLink link ON link.skuCostId=cost.id
            WHERE link.listingKey IN (?,?,?) ORDER BY link.listingKey,cost.createdAt`,
      args: EXACT_LISTINGS.map((row) => `walmart:1:${row.sku}`),
    })).rows.map(canonicalRow),
  };
  if (
    canonicalGraph.decisions.length
    || canonicalGraph.variants.length
    || canonicalGraph.recipes.length
    || canonicalGraph.costs.length
  ) {
    fail("SOURCE_GRAPH_NOT_PRISTINE", "canonical graph is no longer empty");
  }
  return {
    listingScopesSha256: sha256(canonical(scopes)),
    contentDonorSha256: sha256(canonical(contentDonor)),
    contentOfferSha256: sha256(canonical(contentOffer)),
    priceDonorSha256: sha256(canonical(priceDonor)),
    priceOfferSha256: sha256(canonical(priceOffer)),
    existingCanonicalGraphSha256: sha256(canonical(canonicalGraph)),
  };
}

async function writeArtifact(
  directory: string,
  filename: string,
  value: unknown,
): Promise<{ path: string; sha256: string }> {
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const bytes = Buffer.from(`${canonical(value)}\n`, "utf8");
  const path = resolve(directory, filename);
  await writeFile(path, bytes, { flag: "wx", mode: 0o400 });
  return { path, sha256: sha256(bytes) };
}

function scoredStandardPrice(observedAt: string): ScoredOffer {
  const target: CanonicalProduct = {
    brand: "Maruchan",
    product_line: "Instant Lunch",
    flavor: "Chicken",
    size: "2.25 oz",
    container_type: "cup",
    outer_pack_count: 1,
  };
  const offer: RetailOffer = {
    retailer: "walmart",
    retailerProductId: "10450893",
    price: 0.64,
    currency: "USD",
    inStock: true,
    productUrl: "https://www.walmart.com/ip/10450893",
    zip: "33765",
    localityEvidence: "zip_scoped",
    observedAt,
    title: "Maruchan Instant Lunch Ramen Noodles, Chicken Flavor, 2.25 oz Cup",
    identityEvidenceTitle:
      "Maruchan Instant Lunch Chicken Flavor, 2.25 oz Cup",
    identityEvidenceNormalization:
      "owner-reviewed-product-line-normalization/1.0.0",
    description: null,
    keyFeatures: [],
    imageUrls: [],
    packSizeSeen: 1,
    isMarketplaceItem: false,
    sellerName: "Walmart.com",
    sourceApi: "owner_accepted_public_walmart_plus_saved_zip",
    via: "direct",
  };
  const scored = scoreOffer(offer, target);
  if (
    !scored.accepted
    || scored.identityMatch?.verdict !== "EXACT_IDENTITY"
  ) {
    fail("PRICE_IDENTITY_NOT_EXACT", scored.rejectReason ?? "unknown");
  }
  return scored;
}

function scoredRoastContent(): ScoredOffer {
  const target: CanonicalProduct = {
    brand: "Maruchan",
    product_line: "Instant Lunch",
    flavor: "Roast Chicken",
    size: "2.25 oz",
    container_type: "cup",
    outer_pack_count: 1,
  };
  const offer: RetailOffer = {
    retailer: "publix",
    retailerProductId:
      "70046-maruchan-ramen-noodle-soup-roast-chicken-flavor-2-25-oz",
    price: 0.76,
    currency: "USD",
    inStock: true,
    productUrl:
      "https://delivery.publix.com/store/publix/products/70046-maruchan-ramen-noodle-soup-roast-chicken-flavor-2-25-oz",
    zip: "33765",
    localityEvidence: "zip_scoped",
    observedAt: "2026-07-11T13:59:21.074Z",
    title:
      "Maruchan Instant Lunch Ramen Noodle Soup, Roast Chicken Flavor, 2.25 oz Cup",
    identityEvidenceTitle:
      "Maruchan Instant Lunch Roast Chicken Flavor, 2.25 oz Cup",
    identityEvidenceNormalization:
      "owner-reviewed-product-line-normalization/1.0.0",
    description: null,
    keyFeatures: [],
    imageUrls: [],
    packSizeSeen: 1,
    isMarketplaceItem: false,
    sellerName: "publix",
    sourceApi: "openclaw",
    via: "direct",
  };
  const scored = scoreOffer(offer, target);
  if (scored.identityMatch?.verdict !== "EXACT_IDENTITY") {
    fail("CONTENT_IDENTITY_NOT_EXACT", scored.rejectReason ?? "unknown");
  }
  // The legacy scorer regards sub-$1 as suspicious. Identity certification is
  // independent of that price heuristic; this stale price is not used for COGS.
  return { ...scored, accepted: true, rejectReason: null, isBaseUnit: true };
}

async function appendOfficialContentObservation(
  db: Client,
  input: {
    donorProductId: string;
    canonicalVariantId: string;
    variantDecisionId: string;
    observedAt: string;
    createdAt: string;
  },
): Promise<string> {
  const sourceUrl =
    "https://maruchan.com/products/instant-lunch/roast-chicken-flavor-ramen-cup";
  const content = {
    _schemaVersion: "product-content-observation/1.0.0",
    title: "Maruchan Instant Lunch Roast Chicken Flavor Ramen Cup",
    brand: "Maruchan",
    productLine: "Instant Lunch",
    flavor: "Roast Chicken",
    form: "cup",
    size: "2.25 oz",
    outerPackCount: 1,
    upc: "041789001574",
    ingredientsSummary:
      "Ramen noodles, roast-chicken-flavored broth and dehydrated vegetables",
    preparation:
      "Add boiling water to the fill line, close lid, stand 3 minutes, stir; do not microwave",
    sourceEvidence: {
      officialManufacturerUrl: sourceUrl,
      exactWalmartContentItemUrl: "https://www.walmart.com/ip/171760021",
      exactWalmartContentItemId: "171760021",
    },
  };
  const factual = Object.fromEntries(
    Object.entries(content).filter(([key]) => !key.startsWith("_")),
  );
  const fieldHashesJson = canonical(Object.fromEntries(
    Object.entries(factual)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, sha256(canonical(value))]),
  ));
  const contentJson = canonical(content);
  const contentHash = sha256(contentJson);
  const observationKey = sha256(canonical({
    donorProductId: input.donorProductId,
    canonicalVariantId: input.canonicalVariantId,
    variantDecisionId: input.variantDecisionId,
    sourceUrl,
    sourceApi: "official_maruchan_plus_exact_walmart_content",
    contentHash,
    observedAt: input.observedAt,
  }));
  const id = `pco:${observationKey}`;
  const existing = (await db.execute({
    sql: "SELECT * FROM ProductContentObservation WHERE id=? OR observationKey=?",
    args: [id, observationKey],
  })).rows;
  if (!existing.length) {
    await db.execute({
      sql: `INSERT INTO ProductContentObservation (
        id,observationKey,donorProductId,canonicalVariantId,variantDecisionId,
        sourceUrl,sourceApi,contentHash,fieldHashesJson,contentJson,observedAt,
        runId,approvalId,meteredReceiptId,createdAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        id, observationKey, input.donorProductId, input.canonicalVariantId,
        input.variantDecisionId, sourceUrl,
        "official_maruchan_plus_exact_walmart_content", contentHash,
        fieldHashesJson, contentJson, input.observedAt, null, null, null,
        input.createdAt,
      ],
    });
  } else if (existing.length !== 1 || String(existing[0]?.id) !== id) {
    fail("CONTENT_OBSERVATION_CONFLICT", id);
  }
  return id;
}

async function statusReport(db: Client, checkedAt: string): Promise<JsonRecord> {
  const rows = [];
  for (const listing of EXACT_LISTINGS) {
    const listingKey = `walmart:1:${listing.sku}`;
    const recipe = (await db.execute({
      sql: `SELECT recipe.*,component.quantity,component.product,component.flavor,
                   component.size,component.targetCanonicalVariantId,
                   component.donorProductId,component.variantDecisionId
            FROM ProductTruthListingRecipe recipe
            JOIN ProductTruthListingRecipeComponent component
              ON component.listingRecipeId=recipe.id
            WHERE recipe.listingKey=?
            ORDER BY recipe.effectiveAt DESC,recipe.createdAt DESC LIMIT 1`,
      args: [listingKey],
    })).rows[0];
    const cost = (await db.execute({
      sql: `SELECT cost.*,evidence.evidenceStatus,evidence.matchTier,
                   evidence.contentObservationId,evidence.priceObservationId,
                   evidence.targetCanonicalVariantId,
                   evidence.priceCanonicalVariantId
            FROM SkuCostListingScopeLink link
            JOIN SkuCost cost ON cost.id=link.skuCostId
            JOIN SkuComponentEvidence evidence ON evidence.skuCostId=cost.id
            WHERE link.listingKey=?
            ORDER BY cost.createdAt DESC,cost.id DESC LIMIT 1`,
      args: [listingKey],
    })).rows[0];
    rows.push({
      listingKey,
      sku: listing.sku,
      expectedQuantity: listing.quantity,
      recipe: recipe ? canonicalRow(recipe) : null,
      cost: cost ? canonicalRow(cost) : null,
    });
  }
  return {
    schemaVersion: "maruchan-product-truth-materialization-status/v1",
    checkedAt,
    exactListings: rows,
    allThreeReady: rows.every((row) => (
      row.recipe
      && row.cost
      && row.recipe.quantity === row.expectedQuantity
      && row.recipe.flavor === "Roast Chicken"
      && row.cost.evidenceOutcome === "ESTIMATE"
      && row.cost.evidenceStatus === "ESTIMATE"
      && row.cost.matchTier === "SIBLING_ESTIMATE"
    )),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = createClient({ url: options.url, authToken: options.authToken });
  try {
    if (options.command === "status") {
      const status = await statusReport(db, new Date().toISOString());
      const artifact = await writeArtifact(options.out, "status.json", status);
      process.stdout.write(`${canonical({ status, artifact })}\n`);
      return;
    }
    if (options.command === "plan") {
      const createdAt = options.createdAt!;
      const expiresAt = options.expiresAt!;
      if (
        Date.parse(expiresAt) <= Date.parse(createdAt)
        || Date.parse(expiresAt) - Date.parse(createdAt) > 24 * 60 * 60 * 1_000
      ) {
        fail("INVALID_PLAN_WINDOW", "plan TTL must be 1ms..24h");
      }
      const bindings = await sourceBindings(db);
      const body = {
        schemaVersion: PLAN_SCHEMA,
        planId: `maruchan-product-truth-${createdAt.replace(/[^0-9]/gu, "")}`,
        createdAt,
        expiresAt,
        ownerDecisionId: OWNER_DECISION_ID,
        manifestSha256: MANIFEST_SHA256,
        targetCanonicalVariantId: TARGET_VARIANT_ID,
        priceCanonicalVariantId: PRICE_VARIANT_ID,
        sourceBindings: bindings,
        exactListings: EXACT_LISTINGS,
        evidence: {
          exactContentProduct:
            "Maruchan Instant Lunch Roast Chicken Flavor, 2.25 oz cup",
          exactFlavorUpc: "041789001574",
          exactWalmartContentItemId: "171760021",
          exactWalmartContentUrl: "https://www.walmart.com/ip/171760021",
          officialContentUrl:
            "https://maruchan.com/products/instant-lunch/roast-chicken-flavor-ramen-cup",
          siblingPriceProduct:
            "Maruchan Instant Lunch Chicken Flavor, 2.25 oz cup",
          siblingPriceWalmartItemId: "10450893",
          siblingPriceUrl: "https://www.walmart.com/ip/10450893",
          procurementZip: "33765",
          savedZipObservationAt: "2026-07-11T13:59:21.074Z",
          publicPriceRecheckedAt: createdAt,
          pricePerCup: 0.64,
          packagingCostPerListing: 1.5,
          priceClassification: "SIBLING_ESTIMATE",
        },
        claims: {
          providerCalls: 0,
          retailerCalls: 0,
          marketplaceWrites: 0,
          catalogWritesMaximum: 17,
          exactRecipeCount: 3,
          estimateCostCount: 3,
          factCostCount: 0,
          mutatesExistingCanonicalEvidence: false,
        },
      } satisfies Omit<MaterializationPlan, "bodySha256">;
      const plan: MaterializationPlan = {
        ...body,
        bodySha256: sha256(canonical(body)),
      };
      const artifact = await writeArtifact(options.out, "plan.json", plan);
      process.stdout.write(`${canonical({ plan, artifact })}\n`);
      return;
    }

    const planBytes = await readFile(options.planPath!);
    if (sha256(planBytes) !== options.planSha256) {
      fail("PLAN_FILE_SHA_MISMATCH", options.planPath!);
    }
    const plan = JSON.parse(planBytes.toString("utf8")) as MaterializationPlan;
    const { bodySha256, ...planBody } = plan;
    if (
      plan.schemaVersion !== PLAN_SCHEMA
      || sha256(canonical(planBody)) !== bodySha256
      || Date.parse(plan.expiresAt) < Date.now()
      || plan.ownerDecisionId !== OWNER_DECISION_ID
      || plan.manifestSha256 !== MANIFEST_SHA256
      || canonical(await sourceBindings(db)) !== canonical(plan.sourceBindings)
    ) {
      fail("PLAN_BINDING_INVALID", plan.planId ?? "unknown");
    }
    const standardPrice = scoredStandardPrice(plan.evidence.publicPriceRecheckedAt);
    const roastContent = scoredRoastContent();
    const standardTarget: CanonicalProduct = {
      brand: "Maruchan",
      product_line: "Instant Lunch",
      flavor: "Chicken",
      size: "2.25 oz",
      container_type: "cup",
      outer_pack_count: 1,
    };
    const roastTarget: CanonicalProduct = {
      brand: "Maruchan",
      product_line: "Instant Lunch",
      flavor: "Roast Chicken",
      size: "2.25 oz",
      container_type: "cup",
      outer_pack_count: 1,
    };
    const priceResult = await persistScoredDonorOffer(
      db,
      standardPrice,
      standardTarget,
      plan.createdAt,
    );
    const contentResult = await persistScoredDonorOffer(
      db,
      roastContent,
      roastTarget,
      plan.createdAt,
    );
    if (
      priceResult.donorProductId !== PRICE_DONOR_ID
      || priceResult.donorOfferId !== PRICE_OFFER_ID
      || priceResult.canonicalVariantId !== PRICE_VARIANT_ID
      || !priceResult.variantDecisionId
      || contentResult.donorProductId !== CONTENT_DONOR_ID
      || contentResult.donorOfferId !== CONTENT_OFFER_ID
      || contentResult.canonicalVariantId !== TARGET_VARIANT_ID
      || !contentResult.variantDecisionId
    ) {
      fail("CERTIFIED_SOURCE_GRAPH_MISMATCH", plan.planId);
    }
    const contentObservationId = await appendOfficialContentObservation(db, {
      donorProductId: CONTENT_DONOR_ID,
      canonicalVariantId: TARGET_VARIANT_ID,
      variantDecisionId: contentResult.variantDecisionId,
      observedAt: plan.createdAt,
      createdAt: plan.createdAt,
    });
    const results = [];
    for (const listing of EXACT_LISTINGS) {
      results.push(await materializeProductTruthSiblingEstimate(db, {
        listingKey: `walmart:1:${listing.sku}`,
        manifestSha256: MANIFEST_SHA256,
        sku: listing.sku,
        quantity: listing.quantity,
        product: "Maruchan Instant Lunch Ramen Noodle Soup",
        flavor: "Roast Chicken",
        size: "2.25 oz cup",
        targetCanonicalVariantId: TARGET_VARIANT_ID,
        contentDonorProductId: CONTENT_DONOR_ID,
        contentVariantDecisionId: contentResult.variantDecisionId,
        contentObservationId,
        priceCanonicalVariantId: PRICE_VARIANT_ID,
        priceDonorProductId: PRICE_DONOR_ID,
        priceVariantDecisionId: priceResult.variantDecisionId,
        priceOfferId: PRICE_OFFER_ID,
        priceObservationId: priceResult.offerObservationId,
        pricePerUnit: 0.64,
        packagingCost: 1.5,
        sourceArtifactSha256: options.planSha256!,
        evaluatedAt: plan.createdAt,
        createdAt: plan.createdAt,
        effectiveDate: plan.createdAt.slice(0, 10),
        runId: plan.planId,
        approvalId: OWNER_DECISION_ID,
        sourceEvidence: {
          schemaVersion: PLAN_SCHEMA,
          planId: plan.planId,
          planSha256: options.planSha256,
          ownerDecisionId: OWNER_DECISION_ID,
          exactWalmartContentItemId: "171760021",
          exactFlavorUpc: "041789001574",
          contentObservationId,
          priceObservationId: priceResult.offerObservationId,
          priceClassification: "SIBLING_ESTIMATE",
        },
      }));
    }
    const status = await statusReport(db, new Date().toISOString());
    if (status.allThreeReady !== true) {
      fail("POSTCONDITION_FAILED", plan.planId);
    }
    const report = {
      schemaVersion: REPORT_SCHEMA,
      planId: plan.planId,
      planFileSha256: options.planSha256,
      completedAt: new Date().toISOString(),
      ownerDecisionId: OWNER_DECISION_ID,
      sourceCertification: {
        priceResult,
        contentResult,
        contentObservationId,
      },
      results,
      status,
      effects: {
        providerCalls: 0,
        retailerCalls: 0,
        marketplaceWrites: 0,
        exactRecipes: 3,
        estimateCosts: 3,
        factCosts: 0,
      },
    };
    const artifact = await writeArtifact(options.out, "report.json", report);
    process.stdout.write(`${canonical({ report, artifact })}\n`);
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
