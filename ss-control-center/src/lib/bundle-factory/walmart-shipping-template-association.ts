import {
  sha256WalmartJson,
  stableWalmartJson,
} from "./walmart-listing-contract";

export const WALMART_SKU_TEMPLATE_MAP_FEED_TYPE =
  "SKU_TEMPLATE_MAP" as const;
export const WALMART_SKU_TEMPLATE_MAP_VERSION = "1.0" as const;
/**
 * UNRESOLVED, and the whole feed is known broken.
 *
 * Walmart has refused EVERY SKU_TEMPLATE_MAP feed this platform ever sent — all
 * eighteen, back to the first listing — with the same
 * `ERR_INT_DATA_01010092 … NullPointerException` and zero items received. The
 * publish path believes it attaches the shipping template and never once has.
 *
 * Probed live 2026-08-09: "marketplace", a missing header, and version 1.1 all
 * fail identically. "marketplace" briefly reports RECEIVED before ending in the
 * same ERROR, so intermediate status proves nothing here.
 *
 * Why it matters: a listing with no template association offers no delivery
 * option, so the page publishes and every purchase button reads "Not
 * available" — it earns nothing and nothing complains. Five listings are in
 * that state right now; see scripts/walmart-audit-shipping-associations.ts.
 *
 * The value below is left as it was until Walmart's own Get Spec for this feed
 * type can be read (it was rate-limited when this was found).
 */
export const WALMART_SKU_TEMPLATE_MAP_SELLING_CHANNEL =
  "precisedelivery" as const;
export const WALMART_SHIPPING_ASSOCIATION_PROPAGATION_MAX_MS =
  4 * 60 * 60 * 1_000;

export interface WalmartSkuTemplateMapPayload {
  ItemFeedHeader: {
    sellingChannel:
      typeof WALMART_SKU_TEMPLATE_MAP_SELLING_CHANNEL;
    locale: "en";
    version: typeof WALMART_SKU_TEMPLATE_MAP_VERSION;
  };
  ItemFeed: [{
    sku: string;
    actionType: "Add";
    shippingTemplateId: string;
    fulfillmentCenterId: string;
  }];
}

export interface WalmartSkuTemplateMapContract {
  payload: WalmartSkuTemplateMapPayload;
  payload_sha256: string;
  params: {
    feedType: typeof WALMART_SKU_TEMPLATE_MAP_FEED_TYPE;
  };
  file: {
    filename: string;
    contentType: "application/json";
    content: string;
  };
}

export interface WalmartShippingAssociationExpectation {
  sku: string;
  shipping_template_id: string;
  fulfillment_center_id: string;
}

export interface WalmartShippingAssociationMatch {
  sku: string;
  shipping_template_id: string;
  shipping_template_name: string;
  shipping_template_type: string;
  fulfillment_center_id: string;
  fulfillment_center_name: string;
}

export class WalmartShippingTemplateAssociationContractError
  extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalmartShippingTemplateAssociationContractError";
  }
}

function exactText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /TODO|PLACEHOLDER/i.test(value)
  ) {
    throw new WalmartShippingTemplateAssociationContractError(
      `${label} is required`,
    );
  }
  return value.trim();
}

function safeFilenameSku(sku: string): string {
  return sku.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) ||
    "item";
}

/**
 * Exact single-SKU payload documented by Walmart for
 * POST /v3/feeds?feedType=SKU_TEMPLATE_MAP. This function is pure and cannot
 * call Walmart.
 */
export function buildWalmartSkuTemplateMapContract(
  input: WalmartShippingAssociationExpectation,
): WalmartSkuTemplateMapContract {
  const sku = exactText(input.sku, "SKU");
  const shippingTemplateId = exactText(
    input.shipping_template_id,
    "Shipping template ID",
  );
  const fulfillmentCenterId = exactText(
    input.fulfillment_center_id,
    "Fulfillment center ID",
  );
  const payload: WalmartSkuTemplateMapPayload = {
    ItemFeedHeader: {
      sellingChannel: WALMART_SKU_TEMPLATE_MAP_SELLING_CHANNEL,
      locale: "en",
      version: WALMART_SKU_TEMPLATE_MAP_VERSION,
    },
    ItemFeed: [{
      sku,
      actionType: "Add",
      shippingTemplateId,
      fulfillmentCenterId,
    }],
  };
  const content = stableWalmartJson(payload);
  return {
    payload,
    payload_sha256: sha256WalmartJson(payload),
    params: { feedType: WALMART_SKU_TEMPLATE_MAP_FEED_TYPE },
    file: {
      filename: `${safeFilenameSku(sku)}-sku-template-map.json`,
      contentType: "application/json",
      content,
    },
  };
}

/**
 * The same association feed, carrying many SKUs.
 *
 * A batched MP_ITEM feed would be pointless if its shipping associations still
 * cost one feed each: the rate limit counts feeds, not items. The header and
 * per-item shape are unchanged — only the array is longer.
 */
export function buildWalmartSkuTemplateMapBatch(
  entries: WalmartShippingAssociationExpectation[],
): WalmartSkuTemplateMapContract {
  if (entries.length === 0) {
    throw new WalmartShippingTemplateAssociationContractError(
      "A SKU_TEMPLATE_MAP feed needs at least one SKU",
    );
  }
  const seen = new Set<string>();
  const items = entries.map((entry) => {
    const sku = exactText(entry.sku, "SKU");
    if (seen.has(sku)) {
      throw new WalmartShippingTemplateAssociationContractError(
        `${sku} appears twice in one SKU_TEMPLATE_MAP feed`,
      );
    }
    seen.add(sku);
    return {
      sku,
      actionType: "Add" as const,
      shippingTemplateId: exactText(entry.shipping_template_id, "Shipping template ID"),
      fulfillmentCenterId: exactText(entry.fulfillment_center_id, "Fulfillment center ID"),
    };
  });
  const payload = {
    ItemFeedHeader: {
      sellingChannel: WALMART_SKU_TEMPLATE_MAP_SELLING_CHANNEL,
      locale: "en" as const,
      version: WALMART_SKU_TEMPLATE_MAP_VERSION,
    },
    ItemFeed: items,
  } as unknown as WalmartSkuTemplateMapPayload;
  return {
    payload,
    payload_sha256: sha256WalmartJson(payload),
    params: { feedType: WALMART_SKU_TEMPLATE_MAP_FEED_TYPE },
    file: {
      filename: `batch-${items.length}-sku-template-map.json`,
      contentType: "application/json",
      content: stableWalmartJson(payload),
    },
  };
}

export function buildWalmartItemAssociationsRequest(
  sku: string,
): { items: [{ sku: string }] } {
  return { items: [{ sku: exactText(sku, "SKU") }] };
}

function objectValue(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WalmartShippingTemplateAssociationContractError(
      `${label} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

/**
 * Parse the official POST /v3/items/associations response and return only an
 * exact SKU + template + fulfillment-center match. Missing propagation is
 * represented as null; malformed, error-bearing, duplicate or contradictory
 * data fails closed.
 */
export function findExactWalmartShippingAssociation(
  raw: unknown,
  expected: WalmartShippingAssociationExpectation,
): WalmartShippingAssociationMatch | null {
  const expectedSku = exactText(expected.sku, "Expected SKU");
  const expectedTemplate = exactText(
    expected.shipping_template_id,
    "Expected shipping template ID",
  );
  const expectedCenter = exactText(
    expected.fulfillment_center_id,
    "Expected fulfillment center ID",
  );
  const root = objectValue(raw, "Item associations response");
  if (!Array.isArray(root.items)) {
    throw new WalmartShippingTemplateAssociationContractError(
      "Item associations response is missing items",
    );
  }
  const matchingItems = root.items
    .map((value, index) => objectValue(value, `items[${index}]`))
    .filter((item) => item.sku === expectedSku);
  if (matchingItems.length !== 1) {
    throw new WalmartShippingTemplateAssociationContractError(
      `Expected exactly one association row for SKU ${expectedSku}`,
    );
  }
  const item = matchingItems[0]!;
  if (
    Array.isArray(item.errors) &&
    item.errors.some((error) => {
      const parsed = objectValue(error, "Association error");
      return String(parsed.severity ?? "").toUpperCase() === "ERROR";
    })
  ) {
    throw new WalmartShippingTemplateAssociationContractError(
      `Walmart returned an association error for SKU ${expectedSku}`,
    );
  }
  if (!Array.isArray(item.associations)) {
    throw new WalmartShippingTemplateAssociationContractError(
      `Associations are missing for SKU ${expectedSku}`,
    );
  }
  const exactMatches: WalmartShippingAssociationMatch[] = [];
  for (const [index, associationRaw] of item.associations.entries()) {
    const association = objectValue(
      associationRaw,
      `associations[${index}]`,
    );
    const template = objectValue(
      association.shippingTemplate,
      `associations[${index}].shippingTemplate`,
    );
    const templateId = exactText(
      template.id,
      `associations[${index}].shippingTemplate.id`,
    );
    const shipNode = exactText(
      association.shipNode,
      `associations[${index}].shipNode`,
    );
    if (
      templateId !== expectedTemplate ||
      shipNode !== expectedCenter
    ) {
      continue;
    }
    exactMatches.push({
      sku: expectedSku,
      shipping_template_id: templateId,
      shipping_template_name: exactText(
        template.name,
        `associations[${index}].shippingTemplate.name`,
      ),
      shipping_template_type: exactText(
        template.type,
        `associations[${index}].shippingTemplate.type`,
      ),
      fulfillment_center_id: shipNode,
      fulfillment_center_name: exactText(
        association.shipNodeName,
        `associations[${index}].shipNodeName`,
      ),
    });
  }
  if (exactMatches.length > 1) {
    throw new WalmartShippingTemplateAssociationContractError(
      `Walmart returned duplicate exact associations for SKU ${expectedSku}`,
    );
  }
  return exactMatches[0] ?? null;
}
