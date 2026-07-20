/**
 * Walmart seller-fulfilled new-item adapter (MP_ITEM 5.0).
 *
 * Safety boundary:
 *   - reads only the canonical `ChannelSKU.attributes.walmart` public contract;
 *   - never invents brand, product type, country of origin, price or package facts;
 *   - validates every real payload against live Get Spec for its exact product type;
 *   - uploads the feed as multipart/form-data with a `file` part;
 *   - returns the explicit inventory/fulfillment handoff for lifecycle tracking.
 */

import type { ChannelSKU } from "@/generated/prisma/client";
import { getWalmartClient } from "@/lib/walmart/client";
import type { WalmartPublicListingContract } from "../walmart-listing-contract";
import {
  assertWalmartOwnerPermitSignature,
  walmartOwnerPermitTransportEnvironment,
  type WalmartOwnerPermit,
} from "../walmart-owner-permit";
import {
  physicalPackageSpecsMatchSku,
  type VerifiedPhysicalPackageSpecs,
} from "../physical-package-specs";
import {
  assertWalmartFullItemSetupRoute,
  parseWalmartPublicItemContract,
  WalmartItemContractError,
} from "./walmart-item-contract";
import {
  validateWalmartPayloadAgainstLiveSpec,
  type WalmartItemApiClient,
  type WalmartLiveSpecValidation,
} from "./walmart-item-spec";
import { hashWalmartPayload } from "./walmart-payload-hash";
import {
  markWalmartSubmissionRequesting,
  type WalmartFeedPostLifecycleClaim,
} from "./walmart-publish-lifecycle";

export interface WalmartPublishOwnerPermitAuthorization {
  signedPermit: WalmartOwnerPermit;
  engineReleaseSha256: string;
  approvalSha256: string;
  sellerAccountFingerprintSha256: string;
}

export interface WalmartPublishInput {
  sku: ChannelSKU;
  storeIndex: number;
  /** Exact marketplace brand; no house-brand fallback is permitted. */
  brand?: string | null;
  /** Exact total sellable-unit count from the canonical recipe. */
  packCount?: number | null;
  physicalPackageSpecs?: VerifiedPhysicalPackageSpecs | null;
  dryRun?: boolean;
  /** Dry runs are local by default. Set true to make the read-only Get Spec
   * request and validate without posting a feed. Real submissions always do it. */
  validateLiveSpec?: boolean;
  /** Narrow injection seam for deterministic transport/spec tests. */
  client?: WalmartItemApiClient;
  /** Mutation-adjacent approval/fingerprint fence. Called after the read-only
   * live schema check and immediately before POST /feeds. */
  beforeFeedPost?: () => void | Promise<void>;
  /** A digitally signed external owner authorization. Hash-only approvals and
   * callbacks cannot authorize a real MP_ITEM POST. */
  ownerPermitAuthorization?: WalmartPublishOwnerPermitAuthorization;
  /** Durable one-shot lifecycle claim. The values are not authority on their
   * own: submitToWalmart atomically consumes the exact DB row immediately
   * before POST, and replay/forgery fails the CLAIMED -> REQUESTING CAS. */
  lifecyclePostClaim?: WalmartFeedPostLifecycleClaim;
}

export interface WalmartPublishIssue {
  code?: string;
  message?: string;
  path?: string;
}

export interface WalmartPublishResult {
  ok: boolean;
  feed_id: string | null;
  walmart_status: string | null;
  payload: Record<string, unknown>;
  issues: WalmartPublishIssue[];
  error?: string;
  dry_run: boolean;
  offer_handoff: WalmartPublicListingContract["offer_handoff"] | null;
  schema_validation: WalmartLiveSpecValidation | null;
}

export interface WalmartPayloadBuildOptions {
  brand?: string | null;
  packCount?: number | null;
  physicalPackageSpecs?: VerifiedPhysicalPackageSpecs | null;
  /** Typed `ChannelSKU.attributes.walmart` contract supplied by callers that
   * already parsed the canonical attribute root. It is still runtime-checked. */
  walmart?: WalmartPublicListingContract;
  /** Compatibility alias for the first engine integration. */
  contract?: WalmartPublicListingContract;
}

export interface WalmartMultipartBody {
  payload: Record<string, unknown>;
  params: { feedType: "MP_ITEM" };
  file: {
    filename: string;
    contentType: "application/json";
    content: string;
  };
}

function issueError(message: string): never {
  throw new WalmartItemContractError([message]);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    return issueError(`${label} is required; no default is permitted`);
  }
  return value.trim();
}

function publicHttpsUrl(value: unknown, label: string): string {
  const text = requiredText(value, label);
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password) {
      return issueError(`${label} must be a public HTTPS URL`);
    }
    return url.toString();
  } catch {
    return issueError(`${label} must be a valid URL`);
  }
}

function parseBullets(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return issueError("ChannelSKU.bullets must be a JSON array");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((value) => typeof value !== "string" || !value.trim())
  ) {
    return issueError("ChannelSKU.bullets must contain non-empty strings");
  }
  return parsed.map((value) => String(value).trim());
}

function identifier(upc: string): { productIdType: "UPC" | "GTIN"; productId: string } {
  const value = upc.trim();
  if (/^\d{12}$/.test(value)) return { productIdType: "UPC", productId: value };
  if (/^\d{14}$/.test(value)) return { productIdType: "GTIN", productId: value };
  return issueError("ChannelSKU.upc must be a 12-digit UPC or 14-digit GTIN");
}

function positivePackCount(value: number | null | undefined): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    return issueError("Exact positive integer packCount is required");
  }
  return Number(value);
}

function positivePriceDollars(priceCents: number): number {
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) {
    return issueError("ChannelSKU.price_cents must be a positive safe integer");
  }
  return Number((priceCents / 100).toFixed(2));
}

function assertQuantityAttributes(
  attributes: Record<string, unknown>,
  packCount: number,
): void {
  const expected = packCount >= 2
    ? { multipackQuantity: packCount, countPerPack: 1, count: packCount }
    : {};
  for (const [key, value] of Object.entries(expected)) {
    if (attributes[key] != null && attributes[key] !== value) {
      issueError(
        `walmart.public_attributes.${key}=${String(attributes[key])} conflicts with exact packCount ${packCount}`,
      );
    }
    attributes[key] = value;
  }
}

/** Pure MP_ITEM 5.0 builder. It intentionally does not perform network I/O;
 * submitToWalmart owns live schema validation and transport. */
export function buildWalmartPayload(
  sku: ChannelSKU,
  opts: WalmartPayloadBuildOptions = {},
): Record<string, unknown> {
  assertWalmartFullItemSetupRoute(sku.attributes);
  if (opts.walmart && opts.contract && opts.walmart !== opts.contract) {
    return issueError("Provide walmart or contract, not both");
  }
  const suppliedContract = opts.walmart ?? opts.contract;
  // A TypeScript type is not runtime evidence. Re-parse explicitly supplied
  // contracts so an old 4.7 payload, stale version, bad hash, or internal key
  // cannot bypass the same fail-closed boundary used for persisted attributes.
  const contract = suppliedContract
    ? parseWalmartPublicItemContract(
        JSON.stringify({ walmart: suppliedContract }),
        sku.main_image_url,
      )
    : parseWalmartPublicItemContract(sku.attributes, sku.main_image_url);
  const brand = requiredText(opts.brand, "Walmart brand");
  const packCount = positivePackCount(opts.packCount);
  const physical = opts.physicalPackageSpecs;
  if (!physical || !physicalPackageSpecsMatchSku(sku, physical)) {
    return issueError(
      "Exact operator-verified package weight and dimensions matching ChannelSKU are required",
    );
  }

  const title = requiredText(sku.title, "ChannelSKU.title");
  const description = requiredText(sku.description, "ChannelSKU.description");
  const mainImageUrl = publicHttpsUrl(
    sku.main_image_url,
    "ChannelSKU.main_image_url",
  );
  const price = positivePriceDollars(sku.price_cents);
  const shippingWeight = Number((physical.weight_oz / 16).toFixed(4));
  const publicAttributes = { ...contract.public_attributes };
  assertQuantityAttributes(publicAttributes, packCount);

  const visible: Record<string, unknown> = {
    ...publicAttributes,
    productName: title,
    brand,
    shortDescription: description,
    keyFeatures: parseBullets(sku.bullets),
    mainImageUrl,
    productSecondaryImageURL: contract.secondary_image_urls,
  };

  const orderable: Record<string, unknown> = {
    sku: requiredText(sku.sku, "ChannelSKU.sku"),
    productIdentifiers: identifier(sku.upc),
    specProductType: contract.product_type,
    price,
    ShippingWeight: shippingWeight,
    countryOfOriginSubstantialTransformation:
      contract.country_of_origin_substantial_transformation,
    productPackageDimensionsAndWeight: {
      productPackageDimensionsDepth: physical.length_in,
      productPackageDimensionsHeight: physical.height_in,
      productPackageDimensionsWidth: physical.width_in,
      productPackageWeight: shippingWeight,
    },
  };
  if (contract.offer_handoff.mode === "INLINE") {
    orderable.inventory = [
      {
        fulfillmentCenterID: contract.offer_handoff.fulfillment_center_id,
        quantity: contract.offer_handoff.quantity,
      },
    ];
  }

  return {
    MPItemFeedHeader: {
      sellingChannel: "marketplace",
      feedType: "MP_ITEM",
      processMode: "REPLACE",
      locale: "en",
      version: contract.spec_version,
      subset: "EXTERNAL",
      subCategory: "product_content_and_site_exp",
    },
    MPItem: [
      {
        Orderable: orderable,
        Visible: { [contract.product_type]: visible },
      },
    ],
  };
}

export function buildWalmartFeedFile(
  sku: string,
  payload: Record<string, unknown>,
): { filename: string; contentType: "application/json"; content: string } {
  const safeSku = sku.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "item";
  return {
    filename: `${safeSku}-mp-item.json`,
    contentType: "application/json",
    content: JSON.stringify(payload),
  };
}

/** Pure serializable multipart request contract used by both the engine CLI
 * and the live transport. It does not instantiate a client or perform I/O. */
export function buildWalmartMultipartBody(
  sku: ChannelSKU,
  opts: WalmartPayloadBuildOptions = {},
): WalmartMultipartBody {
  const payload = buildWalmartPayload(sku, opts);
  return {
    payload,
    params: { feedType: "MP_ITEM" },
    file: buildWalmartFeedFile(sku.sku, payload),
  };
}

function baseFailure(args: {
  payload?: Record<string, unknown>;
  issues?: WalmartPublishIssue[];
  error: string;
  dryRun: boolean;
  contract?: WalmartPublicListingContract | null;
  schemaValidation?: WalmartLiveSpecValidation | null;
}): WalmartPublishResult {
  return {
    ok: false,
    feed_id: null,
    walmart_status: null,
    payload: args.payload ?? {},
    issues: args.issues ?? [],
    error: args.error,
    dry_run: args.dryRun,
    offer_handoff: args.contract?.offer_handoff ?? null,
    schema_validation: args.schemaValidation ?? null,
  };
}

export async function submitToWalmart(
  input: WalmartPublishInput,
): Promise<WalmartPublishResult> {
  const dryRun = input.dryRun === true;
  let contract: WalmartPublicListingContract;
  let payload: Record<string, unknown>;
  try {
    contract = parseWalmartPublicItemContract(
      input.sku.attributes,
      input.sku.main_image_url,
    );
    payload = buildWalmartPayload(input.sku, {
      brand: input.brand,
      packCount: input.packCount,
      physicalPackageSpecs: input.physicalPackageSpecs,
      walmart: contract,
    });
  } catch (error) {
    const issues = error instanceof WalmartItemContractError
      ? error.issues.map((message) => ({
          code: "WALMART_PUBLIC_CONTRACT_INVALID",
          message,
        }))
      : [];
    return baseFailure({
      issues,
      error: error instanceof Error ? error.message : String(error),
      dryRun,
    });
  }

  const needsLiveSpec = !dryRun || input.validateLiveSpec === true;
  if (!needsLiveSpec) {
    return {
      ok: true,
      feed_id: null,
      walmart_status: "DRY_RUN_LOCAL_ONLY",
      payload,
      issues: [],
      dry_run: true,
      offer_handoff: contract.offer_handoff,
      schema_validation: null,
    };
  }

  if (
    !dryRun &&
    (typeof input.beforeFeedPost !== "function"
      || !input.ownerPermitAuthorization
      || !input.lifecyclePostClaim)
  ) {
    return baseFailure({
      payload,
      issues: [
        {
          code: "WALMART_MUTATION_FENCE_MISSING",
          message:
            "Real Walmart submission requires a mutation-adjacent fence, signed external owner permit, and durable one-shot lifecycle claim",
        },
      ],
      error:
        "Real Walmart submission requires beforeFeedPost, signed owner authorization, and lifecyclePostClaim",
      dryRun: false,
      contract,
    });
  }

  let client: WalmartItemApiClient;
  try {
    client = input.client ?? getWalmartClient(input.storeIndex);
  } catch (error) {
    return baseFailure({
      payload,
      error:
        `Walmart credentials missing for store${input.storeIndex}: ` +
        (error instanceof Error ? error.message : String(error)),
      dryRun,
      contract,
    });
  }

  const schemaValidation = await validateWalmartPayloadAgainstLiveSpec({
    client,
    contract,
    payload,
  });
  if (!schemaValidation.valid) {
    return baseFailure({
      payload,
      issues: schemaValidation.issues,
      error: "Current Walmart Get Spec validation blocked the MP_ITEM feed",
      dryRun,
      contract,
      schemaValidation,
    });
  }

  if (dryRun) {
    return {
      ok: true,
      feed_id: null,
      walmart_status: "DRY_RUN_SPEC_VALIDATED",
      payload,
      issues: [],
      dry_run: true,
      offer_handoff: contract.offer_handoff,
      schema_validation: schemaValidation,
    };
  }

  const file = buildWalmartFeedFile(input.sku.sku, payload);
  try {
    await input.beforeFeedPost?.();
    const authorization = input.ownerPermitAuthorization!;
    assertWalmartOwnerPermitSignature(authorization.signedPermit, {
      expectedEnvironment: walmartOwnerPermitTransportEnvironment(),
    });
    const body = authorization.signedPermit.signed_body;
    if (
      body.engine_release_sha256 !== authorization.engineReleaseSha256 ||
      body.approval_sha256 !== authorization.approvalSha256 ||
      body.seller_account_fingerprint_sha256 !==
        authorization.sellerAccountFingerprintSha256 ||
      body.channel_sku_id !== input.sku.id ||
      body.sku !== input.sku.sku ||
      body.upc !== input.sku.upc ||
      body.store_index !== input.storeIndex ||
      body.payload_sha256 !== hashWalmartPayload(payload)
    ) {
      throw new Error("Signed owner permit differs from current Walmart POST");
    }
    const lifecycleClaim = input.lifecyclePostClaim!;
    await markWalmartSubmissionRequesting({
      attemptId: lifecycleClaim.attemptId,
      claimToken: lifecycleClaim.claimToken,
      channelSkuId: input.sku.id,
      payloadHash: hashWalmartPayload(payload),
      pilotPermitSha256: authorization.signedPermit.permit_sha256,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return baseFailure({
      payload,
      issues: [{ code: "WALMART_MUTATION_FENCE_FAILED", message }],
      error: `Walmart mutation-adjacent approval fence failed: ${message}`,
      dryRun: false,
      contract,
      schemaValidation,
    });
  }

  try {
    const response = await client.requestRaw("POST", "/feeds", {
      params: { feedType: "MP_ITEM" },
      file,
    });
    const body = response.body && typeof response.body === "object"
      ? response.body as { feedId?: string; status?: string }
      : null;
    const feedId = body?.feedId ?? null;
    if (!response.ok || !feedId) {
      return baseFailure({
        payload,
        error:
          `Walmart MP_ITEM multipart feed returned HTTP ${response.status} without a feedId`,
        dryRun: false,
        contract,
        schemaValidation,
      });
    }
    return {
      ok: true,
      feed_id: feedId,
      walmart_status: body?.status ?? "RECEIVED",
      payload,
      issues: [],
      dry_run: false,
      offer_handoff: contract.offer_handoff,
      schema_validation: schemaValidation,
    };
  } catch (error) {
    return baseFailure({
      payload,
      error:
        `Walmart POST /feeds multipart upload failed: ` +
        (error instanceof Error ? error.message : String(error)),
      dryRun: false,
      contract,
      schemaValidation,
    });
  }
}
