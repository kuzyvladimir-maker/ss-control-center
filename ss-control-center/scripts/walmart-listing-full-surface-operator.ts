#!/usr/bin/env tsx

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
} from "node:fs/promises";
import path from "node:path";

import {
  MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS,
  MARUCHAN_ROAST_CHICKEN_NATIONAL_RATE_PER_LB_CENTS,
  MARUCHAN_ROAST_CHICKEN_SERVICE_STATES,
  MARUCHAN_ROAST_CHICKEN_TEMPLATE_NAME,
  buildMaruchanPricePayload,
  buildMaruchanRoastChickenItemPayload,
  buildMaruchanShippingAssociationPayload,
  buildMaruchanSoutheastShippingTemplate,
  maruchanRoastChickenTitle,
  validateMaruchanCatalogClearanceReports,
  validateMaruchanRoastChickenItemPayload,
} from "@/lib/walmart/maruchan-roast-chicken-repair";
import {
  WALMART_LISTING_FULL_SURFACE_OUTCOME_SCHEMA,
  buildWalmartListingFullSurfacePlan,
  evaluateWalmartListingFullSurfaceFeed,
  walmartListingFullSurfaceSha256,
  type WalmartListingFullSurfaceOperation,
  type WalmartListingFullSurfaceOutcome,
  type WalmartListingFullSurfacePlan,
  type WalmartListingFullSurfaceFeedVerdict,
} from "@/lib/walmart/listing-integrity-full-surface";
import {
  WALMART_LISTING_FULL_SURFACE_PERMIT_ACTION,
  WALMART_LISTING_FULL_SURFACE_PERMIT_ALGORITHM,
  WALMART_LISTING_FULL_SURFACE_PERMIT_SCHEMA,
  verifyWalmartListingFullSurfacePermit,
  walmartListingFullSurfacePermitSigningMessage,
  type WalmartListingFullSurfacePermit,
  type WalmartListingFullSurfacePermitSignedBody,
  type WalmartListingFullSurfacePermitSigningEnvelope,
} from "@/lib/walmart/listing-integrity-full-surface-authority";
import {
  openWalmartListingFullSurfaceLedger,
} from "@/lib/walmart/listing-integrity-full-surface-ledger";
import {
  WalmartListingFullSurfaceTransportError,
  createWalmartListingFullSurfaceTransport,
  type WalmartListingFullSurfaceOneShotTransport,
  type WalmartListingFullSurfaceTransportResponse,
} from "@/lib/walmart/listing-integrity-full-surface-transport";
import {
  walmartOwnerControlProductionTrustedKeys,
} from "@/lib/walmart/owner-control-trust-root";

const BUNDLE_SCHEMA = "walmart-listing-full-surface-artifact-bundle/v1";
const SIGNING_REQUEST_SCHEMA =
  "walmart-listing-integrity-full-surface-signing-request/v1";
const PRODUCT_TRUTH_SNAPSHOT_SHA =
  "402be85b952b868f000c27d35a92fe31e369a562cc26e0697ff055f235bdc5b7";
const OWNER_DECISION = Object.freeze({
  decision_id: "owner-maruchan-full-repair-2026-07-29",
  decision_ref:
    "owner-chat:2026-07-29:repair-all-api-mutable-fields-and-upload-live",
  approved_by: "Owner / Vladimir Kuznetsov",
  scope: {
    channel: "WALMART_US",
    store_index: 1,
    skus: ["FaisalX-1433", "FaisalX-1434", "FaisalX-1435"],
    live_listing_writes_authorized: true,
    content_images_attributes_price_weight_shipping_authorized: true,
    repeat_chat_confirmation_required: false,
  },
});
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const FEED_POLL_ATTEMPTS = 20;
const READBACK_POLL_ATTEMPTS = 12;
const POLL_MS = 15_000;

type JsonRecord = Record<string, unknown>;

interface BundleManifest {
  schema_version: typeof BUNDLE_SCHEMA;
  bundle_kind: "SHIPPING_TEMPLATE_CREATE" | "MARUCHAN_REPAIR";
  created_at: string;
  plan_file: "plan.json";
  plan_body_sha256: string;
  payload_files: Record<string, string>;
  baseline_manifest_body_sha256: string;
  assets_manifest_body_sha256: string | null;
  product_truth_snapshot_sha256: string;
  body_sha256: string;
}

function fail(code: string, message: string): never {
  const error = new Error(`Walmart full-surface operator: ${message}`);
  (error as Error & { code: string }).code = code;
  throw error;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as JsonRecord;
    return `{${Object.keys(row).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("INVALID_JSON", "undefined is forbidden");
  return encoded;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

function withoutKey<T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const result: Partial<T> = { ...value };
  delete result[key];
  return result as Omit<T, K>;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_ARTIFACT", `${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactAbsolute(value: string | undefined, label: string): string {
  if (!value) fail("INVALID_ARGUMENT", `${label} is required`);
  const resolved = path.resolve(value);
  if (resolved !== value) {
    fail("INVALID_ARGUMENT", `${label} must be an exact absolute path`);
  }
  return resolved;
}

function exactSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("INVALID_ARTIFACT", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function parseArgs(argv: string[]): {
  command: string;
  values: Map<string, string>;
} {
  const command = argv[0];
  if (!command) fail("INVALID_ARGUMENT", "command is required");
  const values = new Map<string, string>();
  for (const argument of argv.slice(1)) {
    const match = /^--([a-z0-9-]+)=(.+)$/u.exec(argument);
    if (!match || values.has(match[1]!)) {
      fail("INVALID_ARGUMENT", `unsupported argument: ${argument}`);
    }
    values.set(match[1]!, match[2]!);
  }
  return { command, values };
}

async function readStable(filePath: string, label: string): Promise<Buffer> {
  const info = await lstat(filePath).catch(() =>
    fail("ARTIFACT_NOT_FOUND", `${label} is missing`));
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || (info.mode & 0o022) !== 0 || info.size < 1
    || info.size > MAX_FILE_BYTES) {
    fail("UNSAFE_ARTIFACT", `${label} is not a stable regular file`);
  }
  return readFile(filePath);
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail("INVALID_ARTIFACT", `${label} is not UTF-8 JSON`);
  }
}

async function readJson(filePath: string, label: string): Promise<JsonRecord> {
  return record(parseJson(await readStable(filePath, label), label), label);
}

async function writeExclusive(
  filePath: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await open(filePath, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o400);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createPrivateDirectory(directory: string): Promise<void> {
  try {
    await lstat(directory);
    fail("OUTPUT_EXISTS", `${directory} already exists`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { recursive: false, mode: 0o700 });
  await chmod(directory, 0o700);
}

function credentials() {
  const client_id = process.env.WALMART_CLIENT_ID_STORE1;
  const client_secret = process.env.WALMART_CLIENT_SECRET_STORE1;
  const seller_id = process.env.WALMART_STORE1_SELLER_ID;
  if (!client_id || !client_secret || !seller_id) {
    fail("CREDENTIALS_MISSING", "Walmart store 1 credentials are incomplete");
  }
  return { client_id, client_secret, seller_id };
}

function transport(): WalmartListingFullSurfaceOneShotTransport {
  return createWalmartListingFullSurfaceTransport({
    store_index: 1,
    credentials: credentials(),
  });
}

function responseJson(
  response: WalmartListingFullSurfaceTransportResponse,
  label: string,
): JsonRecord {
  return record(parseJson(response.body, label), label);
}

function verifiedHashedArtifact(value: JsonRecord, label: string): JsonRecord {
  const claimed = exactSha(value.body_sha256, `${label} body_sha256`);
  const body = withoutKey(value, "body_sha256");
  if (sha256(canonicalJson(body)) !== claimed) {
    fail("ARTIFACT_HASH_MISMATCH", `${label} body SHA-256 mismatch`);
  }
  return value;
}

function baselineExchange(
  manifest: JsonRecord,
  semantic: string,
): JsonRecord {
  const exchanges = manifest.exchanges;
  if (!Array.isArray(exchanges)) fail("INVALID_BASELINE", "exchanges missing");
  const row = exchanges.find((value) =>
    record(value, "baseline exchange").semantic === semantic);
  if (!row) fail("INVALID_BASELINE", `${semantic} exchange missing`);
  return record(row, `${semantic} exchange`);
}

function exactListings() {
  return MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS.map((row) => ({
    channel: "WALMART_US" as const,
    store_index: 1,
    sku: row.sku,
    listing_key: `walmart:1:${row.sku}`,
    item_id: row.item_id,
  }));
}

function ownerDecisionSha(): string {
  return sha256(canonicalJson(OWNER_DECISION));
}

function newPlanTimes(): { created: string; expires: string } {
  const now = new Date();
  return {
    created: now.toISOString(),
    expires: new Date(now.getTime() + 23 * 60 * 60 * 1_000).toISOString(),
  };
}

async function loadBaseline(directory: string): Promise<{
  manifest: JsonRecord;
  spec: JsonRecord;
}> {
  const manifest = verifiedHashedArtifact(
    await readJson(path.join(directory, "manifest.json"), "baseline manifest"),
    "baseline manifest",
  );
  if (
    canonicalJson(manifest.exact_skus)
    !== canonicalJson(MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS.map((row) => row.sku))
    || manifest.store_index !== 1
  ) {
    fail("INVALID_BASELINE", "baseline is not the exact three-SKU scope");
  }
  const specExchange = baselineExchange(manifest, "item-spec");
  const spec = await readJson(
    path.join(directory, String(specExchange.response_file)),
    "Get Spec response",
  );
  if (
    sha256(canonicalBytes(spec))
      !== specExchange.response_payload_sha256
  ) {
    const raw = await readStable(
      path.join(directory, String(specExchange.response_file)),
      "Get Spec response",
    );
    if (sha256(raw) !== specExchange.response_payload_sha256) {
      fail("INVALID_BASELINE", "Get Spec response bytes drifted");
    }
  }
  return { manifest, spec };
}

function templateRows(value: JsonRecord): JsonRecord[] {
  if (!Array.isArray(value.shippingTemplates)) {
    fail("INVALID_WALMART_RESPONSE", "shippingTemplates is missing");
  }
  return value.shippingTemplates.map((row) => record(row, "shipping template"));
}

async function stageTemplate(values: Map<string, string>): Promise<void> {
  const baselineDir = exactAbsolute(values.get("baseline-dir"), "--baseline-dir");
  const outputDir = exactAbsolute(values.get("output-dir"), "--output-dir");
  const ledgerDir = exactAbsolute(values.get("ledger-dir"), "--ledger-dir");
  const { manifest: baseline } = await loadBaseline(baselineDir);
  const client = transport();
  if (
    client.account_binding.seller_account_fingerprint_sha256
    !== baseline.seller_account_fingerprint_sha256
  ) {
    fail("ACCOUNT_MISMATCH", "runtime seller account differs from baseline");
  }
  const listResponse = await client.read({
    path: "/v3/settings/shipping/templates",
    query: {},
    correlation_id: randomUUID(),
  });
  if (listResponse.status !== 200) {
    fail("WALMART_READ_FAILED", `template list returned ${listResponse.status}`);
  }
  const list = responseJson(listResponse, "shipping template list");
  const rows = templateRows(list);
  const duplicate = rows.find((row) =>
    row.name === MARUCHAN_ROAST_CHICKEN_TEMPLATE_NAME);
  if (duplicate) {
    process.stdout.write(`${JSON.stringify({
      status: "EXACT_TEMPLATE_ALREADY_EXISTS",
      template_id: duplicate.id,
      mutation_calls: 0,
      next_command: "stage-repair",
    })}\n`);
    return;
  }
  const defaultTemplate = rows.find((row) => row.type === "DEFAULT");
  if (!defaultTemplate || typeof defaultTemplate.id !== "string") {
    fail("INVALID_WALMART_RESPONSE", "default shipping template is missing");
  }
  const detailsResponse = await client.read({
    path: `/v3/settings/shipping/templates/${encodeURIComponent(defaultTemplate.id)}`,
    query: {},
    correlation_id: randomUUID(),
  });
  if (detailsResponse.status !== 200) {
    fail("WALMART_READ_FAILED", `default template returned ${detailsResponse.status}`);
  }
  const details = responseJson(detailsResponse, "default shipping template");
  const payload = buildMaruchanSoutheastShippingTemplate(details);
  const payloadBytes = canonicalBytes(payload);
  const times = newPlanTimes();
  const evidence = {
    baseline_manifest_body_sha256: baseline.body_sha256,
    shipping_template_list_response_sha256: sha256(listResponse.body),
    default_template_response_sha256: sha256(detailsResponse.body),
    template_payload_sha256: sha256(payloadBytes),
    southeast_shipping_evidence:
      "historical-residential-SWW-quote-matrix/AL-FL-GA-SC/2026-07-29",
  };
  const plan = buildWalmartListingFullSurfacePlan({
    plan_id: `maruchan-template-create-${times.created.replace(/\W/gu, "")}`,
    owner_decision_id: OWNER_DECISION.decision_id,
    owner_decision_sha256: ownerDecisionSha(),
    created_at: times.created,
    expires_at: times.expires,
    seller_account_fingerprint_sha256:
      client.account_binding.seller_account_fingerprint_sha256,
    product_truth_snapshot_sha256: PRODUCT_TRUTH_SNAPSHOT_SHA,
    exact_listings: exactListings(),
    operations: [{
      operation_id: "shipping-template-create",
      operation_kind: "SHIPPING_TEMPLATE_CREATE",
      exact_skus: MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS.map((row) => row.sku),
      request_payload_bytes: payloadBytes,
      content_type: "application/json",
      evidence_sha256: sha256(canonicalJson(evidence)),
      account_scope_receipt_sha256: String(baseline.body_sha256),
      baseline_state_sha256: sha256(canonicalJson(rows)),
      expected_state_sha256: sha256(canonicalJson(payload)),
      readback_minimum_delay_ms: 0,
      readback_maximum_wait_ms: 30 * 60 * 1_000,
    }],
  });
  await createPrivateDirectory(outputDir);
  const payloadFile = "payload-shipping-template-create.json";
  const bundleBody = {
    schema_version: BUNDLE_SCHEMA,
    bundle_kind: "SHIPPING_TEMPLATE_CREATE" as const,
    created_at: times.created,
    plan_file: "plan.json" as const,
    plan_body_sha256: plan.body_sha256,
    payload_files: { "shipping-template-create": payloadFile },
    baseline_manifest_body_sha256: String(baseline.body_sha256),
    assets_manifest_body_sha256: null,
    product_truth_snapshot_sha256: PRODUCT_TRUTH_SNAPSHOT_SHA,
  };
  const bundle: BundleManifest = {
    ...bundleBody,
    body_sha256: sha256(canonicalJson(bundleBody)),
  };
  await Promise.all([
    writeExclusive(path.join(outputDir, "plan.json"), canonicalBytes(plan)),
    writeExclusive(path.join(outputDir, payloadFile), payloadBytes),
    writeExclusive(
      path.join(outputDir, "shipping-template-list.response.json"),
      listResponse.body,
    ),
    writeExclusive(
      path.join(outputDir, "default-template.response.json"),
      detailsResponse.body,
    ),
    writeExclusive(path.join(outputDir, "bundle-manifest.json"), canonicalBytes(bundle)),
  ]);
  await openWalmartListingFullSurfaceLedger({
    directory: ledgerDir,
    ledger_id: "walmart-full-surface-production",
  });
  process.stdout.write(`${JSON.stringify({
    status: "TEMPLATE_CREATE_PLAN_STAGED",
    bundle_dir: outputDir,
    plan_body_sha256: plan.body_sha256,
    payload_sha256: sha256(payloadBytes),
    read_calls: client.counts(),
    next_command: "permit",
  })}\n`);
}

async function stageRepair(values: Map<string, string>): Promise<void> {
  const baselineDir = exactAbsolute(values.get("baseline-dir"), "--baseline-dir");
  const assetsDir = exactAbsolute(values.get("assets-dir"), "--assets-dir");
  const outputDir = exactAbsolute(values.get("output-dir"), "--output-dir");
  const templateId = values.get("template-id");
  if (!templateId?.trim()) {
    fail("INVALID_ARGUMENT", "--template-id is required");
  }
  const catalogClearanceReports = [];
  for (const row of MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS) {
    const suffix = row.sku.slice("FaisalX-".length);
    if (!values.has(`catalog-probe-${suffix}`)) {
      fail(
        "CATALOG_SUPPORT_CLEARANCE_REQUIRED",
        `${row.sku} needs a fresh sealed post-Support catalog probe`,
      );
    }
    const probePath = exactAbsolute(
      values.get(`catalog-probe-${suffix}`),
      `--catalog-probe-${suffix}`,
    );
    catalogClearanceReports.push(
      await readJson(probePath, `${row.sku} catalog clearance probe`),
    );
  }
  validateMaruchanCatalogClearanceReports(catalogClearanceReports);
  const { manifest: baseline, spec } = await loadBaseline(baselineDir);
  const assets = verifiedHashedArtifact(
    await readJson(path.join(assetsDir, "manifest.json"), "assets manifest"),
    "assets manifest",
  );
  if (!Array.isArray(assets.images) || assets.images.length !== 3) {
    fail("INVALID_ASSETS", "assets manifest must contain three images");
  }
  const main_image_urls = Object.fromEntries(assets.images.map((value) => {
    const row = record(value, "image row");
    return [String(row.sku), String(row.public_url)];
  })) as Record<(typeof MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS)[number]["sku"], string>;
  const source = record(assets.source, "asset source");
  const itemPayload = buildMaruchanRoastChickenItemPayload({
    main_image_urls,
    exact_carton_image_url: String(source.public_url),
  });
  validateMaruchanRoastChickenItemPayload({
    payload: itemPayload,
    get_spec_response: spec,
  });
  const associationPayload =
    buildMaruchanShippingAssociationPayload(templateId);
  const itemBytes = canonicalBytes(itemPayload);
  const associationBytes = canonicalBytes(associationPayload);
  const pricePayloads = Object.fromEntries(
    MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS.map((row) => [
      row.sku,
      buildMaruchanPricePayload(row),
    ]),
  );
  const times = newPlanTimes();
  const accountFingerprint =
    exactSha(baseline.seller_account_fingerprint_sha256, "seller fingerprint");
  const categoryReceipt = exactSha(
    baselineExchange(baseline, "item-spec").response_payload_sha256,
    "Get Spec response SHA",
  );
  const sharedEvidence = {
    baseline_manifest_body_sha256: baseline.body_sha256,
    assets_manifest_body_sha256: assets.body_sha256,
    product_truth_snapshot_sha256: PRODUCT_TRUTH_SNAPSHOT_SHA,
    shipping_template_id: templateId,
  };
  const operations = [
    {
      operation_id: "item-maintenance-three-sku",
      operation_kind: "ITEM_MAINTENANCE" as const,
      exact_skus: MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS.map((row) => row.sku),
      changed_item_facets: [
        "title",
        "description",
        "key_features",
        "main_image",
        "secondary_images",
        "category_attributes",
        "variant_relationship",
        "shipping_weight",
        "package_dimensions",
      ] as const,
      request_payload_bytes: itemBytes,
      content_type: "multipart/form-data" as const,
      evidence_sha256: sha256(canonicalJson({
        ...sharedEvidence,
        target_payload_sha256: sha256(itemBytes),
      })),
      account_scope_receipt_sha256: String(baseline.body_sha256),
      category_schema_receipt_sha256: categoryReceipt,
      baseline_state_sha256: sha256(canonicalJson(
        MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS.map((row) =>
          baselineExchange(baseline, `item-${row.sku}`).response_payload_sha256),
      )),
      expected_state_sha256: sha256(canonicalJson(itemPayload)),
      readback_minimum_delay_ms: 300_000,
      readback_maximum_wait_ms: 24 * 60 * 60 * 1_000,
    },
    {
      operation_id: "shipping-template-association-three-sku",
      operation_kind: "SHIPPING_TEMPLATE_ASSOCIATION" as const,
      exact_skus: MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS.map((row) => row.sku),
      request_payload_bytes: associationBytes,
      content_type: "multipart/form-data" as const,
      evidence_sha256: sha256(canonicalJson({
        ...sharedEvidence,
        target_payload_sha256: sha256(associationBytes),
      })),
      account_scope_receipt_sha256: String(baseline.body_sha256),
      baseline_state_sha256: sha256(canonicalJson(
        baselineExchange(baseline, "item-associations").response_payload_sha256,
      )),
      expected_state_sha256: sha256(canonicalJson(associationPayload)),
      readback_minimum_delay_ms: 0,
      readback_maximum_wait_ms: 4 * 60 * 60 * 1_000,
    },
    ...MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS.map((row) => {
      const payload = pricePayloads[row.sku]!;
      const bytes = canonicalBytes(payload);
      return {
        operation_id: `price-${row.sku}`,
        operation_kind: "PRICE" as const,
        exact_skus: [row.sku],
        request_payload_bytes: bytes,
        content_type: "application/json" as const,
        evidence_sha256: sha256(canonicalJson({
          ...sharedEvidence,
          sku: row.sku,
          goods_cost_cents: row.goods_cost_cents,
          packaging_cost_cents: row.packaging_cost_cents,
          southeast_shipping_label_cents: row.southeast_shipping_label_cents,
          target_payload_sha256: sha256(bytes),
        })),
        account_scope_receipt_sha256: String(baseline.body_sha256),
        baseline_state_sha256: sha256(canonicalJson(
          baselineExchange(baseline, `item-${row.sku}`).response_payload_sha256,
        )),
        expected_state_sha256: sha256(canonicalJson(payload)),
        readback_minimum_delay_ms: 0,
        readback_maximum_wait_ms: 30 * 60 * 1_000,
      };
    }),
  ];
  const plan = buildWalmartListingFullSurfacePlan({
    plan_id: `maruchan-repair-${times.created.replace(/\W/gu, "")}`,
    owner_decision_id: OWNER_DECISION.decision_id,
    owner_decision_sha256: ownerDecisionSha(),
    created_at: times.created,
    expires_at: times.expires,
    seller_account_fingerprint_sha256: accountFingerprint,
    product_truth_snapshot_sha256: PRODUCT_TRUTH_SNAPSHOT_SHA,
    exact_listings: exactListings(),
    operations,
  });
  await createPrivateDirectory(outputDir);
  const payloadFiles: Record<string, string> = {
    "item-maintenance-three-sku": "payload-item-maintenance-three-sku.json",
    "shipping-template-association-three-sku":
      "payload-shipping-template-association-three-sku.json",
    ...Object.fromEntries(MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS.map((row) => [
      `price-${row.sku}`,
      `payload-price-${row.sku}.json`,
    ])),
  };
  const bundleBody = {
    schema_version: BUNDLE_SCHEMA,
    bundle_kind: "MARUCHAN_REPAIR" as const,
    created_at: times.created,
    plan_file: "plan.json" as const,
    plan_body_sha256: plan.body_sha256,
    payload_files: payloadFiles,
    baseline_manifest_body_sha256: String(baseline.body_sha256),
    assets_manifest_body_sha256: String(assets.body_sha256),
    product_truth_snapshot_sha256: PRODUCT_TRUTH_SNAPSHOT_SHA,
  };
  const bundle: BundleManifest = {
    ...bundleBody,
    body_sha256: sha256(canonicalJson(bundleBody)),
  };
  await writeExclusive(path.join(outputDir, "plan.json"), canonicalBytes(plan));
  await writeExclusive(
    path.join(outputDir, payloadFiles["item-maintenance-three-sku"]!),
    itemBytes,
  );
  await writeExclusive(
    path.join(
      outputDir,
      payloadFiles["shipping-template-association-three-sku"]!,
    ),
    associationBytes,
  );
  for (const row of MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS) {
    await writeExclusive(
      path.join(outputDir, payloadFiles[`price-${row.sku}`]!),
      canonicalBytes(pricePayloads[row.sku]),
    );
  }
  await writeExclusive(
    path.join(outputDir, "bundle-manifest.json"),
    canonicalBytes(bundle),
  );
  process.stdout.write(`${JSON.stringify({
    status: "REPAIR_PLAN_STAGED_AND_SCHEMA_VALIDATED",
    bundle_dir: outputDir,
    plan_body_sha256: plan.body_sha256,
    operations: plan.operations.map((operation) => ({
      operation_id: operation.operation_id,
      operation_kind: operation.operation_kind,
      request_payload_sha256: operation.exact_request.request_payload_sha256,
    })),
    next_command: "permit",
  })}\n`);
}

function verifyPlan(value: JsonRecord): WalmartListingFullSurfacePlan {
  const plan = value as unknown as WalmartListingFullSurfacePlan;
  const body = withoutKey(plan, "body_sha256");
  if (walmartListingFullSurfaceSha256(body) !== plan.body_sha256) {
    fail("PLAN_HASH_MISMATCH", "plan body SHA-256 mismatch");
  }
  for (const operation of plan.operations) {
    const operationBody = withoutKey(operation, "body_sha256");
    if (
      walmartListingFullSurfaceSha256(operationBody)
      !== operation.body_sha256
    ) {
      fail("PLAN_HASH_MISMATCH", `${operation.operation_id} SHA-256 mismatch`);
    }
  }
  return plan;
}

async function loadBundle(directory: string): Promise<{
  manifest: BundleManifest;
  plan: WalmartListingFullSurfacePlan;
}> {
  const manifest = verifiedHashedArtifact(
    await readJson(path.join(directory, "bundle-manifest.json"), "bundle manifest"),
    "bundle manifest",
  ) as unknown as BundleManifest;
  if (manifest.schema_version !== BUNDLE_SCHEMA) {
    fail("INVALID_BUNDLE", "bundle schema is invalid");
  }
  const plan = verifyPlan(
    await readJson(path.join(directory, manifest.plan_file), "plan"),
  );
  if (plan.body_sha256 !== manifest.plan_body_sha256) {
    fail("INVALID_BUNDLE", "bundle plan binding mismatch");
  }
  return { manifest, plan };
}

function operationById(
  plan: WalmartListingFullSurfacePlan,
  operationId: string | undefined,
): WalmartListingFullSurfaceOperation {
  if (!operationId) fail("INVALID_ARGUMENT", "--operation-id is required");
  const operation = plan.operations.find((row) =>
    row.operation_id === operationId);
  if (!operation) fail("INVALID_ARGUMENT", "operation is outside the plan");
  return operation;
}

async function permit(values: Map<string, string>): Promise<void> {
  const bundleDir = exactAbsolute(values.get("bundle-dir"), "--bundle-dir");
  const ledgerDir = exactAbsolute(values.get("ledger-dir"), "--ledger-dir");
  const output = exactAbsolute(values.get("out"), "--out");
  const { manifest, plan } = await loadBundle(bundleDir);
  const operation = operationById(plan, values.get("operation-id"));
  const payloadFile = manifest.payload_files[operation.operation_id];
  if (!payloadFile) fail("INVALID_BUNDLE", "operation payload file is missing");
  const payload = await readStable(path.join(bundleDir, payloadFile), "payload");
  if (
    sha256(payload) !== operation.exact_request.request_payload_sha256
    || payload.byteLength !== operation.exact_request.request_byte_length
  ) {
    fail("PAYLOAD_HASH_MISMATCH", "payload differs from exact operation");
  }
  const ledger = await openWalmartListingFullSurfaceLedger({
    directory: ledgerDir,
    ledger_id: "walmart-full-surface-production",
  });
  const key = walmartOwnerControlProductionTrustedKeys().find((row) =>
    row.status === "ACTIVE" && row.environment === "PRODUCTION");
  if (!key) fail("TRUST_ROOT_MISSING", "active production owner key is missing");
  const issued = new Date();
  const signedBody: WalmartListingFullSurfacePermitSignedBody = {
    action: WALMART_LISTING_FULL_SURFACE_PERMIT_ACTION,
    environment: "PRODUCTION",
    permit_id:
      `${plan.plan_id}:${operation.operation_id}:${issued.getTime()}`,
    issued_at: issued.toISOString(),
    expires_at: new Date(issued.getTime() + 25 * 60 * 1_000).toISOString(),
    approved_by: OWNER_DECISION.approved_by,
    decision_ref: OWNER_DECISION.decision_ref,
    plan_schema_version: plan.schema_version,
    plan_id: plan.plan_id,
    plan_body_sha256: plan.body_sha256,
    operation_schema_version: operation.schema_version,
    operation_id: operation.operation_id,
    operation_body_sha256: operation.body_sha256,
    operation_kind: operation.operation_kind,
    exact_skus: operation.exact_skus,
    seller_account_fingerprint_sha256:
      plan.seller_account_fingerprint_sha256,
    evidence_sha256: operation.evidence_sha256,
    request_payload_sha256:
      operation.exact_request.request_payload_sha256,
    request_byte_length: operation.exact_request.request_byte_length,
    irreversible_owner_decision_sha256:
      operation.irreversible_owner_decision_sha256,
    consumption_ledger: ledger.binding,
    claims: {
      exact_operation_count: 1,
      marketplace_write_calls: 1,
      retry_allowed: false,
      automatic_replay_allowed: false,
      payload_substitution_allowed: false,
      account_substitution_allowed: false,
      stop_on_unknown_outcome: true,
    },
  };
  const envelope: WalmartListingFullSurfacePermitSigningEnvelope = {
    schema_version: WALMART_LISTING_FULL_SURFACE_PERMIT_SCHEMA,
    algorithm: WALMART_LISTING_FULL_SURFACE_PERMIT_ALGORITHM,
    key_id: key.key_id,
    owner_public_key_spki_sha256: key.public_key_spki_sha256,
    signed_body: signedBody,
  };
  const request = {
    schema_version: SIGNING_REQUEST_SCHEMA,
    action: WALMART_LISTING_FULL_SURFACE_PERMIT_ACTION,
    key_id: key.key_id,
    owner_public_key_spki_sha256: key.public_key_spki_sha256,
    permit_envelope: envelope,
    signing_message_base64:
      walmartListingFullSurfacePermitSigningMessage(envelope).toString("base64"),
  };
  const bytes = canonicalBytes(request);
  await writeExclusive(output, bytes);
  process.stdout.write(`${JSON.stringify({
    status: "SIGNING_REQUEST_STAGED",
    operation_id: operation.operation_id,
    request_path: output,
    request_sha256: sha256(bytes),
    permit_expires_at: signedBody.expires_at,
    next_command: "external-owner-sign",
  })}\n`);
}

function feedId(response: JsonRecord): string {
  const value = response.feedId ?? response.feed_id;
  if (typeof value !== "string" || !value.trim()) {
    fail("FEED_ID_MISSING", "accepted feed response has no feedId");
  }
  return value;
}

class WalmartFeedTerminalError extends Error {
  readonly code = "FEED_FAILED";

  constructor(
    readonly verdict: Extract<
      WalmartListingFullSurfaceFeedVerdict,
      { state: "FAILED" }
    >,
    readonly response_bytes: Uint8Array,
  ) {
    super(verdict.reason);
    this.name = "WalmartFeedTerminalError";
  }
}

function collectTemplateStates(
  details: JsonRecord,
  shipMethod?: string,
): string[] {
  if (!Array.isArray(details.shippingMethods)) return [];
  const states: string[] = [];
  for (const methodValue of details.shippingMethods) {
    const method = record(methodValue, "shipping method");
    if (shipMethod && method.shipMethod !== shipMethod) continue;
    if (!Array.isArray(method.configurations)) continue;
    for (const configValue of method.configurations) {
      const config = record(configValue, "shipping configuration");
      if (!Array.isArray(config.regions)) continue;
      for (const regionValue of config.regions) {
        const region = record(regionValue, "shipping region");
        if (Array.isArray(region.states)) {
          for (const stateValue of region.states) {
            const state = record(stateValue, "shipping state");
            if (typeof state.stateCode === "string") states.push(state.stateCode);
          }
        }
        if (!Array.isArray(region.subRegions)) continue;
        for (const subValue of region.subRegions) {
          const sub = record(subValue, "shipping subregion");
          if (!Array.isArray(sub.states)) continue;
          for (const stateValue of sub.states) {
            const state = record(stateValue, "shipping state");
            if (typeof state.stateCode === "string") states.push(state.stateCode);
          }
        }
      }
    }
  }
  return [...new Set(states)].sort();
}

function collectConfigurationStates(configuration: JsonRecord): string[] {
  return collectTemplateStates({
    shippingMethods: [{
      shipMethod: "TARGET",
      configurations: [configuration],
    }],
  });
}

function validateTemplateReadback(details: JsonRecord): void {
  if (!Array.isArray(details.shippingMethods)) {
    fail("READBACK_MISMATCH", "shipping methods are missing");
  }
  const methods = details.shippingMethods.map((value) =>
    record(value, "shipping method"));
  const standard = methods.find((method) => method.shipMethod === "STANDARD");
  if (
    !standard
    || !Array.isArray(standard.configurations)
    || standard.configurations.length !== 2
  ) {
    fail("READBACK_MISMATCH", "two STANDARD configurations are missing");
  }
  const configurations = standard.configurations.map((value) =>
    record(value, "STANDARD configuration"));
  const freeConfiguration = configurations.find((configuration) => {
    const charge = record(
      configuration.perShippingCharge,
      "STANDARD charge",
    );
    return charge.chargePerItem !== undefined;
  });
  const paidConfiguration = configurations.find((configuration) => {
    const charge = record(
      configuration.perShippingCharge,
      "STANDARD charge",
    );
    return charge.chargePerWeight !== undefined;
  });
  if (!freeConfiguration || !paidConfiguration) {
    fail("READBACK_MISMATCH", "free and paid STANDARD configurations are missing");
  }
  const freeCharge = record(
    freeConfiguration.perShippingCharge,
    "free STANDARD charge",
  );
  const paidCharge = record(
    paidConfiguration.perShippingCharge,
    "paid STANDARD charge",
  );
  const freeHandling = record(
    freeCharge.shippingAndHandling,
    "free STANDARD handling",
  );
  const freePerItem = record(
    freeCharge.chargePerItem,
    "free STANDARD per item",
  );
  const paidHandling = record(
    paidCharge.shippingAndHandling,
    "paid STANDARD handling",
  );
  const paidPerWeight = record(
    paidCharge.chargePerWeight,
    "paid STANDARD per weight",
  );
  const freeStates = collectConfigurationStates(freeConfiguration);
  const paidStates = collectConfigurationStates(paidConfiguration);
  if (
    details.name !== MARUCHAN_ROAST_CHICKEN_TEMPLATE_NAME
    || details.type !== "CUSTOM"
    || details.status !== "ACTIVE"
    || details.rateModelType !== "PER_SHIPMENT_PRICING"
    || canonicalJson(freeStates)
      !== canonicalJson([...MARUCHAN_ROAST_CHICKEN_SERVICE_STATES].sort())
    || paidStates.length !== 45
    || paidStates.some((state) =>
      MARUCHAN_ROAST_CHICKEN_SERVICE_STATES.includes(
        state as (typeof MARUCHAN_ROAST_CHICKEN_SERVICE_STATES)[number],
      ))
    || new Set([...freeStates, ...paidStates]).size !== 49
    || Number(freeConfiguration.transitTime) !== 4
    || Number(paidConfiguration.transitTime) !== 5
    || freeCharge.unitOfMeasure !== "LB"
    || Number(freeHandling.amount) !== 0
    || Number(freePerItem.amount) !== 0
    || paidCharge.unitOfMeasure !== "LB"
    || Number(paidHandling.amount) !== 0
    || Number(paidPerWeight.amount) * 100
      !== MARUCHAN_ROAST_CHICKEN_NATIONAL_RATE_PER_LB_CENTS
  ) {
    fail("READBACK_MISMATCH", "shipping template semantic readback differs");
  }
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function pollFeed(
  client: WalmartListingFullSurfaceOneShotTransport,
  operation: WalmartListingFullSurfaceOperation,
  exactFeedId: string,
): Promise<{
  verdict: WalmartListingFullSurfaceFeedVerdict;
  bytes: Uint8Array;
}> {
  let latest = new Uint8Array();
  for (let attempt = 0; attempt < FEED_POLL_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await wait(POLL_MS);
    const response = await client.read({
      path: `/v3/feeds/${encodeURIComponent(exactFeedId)}`,
      query: {
        includeDetails: "true",
        limit: "50",
        offset: "0",
      },
      correlation_id: randomUUID(),
    });
    if (response.status !== 200) {
      return {
        verdict: { state: "PENDING", reason: `FEED_HTTP_${response.status}` },
        bytes: response.body,
      };
    }
    latest = response.body;
    const verdict = evaluateWalmartListingFullSurfaceFeed(
      responseJson(response, "feed status"),
      exactFeedId,
      operation.exact_skus,
    );
    if (verdict.state !== "PENDING") return { verdict, bytes: latest };
  }
  return {
    verdict: { state: "PENDING", reason: "FEED_POLL_WINDOW_EXHAUSTED" },
    bytes: latest,
  };
}

async function readbackTemplate(
  client: WalmartListingFullSurfaceOneShotTransport,
): Promise<{ bytes: Buffer; template_id: string }> {
  const listResponse = await client.read({
    path: "/v3/settings/shipping/templates",
    query: {},
    correlation_id: randomUUID(),
  });
  if (listResponse.status !== 200) {
    fail("READBACK_FAILED", `template list returned ${listResponse.status}`);
  }
  const target = templateRows(responseJson(listResponse, "template list"))
    .find((row) => row.name === MARUCHAN_ROAST_CHICKEN_TEMPLATE_NAME);
  if (!target || typeof target.id !== "string") {
    fail("READBACK_FAILED", "new exact template is not present");
  }
  const detailsResponse = await client.read({
    path: `/v3/settings/shipping/templates/${encodeURIComponent(target.id)}`,
    query: {},
    correlation_id: randomUUID(),
  });
  if (detailsResponse.status !== 200) {
    fail("READBACK_FAILED", `template details returned ${detailsResponse.status}`);
  }
  const details = responseJson(detailsResponse, "template details");
  validateTemplateReadback(details);
  return {
    bytes: canonicalBytes({
      list_response_sha256: sha256(listResponse.body),
      details,
    }),
    template_id: target.id,
  };
}

async function readbackItems(
  client: WalmartListingFullSurfaceOneShotTransport,
): Promise<Buffer> {
  const rows: JsonRecord[] = [];
  for (const expected of MARUCHAN_ROAST_CHICKEN_REPAIR_ROWS) {
    const response = await client.read({
      path: `/v3/items/${encodeURIComponent(expected.sku)}`,
      query: {},
      correlation_id: randomUUID(),
    });
    if (response.status !== 200) {
      fail("READBACK_FAILED", `${expected.sku} item returned ${response.status}`);
    }
    const body = responseJson(response, `${expected.sku} item`);
    if (!Array.isArray(body.ItemResponse) || body.ItemResponse.length !== 1) {
      fail("READBACK_MISMATCH", `${expected.sku} item row is missing`);
    }
    const row = record(body.ItemResponse[0], `${expected.sku} item row`);
    const title = maruchanRoastChickenTitle(expected);
    if (
      row.sku !== expected.sku
      || row.productName !== title
      || row.variantGroupId !== "SPRCMAR00121QTY"
      || row.publishedStatus !== "PUBLISHED"
      || row.lifecycleStatus !== "ACTIVE"
    ) {
      fail("READBACK_MISMATCH", `${expected.sku} item identity differs`);
    }
    rows.push(row);
  }
  return canonicalBytes(rows);
}

async function readbackAssociation(
  client: WalmartListingFullSurfaceOneShotTransport,
  payload: JsonRecord,
): Promise<Buffer> {
  const targets = payload.ItemFeed;
  if (!Array.isArray(targets)) fail("INVALID_PAYLOAD", "ItemFeed is missing");
  const response = await client.semanticRead({
    path: "/v3/items/associations",
    request_payload_bytes: canonicalBytes({
      items: targets.map((value) => ({
        sku: record(value, "association target").sku,
      })),
    }),
    correlation_id: randomUUID(),
  });
  if (response.status !== 200) {
    fail("READBACK_FAILED", `association readback returned ${response.status}`);
  }
  const body = responseJson(response, "association readback");
  if (!Array.isArray(body.items)) {
    fail("READBACK_MISMATCH", "association items are missing");
  }
  for (const targetValue of targets) {
    const target = record(targetValue, "association target");
    const item = body.items.map((row) => record(row, "association item"))
      .find((row) => row.sku === target.sku);
    if (!item || !Array.isArray(item.associations)) {
      fail("READBACK_MISMATCH", `${String(target.sku)} association is missing`);
    }
    const match = item.associations.map((row) =>
      record(row, "association")).some((association) => {
      const template = record(association.shippingTemplate, "shippingTemplate");
      return template.id === target.shippingTemplateId
        && association.shipNode === target.fulfillmentCenterId;
    });
    if (!match) {
      fail("READBACK_MISMATCH", `${String(target.sku)} target mapping differs`);
    }
  }
  return Buffer.from(response.body);
}

async function readbackPrice(
  client: WalmartListingFullSurfaceOneShotTransport,
  payload: JsonRecord,
): Promise<Buffer> {
  const sku = String(payload.sku);
  const pricing = payload.pricing;
  if (!Array.isArray(pricing)) fail("INVALID_PAYLOAD", "pricing is missing");
  const target = Number(record(
    record(pricing[0], "pricing row").currentPrice,
    "current price",
  ).amount);
  let latest = new Uint8Array();
  for (let attempt = 0; attempt < READBACK_POLL_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await wait(POLL_MS);
    const response = await client.read({
      path: `/v3/items/${encodeURIComponent(sku)}`,
      query: {},
      correlation_id: randomUUID(),
    });
    latest = response.body;
    if (response.status !== 200) continue;
    const body = responseJson(response, `${sku} price readback`);
    if (!Array.isArray(body.ItemResponse) || body.ItemResponse.length !== 1) {
      continue;
    }
    const row = record(body.ItemResponse[0], `${sku} item row`);
    const price = record(row.price, `${sku} price`);
    if (
      row.sku === sku
      && price.currency === "USD"
      && Number(price.amount) === target
    ) {
      return Buffer.from(latest);
    }
  }
  fail("READBACK_FAILED", `${sku} price did not converge`);
}

async function exactReadback(input: {
  client: WalmartListingFullSurfaceOneShotTransport;
  operation: WalmartListingFullSurfaceOperation;
  payload: JsonRecord;
  feed_id: string | null;
}): Promise<{ bytes: Buffer; template_id?: string }> {
  let feedResponse: Uint8Array | null = null;
  if (input.feed_id) {
    const feed = await pollFeed(input.client, input.operation, input.feed_id);
    if (feed.verdict.state === "PENDING") {
      const error = new Error(feed.verdict.reason);
      (error as Error & { code: string }).code = "FEED_PENDING";
      throw error;
    }
    if (feed.verdict.state === "FAILED") {
      throw new WalmartFeedTerminalError(feed.verdict, feed.bytes);
    }
    feedResponse = feed.bytes;
  }
  let resourceReadback: { bytes: Buffer; template_id?: string };
  switch (input.operation.operation_kind) {
    case "SHIPPING_TEMPLATE_CREATE":
      resourceReadback = await readbackTemplate(input.client);
      break;
    case "ITEM_MAINTENANCE":
      resourceReadback = { bytes: await readbackItems(input.client) };
      break;
    case "SHIPPING_TEMPLATE_ASSOCIATION":
      resourceReadback = {
        bytes: await readbackAssociation(input.client, input.payload),
      };
      break;
    case "PRICE":
    case "PROMOTIONAL_PRICE":
      resourceReadback = {
        bytes: await readbackPrice(input.client, input.payload),
      };
      break;
    default:
      fail(
        "READBACK_NOT_IMPLEMENTED",
        `${input.operation.operation_kind} live readback is not certified`,
      );
  }
  if (!feedResponse) return resourceReadback;
  return {
    bytes: canonicalBytes({
      feed_terminal_response: parseJson(feedResponse, "terminal feed response"),
      resource_readback: parseJson(
        resourceReadback.bytes,
        "resource readback",
      ),
    }),
    template_id: resourceReadback.template_id,
  };
}

async function writeOutcome(input: {
  bundle_dir: string;
  plan: WalmartListingFullSurfacePlan;
  operation: WalmartListingFullSurfaceOperation;
  permit: WalmartListingFullSurfacePermit;
  terminal_sha256: string;
  attempted_at: string;
  outcome: WalmartListingFullSurfaceOutcome["outcome"];
  readback_sha256: string | null;
  diagnostic_sha256: string | null;
}): Promise<WalmartListingFullSurfaceOutcome> {
  const body = {
    schema_version: WALMART_LISTING_FULL_SURFACE_OUTCOME_SCHEMA,
    plan_body_sha256: input.plan.body_sha256,
    operation_id: input.operation.operation_id,
    operation_body_sha256: input.operation.body_sha256,
    request_payload_sha256:
      input.operation.exact_request.request_payload_sha256,
    permit_authorization_sha256: input.permit.authorization_sha256,
    consumption_ledger_sha256: input.terminal_sha256,
    attempted_at: input.attempted_at,
    outcome: input.outcome,
    marketplace_write_calls: 1 as const,
    readback_sha256: input.readback_sha256,
    diagnostic_sha256: input.diagnostic_sha256,
  };
  const outcome: WalmartListingFullSurfaceOutcome = {
    ...body,
    body_sha256: walmartListingFullSurfaceSha256(body),
  };
  await writeExclusive(
    path.join(input.bundle_dir, `outcome-${input.operation.operation_id}.json`),
    canonicalBytes(outcome),
  );
  return outcome;
}

async function execute(values: Map<string, string>): Promise<void> {
  const bundleDir = exactAbsolute(values.get("bundle-dir"), "--bundle-dir");
  const ledgerDir = exactAbsolute(values.get("ledger-dir"), "--ledger-dir");
  const permitPath = exactAbsolute(values.get("permit"), "--permit");
  const { manifest, plan } = await loadBundle(bundleDir);
  const operation = operationById(plan, values.get("operation-id"));
  const payloadFile = manifest.payload_files[operation.operation_id];
  const payloadBytes = await readStable(
    path.join(bundleDir, payloadFile!),
    "operation payload",
  );
  const payload = record(parseJson(payloadBytes, "operation payload"), "payload");
  const permitArtifact = await readJson(permitPath, "owner permit");
  const ownerPermit = permitArtifact as unknown as WalmartListingFullSurfacePermit;
  const ledger = await openWalmartListingFullSurfaceLedger({
    directory: ledgerDir,
    ledger_id: "walmart-full-surface-production",
  });
  verifyWalmartListingFullSurfacePermit({
    permit: ownerPermit,
    plan,
    operation,
    ledger_binding: ledger.binding,
  });
  const client = transport();
  if (
    client.account_binding.seller_account_fingerprint_sha256
    !== plan.seller_account_fingerprint_sha256
  ) {
    fail("ACCOUNT_MISMATCH", "runtime seller account differs from plan");
  }
  const attemptedAt = new Date().toISOString();
  await ledger.claim({
    authorization_sha256: ownerPermit.authorization_sha256,
    plan_body_sha256: plan.body_sha256,
    operation_id: operation.operation_id,
    operation_body_sha256: operation.body_sha256,
    request_payload_sha256: operation.exact_request.request_payload_sha256,
    request_byte_length: operation.exact_request.request_byte_length,
    seller_account_fingerprint_sha256:
      plan.seller_account_fingerprint_sha256,
  });
  const correlationId = randomUUID();
  await ledger.markRequesting({
    authorization_sha256: ownerPermit.authorization_sha256,
    request_manifest_sha256: sha256(canonicalJson({
      plan_body_sha256: plan.body_sha256,
      operation_body_sha256: operation.body_sha256,
      payload_sha256: sha256(payloadBytes),
    })),
    request_payload_sha256: operation.exact_request.request_payload_sha256,
    correlation_id: correlationId,
  });
  let response: WalmartListingFullSurfaceTransportResponse;
  try {
    response = await client.mutate({
      operation,
      request_payload_bytes: payloadBytes,
      correlation_id: correlationId,
    });
  } catch (error) {
    const terminal = await ledger.markTerminal({
      authorization_sha256: ownerPermit.authorization_sha256,
      state: "UNKNOWN",
      error_code: error instanceof WalmartListingFullSurfaceTransportError
        ? error.code
        : "MUTATION_OUTCOME_UNKNOWN",
    });
    await writeOutcome({
      bundle_dir: bundleDir,
      plan,
      operation,
      permit: ownerPermit,
      terminal_sha256: terminal.terminal_artifact_sha256,
      attempted_at: attemptedAt,
      outcome: "UNKNOWN",
      readback_sha256: null,
      diagnostic_sha256: null,
    });
    throw error;
  }
  await writeExclusive(
    path.join(bundleDir, `response-${operation.operation_id}.bin`),
    response.body,
  );
  const headersSha = sha256(canonicalJson(response.headers));
  const responseSha = sha256(response.body);
  if (response.status < 200 || response.status > 299) {
    const terminal = await ledger.markTerminal({
      authorization_sha256: ownerPermit.authorization_sha256,
      state: "DEFINITELY_REJECTED",
      response_http_status: response.status,
      response_headers_sha256: headersSha,
      response_payload_sha256: responseSha,
      error_code: `HTTP_${response.status}`,
    });
    await writeOutcome({
      bundle_dir: bundleDir,
      plan,
      operation,
      permit: ownerPermit,
      terminal_sha256: terminal.terminal_artifact_sha256,
      attempted_at: attemptedAt,
      outcome: "DEFINITELY_REJECTED",
      readback_sha256: null,
      diagnostic_sha256: null,
    });
    fail("MUTATION_REJECTED", `Walmart returned HTTP ${response.status}`);
  }
  const needsFeed = operation.exact_request.query.feedType !== undefined;
  const exactFeedId = needsFeed
    ? feedId(responseJson(response, "accepted feed response"))
    : null;
  await ledger.markAccepted({
    authorization_sha256: ownerPermit.authorization_sha256,
    response_http_status: response.status,
    response_headers_sha256: headersSha,
    response_payload_sha256: responseSha,
    walmart_feed_id: exactFeedId,
  });
  let readback;
  try {
    readback = await exactReadback({
      client,
      operation,
      payload,
      feed_id: exactFeedId,
    });
  } catch (error) {
    if ((error as Error & { code?: string }).code === "FEED_PENDING") {
      process.stdout.write(`${JSON.stringify({
        status: "ACCEPTED_FEED_PENDING",
        operation_id: operation.operation_id,
        feed_id: exactFeedId,
        marketplace_write_calls: 1,
        mutation_replay_allowed: false,
        next_command: "resume",
      })}\n`);
      return;
    }
    let diagnosticSha: string | null = null;
    if (error instanceof WalmartFeedTerminalError) {
      const diagnosticPath = path.join(
        bundleDir,
        `diagnostic-${operation.operation_id}.bin`,
      );
      await writeExclusive(diagnosticPath, error.response_bytes);
      diagnosticSha = sha256(error.response_bytes);
    }
    const terminal = await ledger.markTerminal({
      authorization_sha256: ownerPermit.authorization_sha256,
      state: "READBACK_FAILED",
      response_http_status: response.status,
      response_headers_sha256: headersSha,
      response_payload_sha256: responseSha,
      error_code: (error as Error & { code?: string }).code
        ?? "READBACK_FAILED",
    });
    await writeOutcome({
      bundle_dir: bundleDir,
      plan,
      operation,
      permit: ownerPermit,
      terminal_sha256: terminal.terminal_artifact_sha256,
      attempted_at: attemptedAt,
      outcome: "READBACK_FAILED",
      readback_sha256: null,
      diagnostic_sha256: diagnosticSha,
    });
    throw error;
  }
  const readbackSha = sha256(readback.bytes);
  await writeExclusive(
    path.join(bundleDir, `readback-${operation.operation_id}.json`),
    readback.bytes,
  );
  const terminal = await ledger.markTerminal({
    authorization_sha256: ownerPermit.authorization_sha256,
    state: "SUCCEEDED_AND_READ_BACK",
    response_http_status: response.status,
    response_headers_sha256: headersSha,
    response_payload_sha256: responseSha,
    readback_sha256: readbackSha,
  });
  const outcome = await writeOutcome({
    bundle_dir: bundleDir,
    plan,
    operation,
    permit: ownerPermit,
    terminal_sha256: terminal.terminal_artifact_sha256,
    attempted_at: attemptedAt,
    outcome: "SUCCEEDED_AND_READ_BACK",
    readback_sha256: readbackSha,
    diagnostic_sha256: null,
  });
  process.stdout.write(`${JSON.stringify({
    status: "OPERATION_SUCCEEDED_AND_READ_BACK",
    operation_id: operation.operation_id,
    operation_kind: operation.operation_kind,
    template_id: readback.template_id ?? null,
    feed_id: exactFeedId,
    outcome_body_sha256: outcome.body_sha256,
    transport_counts: client.counts(),
    next_command: null,
  })}\n`);
}

async function resume(values: Map<string, string>): Promise<void> {
  const bundleDir = exactAbsolute(values.get("bundle-dir"), "--bundle-dir");
  const ledgerDir = exactAbsolute(values.get("ledger-dir"), "--ledger-dir");
  const permitPath = exactAbsolute(values.get("permit"), "--permit");
  const { manifest, plan } = await loadBundle(bundleDir);
  const operation = operationById(plan, values.get("operation-id"));
  const payloadBytes = await readStable(
    path.join(bundleDir, manifest.payload_files[operation.operation_id]!),
    "operation payload",
  );
  const payload = record(parseJson(payloadBytes, "payload"), "payload");
  const ownerPermit = await readJson(
    permitPath,
    "owner permit",
  ) as unknown as WalmartListingFullSurfacePermit;
  const ledger = await openWalmartListingFullSurfaceLedger({
    directory: ledgerDir,
    ledger_id: "walmart-full-surface-production",
  });
  const inspection = await ledger.inspect(ownerPermit.authorization_sha256);
  if (inspection.state !== "ACCEPTED") {
    fail("INVALID_RESUME", "resume requires ACCEPTED ledger state");
  }
  const client = transport();
  if (
    client.account_binding.seller_account_fingerprint_sha256
    !== plan.seller_account_fingerprint_sha256
  ) {
    fail("ACCOUNT_MISMATCH", "runtime seller account differs from plan");
  }
  let readback;
  try {
    readback = await exactReadback({
      client,
      operation,
      payload,
      feed_id: inspection.walmart_feed_id,
    });
  } catch (error) {
    if ((error as Error & { code?: string }).code === "FEED_PENDING") {
      process.stdout.write(`${JSON.stringify({
        status: "ACCEPTED_FEED_STILL_PENDING",
        operation_id: operation.operation_id,
        feed_id: inspection.walmart_feed_id,
        marketplace_write_calls: 0,
        next_command: "resume",
      })}\n`);
      return;
    }
    let diagnosticSha: string | null = null;
    if (error instanceof WalmartFeedTerminalError) {
      const diagnosticPath = path.join(
        bundleDir,
        `diagnostic-${operation.operation_id}.bin`,
      );
      await writeExclusive(diagnosticPath, error.response_bytes);
      diagnosticSha = sha256(error.response_bytes);
    }
    const terminal = await ledger.markTerminal({
      authorization_sha256: ownerPermit.authorization_sha256,
      state: "READBACK_FAILED",
      error_code: (error as Error & { code?: string }).code
        ?? "READBACK_FAILED",
    });
    await writeOutcome({
      bundle_dir: bundleDir,
      plan,
      operation,
      permit: ownerPermit,
      terminal_sha256: terminal.terminal_artifact_sha256,
      attempted_at: ownerPermit.signed_body.issued_at,
      outcome: "READBACK_FAILED",
      readback_sha256: null,
      diagnostic_sha256: diagnosticSha,
    });
    throw error;
  }
  const readbackSha = sha256(readback.bytes);
  await writeExclusive(
    path.join(bundleDir, `readback-${operation.operation_id}.json`),
    readback.bytes,
  );
  const terminal = await ledger.markTerminal({
    authorization_sha256: ownerPermit.authorization_sha256,
    state: "SUCCEEDED_AND_READ_BACK",
    readback_sha256: readbackSha,
  });
  const outcome = await writeOutcome({
    bundle_dir: bundleDir,
    plan,
    operation,
    permit: ownerPermit,
    terminal_sha256: terminal.terminal_artifact_sha256,
    attempted_at: ownerPermit.signed_body.issued_at,
    outcome: "SUCCEEDED_AND_READ_BACK",
    readback_sha256: readbackSha,
    diagnostic_sha256: null,
  });
  process.stdout.write(`${JSON.stringify({
    status: "RESUME_SUCCEEDED_AND_READ_BACK",
    operation_id: operation.operation_id,
    template_id: readback.template_id ?? null,
    feed_id: inspection.walmart_feed_id,
    marketplace_write_calls: 0,
    outcome_body_sha256: outcome.body_sha256,
    next_command: null,
  })}\n`);
}

async function main(): Promise<void> {
  const { command, values } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "stage-template":
      return stageTemplate(values);
    case "stage-repair":
      return stageRepair(values);
    case "permit":
      return permit(values);
    case "execute":
      return execute(values);
    case "resume":
      return resume(values);
    default:
      fail("INVALID_ARGUMENT", `unknown command: ${command}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
