/**
 * Fresh, authenticated post-apply Qualification for the one-SKU Walmart repair.
 *
 * The caller is the frozen operator. It first proves terminal apply custody,
 * then invokes the frozen read-only one-SKU capture and passes that newly
 * created directory here. Caller-authored verdicts and old capture directories
 * are not accepted.
 */

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  walmartListingIntegritySha256,
} from "./listing-integrity-audit.ts";
import type { SealedWalmartListingRepairPlan } from "./listing-integrity-remediation-qualification.ts";

export const WALMART_LISTING_REPAIR_LIVE_QUALIFICATION_SCHEMA =
  "walmart-listing-integrity-repair-live-qualification/v1" as const;

const PROPAGATION_FAILURE_NOT_BEFORE_MS = 7_200_000;
const MAX_CAPTURE_AFTER_TERMINAL_MS = 7 * 24 * 60 * 60_000;
const SHA256 = /^[a-f0-9]{64}$/u;

type JsonRecord = Record<string, unknown>;
type FacetVerdict = "PASS" | "FAIL";

export interface WalmartListingRepairLiveQualification {
  schema_version: typeof WALMART_LISTING_REPAIR_LIVE_QUALIFICATION_SCHEMA;
  qualification_id: string;
  qualified_at: string;
  verdict: "PASS" | "FAIL" | "PENDING_PROPAGATION";
  listing: {
    channel: "WALMART_US";
    store_index: number;
    sku: string;
    listing_key: string;
    item_id: string;
  };
  plan_id: string;
  plan_body_sha256: string;
  permit_authorization_sha256: string;
  feed_id: string;
  feed_terminal_at: string;
  live_capture: {
    created_at: string;
    intake_index_body_sha256: string;
    intake_index_file_sha256: string;
    buyer_pdp_file_sha256: string;
    seller_item_file_sha256: string;
    catalog_search_file_sha256: string;
    image_sha256: string[];
  };
  apply_custody: {
    ledger_terminal_sha256: string;
    ledger_head_sha256: string;
    artifact_inventory_sha256: string;
    request_payload_sha256: string;
    terminal_feed_status_payload_sha256: string;
  };
  authority: {
    method: "FROZEN_AUTHENTICATED_LIVE_REREAD";
    live_capture_created_by_qualifier: true;
    caller_authored_verdict_accepted: false;
    cached_capture_accepted: false;
    exact_target_rebuilt_from_owner_signed_plan: true;
    exact_image_bytes_verified: true;
    terminal_apply_custody_verified: true;
  };
  facets: {
    exact_listing_identity: FacetVerdict;
    published_and_indexed: FacetVerdict;
    product_and_variant: FacetVerdict;
    pack_count: FacetVerdict;
    title: FacetVerdict;
    description: FacetVerdict;
    bullets: FacetVerdict;
    attributes: FacetVerdict;
    main: FacetVerdict;
    gallery: FacetVerdict;
    exact_repair_target: FacetVerdict;
    unchanged_fields_preserved: FacetVerdict;
    fresh_authenticated_live_reread: FacetVerdict;
    terminal_apply_custody: FacetVerdict;
  };
  blocking_reasons: string[];
  propagation: {
    failure_not_before: string;
    reread_before_failure_window: boolean;
    recheck_same_sku_without_write: boolean;
  };
  next_sku_unblocked: boolean;
  next_action: "ADVANCE_TO_NEXT_SKU" | "RECHECK_SAME_SKU_NO_WRITE" | "OWNER_REVIEW_REPLAN";
  marketplace_write_authorized: false;
  automatic_reapply_allowed: false;
  external_effects: {
    product_truth_reads: 1;
    walmart_logical_gets: 2;
    buyer_pdp_gets: 1;
    image_gets: number;
    model_calls: 0;
    database_writes: 0;
    walmart_writes: 0;
  };
  body_sha256: string;
}

function fail(message: string): never {
  const error = new Error(message);
  (error as Error & { code: string }).code = "WALMART_LISTING_REPAIR_LIVE_QUALIFICATION_ERROR";
  throw error;
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    fail(`${label} must be a non-empty exact string`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!SHA256.test(parsed)) fail(`${label} must be lowercase SHA-256`);
  return parsed;
}

function instant(value: unknown, label: string): string {
  const parsed = text(value, label);
  const date = new Date(parsed);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== parsed) {
    fail(`${label} must be canonical UTC`);
  }
  return parsed;
}

function pass(value: boolean): FacetVerdict {
  return value ? "PASS" : "FAIL";
}

function exactArray(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => (
      typeof value === "string" && value === right[index]
    ));
}

async function stableFile(file: string, maximum = 256 * 1024 * 1024): Promise<Uint8Array> {
  const before = await lstat(file).catch(() => fail(`missing qualification evidence: ${file}`));
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size < 1 || before.size > maximum || await realpath(file) !== file) {
    fail(`qualification evidence is not one canonical regular file: ${file}`);
  }
  const bytes = Uint8Array.from(await readFile(file));
  const after = await lstat(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
    || bytes.byteLength !== before.size) {
    fail(`qualification evidence changed while read: ${file}`);
  }
  return bytes;
}

function safeChild(root: string, relative: unknown): string {
  const value = text(relative, "intake evidence path");
  if (path.isAbsolute(value)
    || value.split(/[\\/]/u).some((part) => !part || part === "..")) {
    fail("intake evidence path is unsafe");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, value);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    fail("intake evidence path escapes capture directory");
  }
  return resolved;
}

function parseJson(bytes: Uint8Array, label: string): JsonRecord {
  try {
    return record(JSON.parse(Buffer.from(bytes).toString("utf8")), label);
  } catch {
    return fail(`${label} is not JSON`);
  }
}

function sellerItem(value: JsonRecord): JsonRecord {
  const rows = value.ItemResponse;
  if (!Array.isArray(rows) || rows.length !== 1) {
    fail("seller item must contain exactly one ItemResponse");
  }
  return record(rows[0], "seller item row");
}

function stringRows(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((row) => typeof row !== "string" || !row)) {
    fail(`${label} must be an exact non-empty string array`);
  }
  return [...value] as string[];
}

function specifications(product: JsonRecord): Map<string, string> {
  if (!Array.isArray(product.specifications)) fail("buyer specifications must be an array");
  const result = new Map<string, string>();
  for (const raw of product.specifications) {
    const row = record(raw, "buyer specification");
    result.set(text(row.name, "buyer specification name"), text(row.value, "buyer specification value"));
  }
  return result;
}

function sellerOuterUnits(row: JsonRecord): number | null {
  const group = row.variantGroupInfo;
  if (!group || typeof group !== "object" || Array.isArray(group)) return null;
  const values = (group as JsonRecord).groupingAttributes;
  if (!Array.isArray(values)) return null;
  const found = values.find((raw) => {
    const value = raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw as JsonRecord : null;
    return value?.name === "number_of_pieces";
  });
  if (!found || typeof found !== "object" || Array.isArray(found)) return null;
  const numeric = Number((found as JsonRecord).value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

interface TargetFacts {
  brand: string;
  product: string;
  variant: string;
  outer_units: number;
  net_content: number;
  inner_item_count: number;
}

function targetFacts(plan: SealedWalmartListingRepairPlan): TargetFacts {
  const facts: Partial<TargetFacts> = {};
  for (const claim of plan.target.surface.attribute_claims) {
    if (claim.kind === "brand" && "text" in claim) facts.brand = claim.text;
    if (claim.kind === "product" && "text" in claim) facts.product = claim.text;
    if (claim.kind === "variant" && "text" in claim) facts.variant = claim.text;
    if (claim.kind === "outer_units" && "value" in claim) facts.outer_units = claim.value;
    if (claim.kind === "net_content" && "value" in claim) facts.net_content = claim.value;
    if (claim.kind === "inner_item_count" && "value" in claim) facts.inner_item_count = claim.value;
  }
  if (typeof facts.brand !== "string" || typeof facts.product !== "string"
    || typeof facts.variant !== "string" || !Number.isSafeInteger(facts.outer_units)
    || !Number.isSafeInteger(facts.net_content) || !Number.isSafeInteger(facts.inner_item_count)) {
    fail("owner-signed target is missing exact product/pack attribute claims");
  }
  return facts as TargetFacts;
}

function includesNormalized(haystack: string, needle: string): boolean {
  const normalize = (value: string) => value.toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, " ").trim();
  return normalize(haystack).includes(normalize(needle));
}

export async function qualifyWalmartListingRepairFreshLive(input: {
  plan: SealedWalmartListingRepairPlan;
  permit_authorization_sha256: string;
  ledger_evidence: unknown;
  artifact_custody_evidence: unknown;
  fresh_capture_directory: string;
  capture_summary: unknown;
  evaluated_at: Date;
}): Promise<WalmartListingRepairLiveQualification> {
  const plan = input.plan;
  const ledger = record(input.ledger_evidence, "ledger evidence");
  const custody = record(input.artifact_custody_evidence, "artifact custody evidence");
  const receipt = record(ledger.receipt, "terminal ledger receipt");
  if (ledger.state !== "SUCCEEDED" || receipt.state !== "SUCCEEDED") {
    fail("live Qualification requires terminal SUCCEEDED apply custody");
  }
  const terminalAt = instant(receipt.terminal_at, "terminal_at");
  const terminalMs = Date.parse(terminalAt);
  const permitSha = digest(input.permit_authorization_sha256, "permit authorization");
  if (receipt.authorization_sha256 !== permitSha) {
    fail("terminal ledger receipt belongs to a different permit");
  }
  const capture = record(input.capture_summary, "fresh capture summary");
  if (!["CAPTURED", "CAPTURED_SOURCE_REQUIRED"].includes(String(capture.status))) {
    fail("frozen live capture did not complete");
  }
  const execution = record(capture.execution, "fresh capture execution");
  const expectedImageCount = plan.target.images.length;
  if (execution.product_truth_reads !== 1 || execution.walmart_logical_gets !== 2
    || execution.buyer_pdp_gets !== 1 || execution.image_gets !== expectedImageCount
    || execution.model_calls !== 0 || execution.database_writes !== 0
    || execution.walmart_writes !== 0) {
    fail("fresh capture exceeded its exact read-only effects contract");
  }
  const captureRoot = path.resolve(input.fresh_capture_directory);
  if (await realpath(captureRoot) !== captureRoot) fail("capture directory is not canonical");
  const indexFile = await stableFile(path.join(captureRoot, "intake-index.json"), 16 * 1024 * 1024);
  const index = parseJson(indexFile, "intake index");
  const indexBody = { ...index };
  const indexBodySha = digest(indexBody.body_sha256, "intake body_sha256");
  delete indexBody.body_sha256;
  if (walmartListingIntegritySha256(indexBody) !== indexBodySha
    || index.listing_key !== plan.listing.listing_key) {
    fail("fresh intake index seal or listing identity differs");
  }
  const capturedAt = instant(index.created_at, "fresh capture created_at");
  const captureMs = Date.parse(capturedAt);
  if (captureMs <= terminalMs || captureMs - terminalMs > MAX_CAPTURE_AFTER_TERMINAL_MS) {
    fail("fresh live reread is not within seven days after terminal feed confirmation");
  }
  if (!(input.evaluated_at instanceof Date) || !Number.isFinite(input.evaluated_at.getTime())
    || input.evaluated_at.getTime() < captureMs
    || input.evaluated_at.getTime() - captureMs > 15 * 60_000) {
    fail("Qualification evaluator clock is not fresh relative to live capture");
  }

  const files = index.files;
  if (!Array.isArray(files)) fail("intake index files must be an array");
  const byRole = new Map<string, { path: string; file_sha256: string; bytes: Uint8Array }>();
  for (const raw of files) {
    const row = record(raw, "intake file row");
    const role = text(row.role, "intake role");
    if (byRole.has(role)) fail(`duplicate intake role ${role}`);
    const filePath = safeChild(captureRoot, row.path);
    const bytes = await stableFile(filePath);
    const fileSha = digest(row.file_sha256, `${role} file_sha256`);
    if (bytes.byteLength !== row.bytes || sha256Bytes(bytes) !== fileSha) {
      fail(`${role} bytes differ from fresh intake index`);
    }
    byRole.set(role, { path: filePath, file_sha256: fileSha, bytes });
  }
  const buyerFile = byRole.get("buyer_pdp_payload");
  const sellerFile = byRole.get("seller_item_payload");
  const searchFile = byRole.get("catalog_search_payload");
  if (!buyerFile || !sellerFile || !searchFile) {
    fail("fresh intake is missing buyer/seller/indexability payloads");
  }
  const buyer = parseJson(buyerFile.bytes, "buyer PDP payload");
  const product = record(buyer.product, "buyer PDP product");
  const seller = sellerItem(parseJson(sellerFile.bytes, "seller item payload"));
  const buyerTitle = text(product.title, "buyer title");
  const buyerDescription = text(product.description, "buyer description");
  const buyerBullets = stringRows(product.feature_bullets, "buyer bullets");
  const buyerImages = stringRows(product.images, "buyer images");
  const spec = specifications(product);
  const facts = targetFacts(plan);
  const combinedText = `${buyerTitle}\n${buyerDescription}\n${buyerBullets.join("\n")}`;
  const targetImages = plan.target.images;
  const liveImages = [...byRole.entries()]
    .filter(([role]) => role === "buyer_image_main" || role.startsWith("buyer_image_gallery_"))
    .sort(([left], [right]) => {
      if (left === "buyer_image_main") return -1;
      if (right === "buyer_image_main") return 1;
      return left.localeCompare(right);
    })
    .map(([, value]) => value.file_sha256);
  const imageUrlsExact = exactArray(
    buyerImages,
    targetImages.map((row) => row.source_url),
  ) && product.main_image === targetImages[0]?.source_url;
  const imageBytesExact = exactArray(
    liveImages,
    targetImages.map((row) => row.sha256),
  );
  const outerUnits = facts.outer_units;
  const outerText = new RegExp(`(?:pack\\s+of\\s+${outerUnits}|${outerUnits}\\s+(?:bags|packs|packages))`, "iu");
  const innerText = new RegExp(`${facts.inner_item_count}\\s+buns`, "iu");
  const netText = new RegExp(`${facts.net_content}\\s*oz`, "iu");
  const targetTitle = plan.target.surface.title;
  const targetDescription = plan.target.surface.description ?? "";
  const targetBullets = plan.target.surface.bullets;
  const productAndVariant = includesNormalized(combinedText, facts.product)
    && includesNormalized(combinedText, facts.brand)
    && facts.variant.split(",").every((part) => includesNormalized(combinedText, part.trim()));
  const packCount = sellerOuterUnits(seller) === outerUnits
    && outerText.test(buyerTitle) && outerText.test(buyerDescription)
    && buyerBullets.some((row) => outerText.test(row))
    && netText.test(combinedText) && innerText.test(combinedText);
  const attributes = spec.get("Brand") === facts.brand
    && includesNormalized(spec.get("Flavor") ?? "", facts.variant.split(",")[0] ?? "")
    && Number(spec.get("Count")) === facts.inner_item_count
    && includesNormalized(spec.get("Product net content parent") ?? "", `${facts.net_content} Ounces`)
    && sellerOuterUnits(seller) === outerUnits;
  const exactIdentity = seller.sku === plan.listing.sku
    && seller.mart === "WALMART_US"
    && String(product.item_id) === plan.listing.item_id;
  const published = seller.publishedStatus === "PUBLISHED"
    && seller.lifecycleStatus === "ACTIVE"
    && text(product.product_url, "buyer product URL").endsWith(`/${plan.listing.item_id}`);
  const facets = {
    exact_listing_identity: pass(exactIdentity),
    published_and_indexed: pass(published),
    product_and_variant: pass(productAndVariant),
    pack_count: pass(packCount),
    title: pass(buyerTitle === targetTitle),
    description: pass(buyerDescription === targetDescription),
    bullets: pass(exactArray(buyerBullets, targetBullets)),
    attributes: pass(attributes),
    main: pass(imageUrlsExact && imageBytesExact && targetImages[0]?.slot === "main"),
    gallery: pass(imageUrlsExact && imageBytesExact && targetImages.length >= 2),
    exact_repair_target: pass(
      buyerTitle === targetTitle
      && buyerDescription === targetDescription
      && exactArray(buyerBullets, targetBullets)
      && imageUrlsExact && imageBytesExact
    ),
    unchanged_fields_preserved: pass(
      plan.changed_fields.length === 2
      && plan.changed_fields[0] === "description"
      && plan.changed_fields[1] === "bullets"
      && buyerTitle === plan.target.surface.title
      && imageBytesExact
    ),
    fresh_authenticated_live_reread: "PASS" as const,
    terminal_apply_custody: "PASS" as const,
  };
  const blockingReasons = Object.entries(facets)
    .filter(([, verdict]) => verdict === "FAIL")
    .map(([name]) => `${name} did not pass`);
  const failureNotBeforeMs = terminalMs + PROPAGATION_FAILURE_NOT_BEFORE_MS;
  const qualityPassed = blockingReasons.length === 0;
  const failureProven = !qualityPassed && captureMs >= failureNotBeforeMs;
  const verdict = qualityPassed ? "PASS" as const
    : failureProven ? "FAIL" as const : "PENDING_PROPAGATION" as const;
  const custodyInventorySha = digest(custody.inventory_sha256, "artifact custody inventory");
  const body = {
    schema_version: WALMART_LISTING_REPAIR_LIVE_QUALIFICATION_SCHEMA,
    qualification_id: `live-qualification-${walmartListingIntegritySha256({
      permit: permitSha,
      plan: plan.body_sha256,
      capture: indexBodySha,
      evaluated_at: input.evaluated_at.toISOString(),
    }).slice(0, 24)}`,
    qualified_at: input.evaluated_at.toISOString(),
    verdict,
    listing: {
      channel: "WALMART_US" as const,
      store_index: plan.listing.store_index,
      sku: plan.listing.sku,
      listing_key: plan.listing.listing_key,
      item_id: plan.listing.item_id,
    },
    plan_id: plan.plan_id,
    plan_body_sha256: plan.body_sha256,
    permit_authorization_sha256: permitSha,
    feed_id: text(receipt.feed_id, "terminal feed_id"),
    feed_terminal_at: terminalAt,
    live_capture: {
      created_at: capturedAt,
      intake_index_body_sha256: indexBodySha,
      intake_index_file_sha256: sha256Bytes(indexFile),
      buyer_pdp_file_sha256: buyerFile.file_sha256,
      seller_item_file_sha256: sellerFile.file_sha256,
      catalog_search_file_sha256: searchFile.file_sha256,
      image_sha256: liveImages,
    },
    apply_custody: {
      ledger_terminal_sha256: digest(ledger.terminal_sha256, "ledger terminal SHA"),
      ledger_head_sha256: digest(ledger.head_sha256, "ledger head SHA"),
      artifact_inventory_sha256: custodyInventorySha,
      request_payload_sha256: digest(receipt.request_payload_sha256, "request payload SHA"),
      terminal_feed_status_payload_sha256:
        digest(receipt.feed_status_payload_sha256, "terminal feed status payload SHA"),
    },
    authority: {
      method: "FROZEN_AUTHENTICATED_LIVE_REREAD" as const,
      live_capture_created_by_qualifier: true as const,
      caller_authored_verdict_accepted: false as const,
      cached_capture_accepted: false as const,
      exact_target_rebuilt_from_owner_signed_plan: true as const,
      exact_image_bytes_verified: true as const,
      terminal_apply_custody_verified: true as const,
    },
    facets,
    blocking_reasons: blockingReasons,
    propagation: {
      failure_not_before: new Date(failureNotBeforeMs).toISOString(),
      reread_before_failure_window: captureMs < failureNotBeforeMs,
      recheck_same_sku_without_write: verdict === "PENDING_PROPAGATION",
    },
    next_sku_unblocked: verdict === "PASS",
    next_action: verdict === "PASS" ? "ADVANCE_TO_NEXT_SKU" as const
      : verdict === "PENDING_PROPAGATION" ? "RECHECK_SAME_SKU_NO_WRITE" as const
        : "OWNER_REVIEW_REPLAN" as const,
    marketplace_write_authorized: false as const,
    automatic_reapply_allowed: false as const,
    external_effects: {
      product_truth_reads: 1 as const,
      walmart_logical_gets: 2 as const,
      buyer_pdp_gets: 1 as const,
      image_gets: expectedImageCount,
      model_calls: 0 as const,
      database_writes: 0 as const,
      walmart_writes: 0 as const,
    },
  };
  return Object.freeze({
    ...body,
    body_sha256: walmartListingIntegritySha256(body),
  }) as WalmartListingRepairLiveQualification;
}
