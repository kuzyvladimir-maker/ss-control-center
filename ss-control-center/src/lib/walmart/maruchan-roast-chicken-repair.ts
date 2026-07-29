/**
 * Exact Product Truth -> Walmart repair compiler for FaisalX-1433..1435.
 *
 * Pure module: no filesystem, database, provider, model or marketplace calls.
 * It deliberately preserves the three existing seller SKUs and UPCs while
 * correcting the sellable identity to the exact Roast Chicken variant.
 */

import { createHash } from "node:crypto";

import Ajv from "ajv";

import {
  minimumWalmartNewSkuPriceForTargetMargin,
  type WalmartNewSkuEconomics,
} from "../bundle-factory/walmart-new-sku-economics.ts";
import { stableWalmartJson } from
  "../bundle-factory/walmart-listing-contract.ts";

export const MARUCHAN_ROAST_CHICKEN_PRODUCT_TYPE =
  "Prepared & Packaged Soups" as const;
export const MARUCHAN_ROAST_CHICKEN_SPEC_VERSION =
  "5.0.20260608-18_15_07-api" as const;
export const MARUCHAN_ROAST_CHICKEN_VARIANT_GROUP =
  "SPRCMAR00121QTY" as const;
export const MARUCHAN_ROAST_CHICKEN_FULFILLMENT_CENTER =
  "685099568484274177" as const;
export const MARUCHAN_ROAST_CHICKEN_TEMPLATE_NAME =
  "Maruchan RC SE Free" as const;
export const MARUCHAN_ROAST_CHICKEN_SERVICE_STATES =
  Object.freeze(["AL", "FL", "GA", "SC"] as const);
export const MARUCHAN_ROAST_CHICKEN_NATIONAL_RATE_PER_LB_CENTS =
  1600 as const;

export interface MaruchanRoastChickenRepairRow {
  sku: "FaisalX-1433" | "FaisalX-1434" | "FaisalX-1435";
  item_id: string;
  upc: string;
  incorrect_main_image_url: string;
  carton_count: 2 | 5 | 10;
  cup_count: 24 | 60 | 120;
  goods_cost_cents: number;
  packaging_cost_cents: 150;
  southeast_shipping_label_cents: number;
  shipping_weight_lb: number;
  package_dimensions_in: {
    depth: number;
    width: number;
    height: number;
  };
  is_primary_variant: boolean;
}

export const MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS:
readonly MaruchanRoastChickenRepairRow[] = Object.freeze([
  Object.freeze({
    sku: "FaisalX-1433",
    item_id: "1209518230",
    upc: "745296305452",
    incorrect_main_image_url:
      "https://i5.walmartimages.com/seo/Maruchan-Instant-Lunch-Chicken-Chicken-Cup-12-Carton-Bundle-of-2-Cartons_9531d9a7-b2a2-4e23-b233-634c26861333.9e9e443ede4cf2db4c14aa43be85cf05.png",
    carton_count: 2,
    cup_count: 24,
    goods_cost_cents: 1536,
    packaging_cost_cents: 150,
    southeast_shipping_label_cents: 1219,
    shipping_weight_lb: 6,
    package_dimensions_in: Object.freeze({
      depth: 15.48,
      width: 13.11,
      height: 9.96,
    }),
    is_primary_variant: true,
  }),
  Object.freeze({
    sku: "FaisalX-1434",
    item_id: "517674888",
    upc: "791466157147",
    incorrect_main_image_url:
      "https://i5.walmartimages.com/seo/Maruchan-Instant-Lunch-Chicken-Chicken-Cup-12-Carton-Bundle-of-5_cb86bb0d-0925-4066-a754-abf4fbc54ed0.fa761af833ee64a786f30da973c3ddff.png",
    carton_count: 5,
    cup_count: 60,
    goods_cost_cents: 3840,
    packaging_cost_cents: 150,
    southeast_shipping_label_cents: 2136,
    shipping_weight_lb: 14.5,
    package_dimensions_in: Object.freeze({
      depth: 23.4,
      width: 15.48,
      height: 13.11,
    }),
    is_primary_variant: false,
  }),
  Object.freeze({
    sku: "FaisalX-1435",
    item_id: "1523397932",
    upc: "619419778860",
    incorrect_main_image_url:
      "https://i5.walmartimages.com/seo/Maruchan-Instant-Lunch-Roast-Chicken-Flavor-Ramen-Noodles-Chicken-Cup-12-Carton-Bundle-of-10-Cartons_1864de25-680b-431a-9fd6-95a90c7a7b4d.a03c4a4aa174091ed23348166630ddd7.png",
    carton_count: 10,
    cup_count: 120,
    goods_cost_cents: 7680,
    packaging_cost_cents: 150,
    southeast_shipping_label_cents: 3031,
    shipping_weight_lb: 28,
    package_dimensions_in: Object.freeze({
      depth: 25.22,
      width: 23.4,
      height: 15.48,
    }),
    is_primary_variant: false,
  }),
]);

type JsonRecord = Record<string, unknown>;
const EXACT_ITEM_PROBE_SCHEMA =
  "walmart-exact-item-resolution-probe/v2";
const SHA256 = /^[a-f0-9]{64}$/u;

function fail(message: string): never {
  throw new Error(`Maruchan Roast Chicken repair rejected: ${message}`);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as JsonRecord;
    return `{${Object.keys(row).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("canonical JSON rejects undefined");
  return encoded;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function withoutKey<T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const result: Partial<T> = { ...value };
  delete result[key];
  return result as Omit<T, K>;
}

function exactPublicImageUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be an absolute URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    fail(`${label} must use public HTTPS`);
  }
  return parsed.toString();
}

function description(row: MaruchanRoastChickenRepairRow): string {
  return [
    "Maruchan Instant Lunch Roast Chicken Flavor Ramen Noodle Soup is a",
    `shelf-stable multipack of ${row.cup_count} individual 2.25 oz cups,`,
    `providing ${row.cup_count * 2.25} oz total. Every cup contains the same`,
    "Roast Chicken Flavor variety shown in the verified product image; this",
    "listing does not contain standard Chicken Flavor or mixed flavors. Each",
    "single-serving cup combines ramen noodles, roasted-chicken-flavored broth",
    "and dehydrated vegetables including corn, carrot, onion, garlic and chive.",
    "To prepare one cup, fold the lid back halfway, add boiling water to the",
    "inside fill line, close the lid securely and allow the noodles to stand",
    "for three minutes. Remove the lid, stir thoroughly and enjoy. Do not",
    "microwave the cup. Store unopened cups in a cool, dry place away from",
    "direct sunlight. The cups are convenient for home pantries, offices, dorm",
    "rooms, travel and other situations where boiling water is available. This",
    "product contains wheat, soy and milk ingredients and is manufactured in a",
    "facility that also processes crustacean shellfish and sesame products.",
    "Review the package label for complete ingredient, allergen, nutrition and",
    "preparation information before use.",
  ].join(" ");
}

function keyFeatures(row: MaruchanRoastChickenRepairRow): string[] {
  return [
    `Includes ${row.cup_count} Roast Chicken Flavor cups, 2.25 oz each, ${row.cup_count * 2.25} oz total`,
    "Same Roast Chicken Flavor in every cup; no mixed flavors",
    "Add boiling water and let stand for 3 minutes; do not microwave",
    "Shelf-stable cups store easily in a cool, dry place",
    "Contains wheat, soy and milk; see package for complete allergen details",
  ];
}

export function maruchanRoastChickenTitle(
  row: MaruchanRoastChickenRepairRow,
): string {
  return "Maruchan Instant Lunch Roast Chicken Flavor Ramen Noodle Soup, "
    + `2.25 oz Cups, ${row.cup_count} Count`;
}

/**
 * A rejected Product ID conflict is never replayed. A new repair plan may be
 * staged only after three fresh sealed exact-item probes prove that Walmart's
 * seller and global catalog identities now carry the exact target title and
 * that every previously incorrect MAIN URL changed.
 */
export function validateMaruchanCatalogClearanceReports(
  reports: readonly unknown[],
): void {
  if (reports.length !== MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS.length) {
    fail("catalog clearance requires exactly three sealed probe reports");
  }
  const seen = new Set<string>();
  for (const reportValue of reports) {
    const report = record(reportValue, "catalog clearance report");
    if (report.schema_version !== EXACT_ITEM_PROBE_SCHEMA) {
      fail("catalog clearance report schema is invalid");
    }
    const seal = record(report.seal, "catalog clearance seal");
    const claimed = seal.body_sha256;
    if (typeof claimed !== "string" || !SHA256.test(claimed)) {
      fail("catalog clearance seal SHA-256 is invalid");
    }
    if (sha256(canonicalJson(withoutKey(report, "seal"))) !== claimed) {
      fail("catalog clearance report seal mismatch");
    }
    const input = record(report.input, "catalog clearance input");
    const sku = String(input.sku ?? "");
    const expected = MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS.find((row) =>
      row.sku === sku);
    if (!expected || seen.has(sku) || Number(input.store_index) !== 1) {
      fail("catalog clearance scope is not the exact three-SKU store-1 set");
    }
    seen.add(sku);
    const resolution = record(report.resolution, `${sku} resolution`);
    const seller = record(resolution.seller, `${sku} seller`);
    const candidate = record(
      resolution.catalog_search_candidate,
      `${sku} catalog candidate`,
    );
    const targetTitle = maruchanRoastChickenTitle(expected);
    if (
      seller.sku !== expected.sku
      || seller.upc !== expected.upc
      || seller.title !== targetTitle
      || candidate.item_id !== expected.item_id
      || candidate.title !== targetTitle
      || typeof candidate.main_image_url !== "string"
      || candidate.main_image_url === expected.incorrect_main_image_url
    ) {
      fail(`${sku} catalog conflict has not been cleared`);
    }
  }
  if (seen.size !== MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS.length) {
    fail("catalog clearance reports do not cover all three SKUs");
  }
}

export function maruchanRoastChickenEconomics(
  row: MaruchanRoastChickenRepairRow,
): WalmartNewSkuEconomics {
  return minimumWalmartNewSkuPriceForTargetMargin({
    goodsCostCents: row.goods_cost_cents,
    packagingCostCents: row.packaging_cost_cents,
    shippingLabelCents: row.southeast_shipping_label_cents,
  });
}

export function buildMaruchanRoastChickenItemPayload(input: {
  main_image_urls: Readonly<Record<MaruchanRoastChickenRepairRow["sku"], string>>;
  exact_carton_image_url: string;
}): JsonRecord {
  const cartonImage = exactPublicImageUrl(
    input.exact_carton_image_url,
    "exact carton image URL",
  );
  return {
    MPItemFeedHeader: {
      businessUnit: "WALMART_US",
      locale: "en",
      version: MARUCHAN_ROAST_CHICKEN_SPEC_VERSION,
    },
    MPItem: MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS.map((row) => ({
      Orderable: {
        sku: row.sku,
        productIdentifiers: {
          productIdType: "UPC",
          productId: row.upc,
        },
        ShippingWeight: row.shipping_weight_lb,
        product_package_dimensions_and_weight: {
          product_package_dimensions_depth: row.package_dimensions_in.depth,
          product_package_dimensions_width: row.package_dimensions_in.width,
          product_package_dimensions_height: row.package_dimensions_in.height,
          product_package_weight: row.shipping_weight_lb,
        },
      },
      Visible: {
        [MARUCHAN_ROAST_CHICKEN_PRODUCT_TYPE]: {
          productName:
            maruchanRoastChickenTitle(row),
          shortDescription: description(row),
          keyFeatures: keyFeatures(row),
          mainImageUrl: exactPublicImageUrl(
            input.main_image_urls[row.sku],
            `${row.sku} MAIN image URL`,
          ),
          productSecondaryImageURL: [cartonImage],
          brand: "Maruchan",
          manufacturer: "Maruchan, Inc.",
          productLine: ["Instant Lunch"],
          flavor: "Roast Chicken",
          containerType: ["Cup"],
          food_condition: ["Shelf-Stable"],
          size: "2.25 oz Cups",
          countPerPack: 12,
          multipackQuantity: row.carton_count,
          count: row.cup_count,
          netContent: {
            productNetContentUnit: "Ounce",
            productNetContentMeasure: row.cup_count * 2.25,
          },
          variantGroupId: MARUCHAN_ROAST_CHICKEN_VARIANT_GROUP,
          variantAttributeNames: ["multipackQuantity"],
          isPrimaryVariant: row.is_primary_variant ? "Yes" : "No",
        },
      },
    })),
  };
}

function maintenanceAjv(): Ajv.Ajv {
  const ajv = new Ajv({
    allErrors: true,
    jsonPointers: true,
    multipleOfPrecision: 8,
    unknownFormats: "ignore",
    verbose: true,
  });
  ajv.addKeyword("minEntries", {
    type: "array",
    metaSchema: { type: "integer", minimum: 0 },
    validate: (minimum: number, data: unknown) =>
      Array.isArray(data) && data.length >= minimum,
    errors: false,
  });
  ajv.addKeyword("maxEntries", {
    type: "array",
    metaSchema: { type: "integer", minimum: 0 },
    validate: (maximum: number, data: unknown) =>
      Array.isArray(data) && data.length <= maximum,
    errors: false,
  });
  return ajv;
}

export function validateMaruchanRoastChickenItemPayload(input: {
  payload: JsonRecord;
  get_spec_response: unknown;
}): void {
  const response = record(input.get_spec_response, "Get Spec response");
  let schema: unknown = Object.hasOwn(response, "schema")
    ? response.schema
    : response;
  if (typeof schema === "string") {
    try {
      schema = JSON.parse(schema);
    } catch {
      fail("Get Spec response.schema is not JSON");
    }
  }
  try {
    const validate = maintenanceAjv().compile(record(schema, "Get Spec schema"));
    if (!validate(input.payload)) {
      const errors = (validate.errors ?? []).slice(0, 20).map((entry) =>
        `${entry.dataPath || entry.schemaPath}: ${entry.message ?? "invalid"}`);
      fail(`payload failed exact MP_MAINTENANCE schema: ${errors.join("; ")}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Maruchan")) {
      throw error;
    }
    fail(`Get Spec schema compile failed: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }
}

interface WalmartRegion {
  regionCode?: string;
  regionName?: string;
  states?: Array<{ stateCode?: string; stateName?: string }>;
  subRegions?: Array<{
    subRegionCode?: string;
    subRegionName?: string;
    states?: Array<{ stateCode?: string; stateName?: string }>;
  }>;
}

function keepStates(
  regions: readonly WalmartRegion[],
  permitted: ReadonlySet<string>,
): WalmartRegion[] {
  return regions.map((region) => {
    const states = (region.states ?? []).filter((state) =>
      typeof state.stateCode === "string" && permitted.has(state.stateCode));
    const subRegions = (region.subRegions ?? []).map((subRegion) => ({
      ...subRegion,
      states: (subRegion.states ?? []).filter((state) =>
        typeof state.stateCode === "string" && permitted.has(state.stateCode)),
    })).filter((subRegion) => subRegion.states.length > 0);
    return { ...region, states, subRegions };
  }).filter((region) =>
    (region.states?.length ?? 0) > 0 || (region.subRegions?.length ?? 0) > 0);
}

function stateCodes(regions: readonly WalmartRegion[]): string[] {
  return [...new Set(regions.flatMap((region) => [
    ...(region.states ?? []).map((state) => state.stateCode),
    ...(region.subRegions ?? []).flatMap((subRegion) =>
      (subRegion.states ?? []).map((state) => state.stateCode)),
  ]).filter((value): value is string => typeof value === "string"))].sort();
}

function omitStates(
  regions: readonly WalmartRegion[],
  omitted: ReadonlySet<string>,
): WalmartRegion[] {
  const retained = new Set(
    stateCodes(regions).filter((state) => !omitted.has(state)),
  );
  return keepStates(regions, retained);
}

export function buildMaruchanSoutheastShippingTemplate(
  default_template_details: unknown,
): JsonRecord {
  const root = record(default_template_details, "default shipping template");
  const methods = root.shippingMethods;
  if (!Array.isArray(methods)) fail("default shippingMethods is missing");
  const standard = methods.find((value) =>
    record(value, "shipping method").shipMethod === "STANDARD");
  const standardRow = record(standard, "default STANDARD method");
  const configurations = standardRow.configurations;
  if (!Array.isArray(configurations) || configurations.length < 1) {
    fail("default STANDARD configuration is missing");
  }
  const base = record(configurations[0], "default STANDARD configuration");
  if (!Array.isArray(base.regions)) fail("default region taxonomy is missing");
  const permitted = new Set<string>(MARUCHAN_ROAST_CHICKEN_SERVICE_STATES);
  const regions = keepStates(base.regions as WalmartRegion[], permitted);
  if (
    stableWalmartJson(stateCodes(regions))
    !== stableWalmartJson([...MARUCHAN_ROAST_CHICKEN_SERVICE_STATES].sort())
  ) {
    fail("default taxonomy cannot represent the exact Southeast state set");
  }
  const allStates = stateCodes(base.regions as WalmartRegion[]);
  const nationalPaidRegions = omitStates(
    base.regions as WalmartRegion[],
    permitted,
  );
  const nationalPaidStates = stateCodes(nationalPaidRegions);
  if (
    allStates.length !== 49
    || nationalPaidStates.length !== 45
    || nationalPaidStates.some((state) => permitted.has(state))
    || new Set([
      ...nationalPaidStates,
      ...MARUCHAN_ROAST_CHICKEN_SERVICE_STATES,
    ]).size !== 49
  ) {
    fail("default taxonomy cannot cover the other 44 states plus DC");
  }
  const defaultCharge = record(
    base.perShippingCharge,
    "default perShippingCharge",
  );
  const shippingAndHandling = record(
    defaultCharge.shippingAndHandling,
    "default shippingAndHandling",
  );
  const chargePerItem = record(
    defaultCharge.chargePerItem,
    "default chargePerItem",
  );
  if (
    defaultCharge.unitOfMeasure !== "LB"
    || Number(shippingAndHandling.amount) !== 0
    || shippingAndHandling.currency !== "USD"
    || Number(chargePerItem.amount) !== 0
    || chargePerItem.currency !== "USD"
  ) {
    fail("default template is not an exact free-shipping charge source");
  }
  return {
    name: MARUCHAN_ROAST_CHICKEN_TEMPLATE_NAME,
    type: "CUSTOM",
    rateModelType: "PER_SHIPMENT_PRICING",
    status: "ACTIVE",
    shippingMethods: [{
      shipMethod: "STANDARD",
      status: "ACTIVE",
      configurations: [{
        regions,
        addressTypes: Array.isArray(base.addressTypes)
          ? base.addressTypes
          : ["STREET"],
        transitTime: 4,
        perShippingCharge: {
          unitOfMeasure: "LB",
          shippingAndHandling: { amount: 0, currency: "USD" },
          chargePerItem: { amount: 0, currency: "USD" },
        },
        tieredShippingCharges: [],
      }, {
        regions: nationalPaidRegions,
        addressTypes: Array.isArray(base.addressTypes)
          ? base.addressTypes
          : ["STREET"],
        transitTime: 5,
        perShippingCharge: {
          unitOfMeasure: "LB",
          shippingAndHandling: { amount: 0, currency: "USD" },
          chargePerWeight: {
            amount:
              MARUCHAN_ROAST_CHICKEN_NATIONAL_RATE_PER_LB_CENTS / 100,
            currency: "USD",
          },
        },
        tieredShippingCharges: [],
      }],
    }],
  };
}

export function buildMaruchanShippingAssociationPayload(
  shippingTemplateId: string,
): JsonRecord {
  if (!shippingTemplateId.trim()) fail("shipping template ID is required");
  return {
    ItemFeedHeader: {
      sellingChannel: "precisedelivery",
      locale: "en",
      version: "1.0",
    },
    ItemFeed: MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS.map((row) => ({
      sku: row.sku,
      actionType: "Add",
      shippingTemplateId,
      fulfillmentCenterId: MARUCHAN_ROAST_CHICKEN_FULFILLMENT_CENTER,
    })),
  };
}

export function buildMaruchanPricePayload(
  row: MaruchanRoastChickenRepairRow,
): JsonRecord {
  const economics = maruchanRoastChickenEconomics(row);
  return {
    sku: row.sku,
    pricing: [{
      currentPriceType: "BASE",
      currentPrice: {
        currency: "USD",
        amount: economics.item_price_cents / 100,
      },
    }],
  };
}
