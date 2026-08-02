import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
} from "node:fs/promises";
import path from "node:path";

import type { SealedWalmartBuyerSnapshot } from "./buyer-facing-snapshot";
import { resolveExactBuyerPdp } from "./buyer-facing-snapshot";
import { preprocessCatalogVisual } from "./catalog-visual-preprocess";
import { resolveExactWalmartItemCandidate } from "./exact-item-resolution";
import {
  walmartListingIntegritySha256,
} from "./listing-integrity-audit";
import {
  classifyWalmartSingleDiagnostic,
  diagnoseWalmartSingleListing,
  projectProductTruthForWalmartSingleListing,
} from "./listing-integrity-single-pipeline";
import {
  compileWalmartListingDeclaredConsistency,
} from "./listing-integrity-declared-consistency";
import {
  WALMART_LISTING_SINGLE_INTAKE_INDEX_SCHEMA,
  type SealedWalmartListingSingleIntakeIndex,
} from "./listing-integrity-single-intake";
import {
  buildWalmartListingSingleObserverPlan,
  buildWalmartListingSingleObserverRequest,
  verifyWalmartListingSingleWorkerHealth,
  verifyWalmartListingSingleWorkerResponse,
  type WalmartListingSingleObserverPlan,
} from "./listing-integrity-single-observer";
import type { ProductTruthSnapshot } from "../sourcing/product-truth-read-contract";

export const WALMART_LISTING_CLEAN_QUALIFICATION_SCHEMA =
  "walmart-listing-integrity-clean-qualification/v1" as const;
export const WALMART_LISTING_NO_CHANGE_VERIFICATION_SCHEMA =
  "walmart-listing-integrity-no-change-verification/v1" as const;

const MAX_JSON_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(`WALMART_LISTING_CLEAN_QUALIFICATION_INVALID: ${message}`);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be one object`);
  }
  return value as JsonRecord;
}

function exactSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail(`${label} must be lowercase SHA-256`);
  }
  return value;
}

function exactText(value: unknown, label: string, maximum = 10_000): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be bounded exact text`);
  }
  return value;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return walmartListingIntegritySha256(left) === walmartListingIntegritySha256(right);
}

async function privateDirectory(value: string, label: string): Promise<string> {
  const resolved = path.resolve(value);
  if (resolved !== value || resolved === path.parse(resolved).root) {
    fail(`${label} must be an absolute normalized non-root path`);
  }
  const stat = await lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || await realpath(resolved) !== resolved) {
    fail(`${label} must be one private canonical directory`);
  }
  return resolved;
}

async function exactFile(root: string, relative: string, label: string): Promise<Buffer> {
  if (!relative || path.isAbsolute(relative) || relative.includes("\u0000")) {
    fail(`${label} path must be relative`);
  }
  const resolved = path.resolve(root, relative);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    fail(`${label} escapes its evidence root`);
  }
  const stat = await lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.size < 1 || stat.size > MAX_TOTAL_BYTES) {
    fail(`${label} must be one bounded regular file`);
  }
  const real = await realpath(resolved);
  if (path.relative(root, real).startsWith("..")) fail(`${label} real path escapes custody`);
  return readFile(resolved);
}

async function exactJsonFile(
  root: string,
  relative: string,
  label: string,
): Promise<{ bytes: Buffer; value: JsonRecord; file_sha256: string }> {
  const bytes = await exactFile(root, relative, label);
  if (bytes.length > MAX_JSON_BYTES) fail(`${label} exceeds JSON bound`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  } catch {
    return fail(`${label} is not UTF-8 JSON`);
  }
  return { bytes, value: record(parsed, label), file_sha256: sha256(bytes) };
}

function verifySeal(value: JsonRecord, label: string): void {
  const body = { ...value };
  delete body.body_sha256;
  if (value.body_sha256 !== walmartListingIntegritySha256(body)) {
    fail(`${label} body SHA differs`);
  }
}

function fileByRole(index: SealedWalmartListingSingleIntakeIndex, role: string) {
  const rows = index.files.filter((entry) => entry.role === role);
  if (rows.length !== 1) fail(`intake must contain exactly one ${role}`);
  return rows[0]!;
}

function escaped(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderHtml(input: {
  verification: JsonRecord;
  snapshot: SealedWalmartBuyerSnapshot;
  buyer_pdp: JsonRecord;
}): string {
  const listing = record(input.verification.listing, "verification.listing");
  const product = record(input.buyer_pdp.product, "buyer PDP product");
  const bullets = Array.isArray(product.feature_bullets) ? product.feature_bullets : [];
  const cards = input.snapshot.assets.map((asset) => `
    <section class="pair">
      <div class="card before"><b>ДО · ${escaped(asset.slot)}</b><img src="${escaped(asset.source_url)}"><code>${escaped(asset.sha256)}</code></div>
      <div class="arrow">→</div>
      <div class="card after"><b>ПОСЛЕ · БЕЗ ИЗМЕНЕНИЙ</b><img src="${escaped(asset.source_url)}"><code>${escaped(asset.sha256)}</code></div>
    </section>`).join("");
  const checks = Object.entries(record(input.verification.checks, "verification.checks"))
    .map(([name, value]) => `<li>${value === true ? "✓" : "✗"} ${escaped(name)}</li>`)
    .join("");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escaped(listing.sku)} · Walmart Listing Integrity · без изменений</title><style>
  body{font-family:Inter,Arial,sans-serif;background:#f4f7fb;color:#172033;margin:0}.page{max-width:1320px;margin:auto;padding:30px}
  .pass{background:#e8f7ee;border:1px solid #93d2aa;padding:18px;border-radius:14px}.pair{display:grid;grid-template-columns:1fr 40px 1fr;gap:12px;align-items:center;margin:20px 0}
  .card,.text{background:#fff;border:1px solid #dce3ee;border-radius:14px;padding:18px}.before{border-color:#f2b4ad}.after{border-color:#9fd6b2}.arrow{text-align:center;font-size:30px;color:#0b67d0}
  img{width:100%;height:330px;object-fit:contain}code{display:block;overflow-wrap:anywhere;font-size:11px;color:#607086;margin-top:10px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}li{margin:6px 0;color:#176b37}@media(max-width:850px){.pair,.grid{grid-template-columns:1fr}.arrow{transform:rotate(90deg)}}
  </style></head><body><main class="page"><h1>${escaped(listing.sku)} · фактическое ДО → ПОСЛЕ</h1>
  <p>Walmart item ${escaped(listing.item_id)} · source-aware Qualification без Walmart write</p>
  <div class="pass"><b>QUALIFICATION PASS · ИСПРАВЛЕНИЕ НЕ ТРЕБУЕТСЯ</b><br>Товар, количество, текст, атрибуты, MAIN и gallery уже соответствуют Product Truth.</div>
  <h2>Изображения</h2>${cards}<h2>Текст</h2><div class="grid"><div class="text"><b>ДО</b><h3>${escaped(product.title)}</h3><p>${escaped(product.description)}</p><ul>${bullets.map((row) => `<li>${escaped(row)}</li>`).join("")}</ul></div>
  <div class="text"><b>ПОСЛЕ · БЕЗ ИЗМЕНЕНИЙ</b><h3>${escaped(product.title)}</h3><p>${escaped(product.description)}</p><ul>${bullets.map((row) => `<li>${escaped(row)}</li>`).join("")}</ul></div></div>
  <h2>Qualification checks</h2><div class="text"><ul>${checks}</ul></div></main></body></html>`;
}

async function writeExclusive(file: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(file, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function qualifyWalmartListingIntegrityCleanCandidate(input: {
  intake_dir: string;
  observation_dir: string;
  diagnosis_path: string;
  output_dir: string;
  expected_listing_key: string;
  expected_product_truth_manifest_sha256: string;
  observer_trust?: { key_id: string; public_key_spki_sha256: string };
  now?: Date;
}) {
  const expectedManifest = exactSha(
    input.expected_product_truth_manifest_sha256,
    "expected Product Truth manifest",
  );
  const intakeRoot = await privateDirectory(input.intake_dir, "intake_dir");
  const observationRoot = await privateDirectory(input.observation_dir, "observation_dir");
  const diagnosisRoot = await privateDirectory(path.dirname(input.diagnosis_path), "diagnosis root");
  if (path.resolve(input.diagnosis_path) !== input.diagnosis_path
    || path.dirname(input.diagnosis_path) !== diagnosisRoot) {
    fail("diagnosis_path must be one exact file in its private case root");
  }

  const intakeArtifact = await exactJsonFile(intakeRoot, "intake-index.json", "intake index");
  const index = intakeArtifact.value as unknown as SealedWalmartListingSingleIntakeIndex;
  verifySeal(intakeArtifact.value, "intake index");
  if (index.schema_version !== WALMART_LISTING_SINGLE_INTAKE_INDEX_SCHEMA
    || index.status !== "CAPTURED"
    || index.listing_key !== input.expected_listing_key
    || index.product_truth_manifest_sha256 !== expectedManifest) {
    fail("intake is not one manifest-bound exact CAPTURED listing");
  }
  const seenPaths = new Set<string>();
  let totalBytes = 0;
  const intakeBytes = new Map<string, Buffer>();
  for (const file of index.files) {
    if (seenPaths.has(file.path)) fail("intake contains duplicate file paths");
    seenPaths.add(file.path);
    const bytes = await exactFile(intakeRoot, file.path, `intake ${file.role}`);
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES || bytes.length !== file.bytes
      || sha256(bytes) !== file.file_sha256) {
      fail(`${file.role} differs from the sealed intake index`);
    }
    intakeBytes.set(file.path, bytes);
  }

  const parseRole = <T>(role: string): T => {
    const ref = fileByRole(index, role);
    return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(intakeBytes.get(ref.path)!)) as T;
  };
  const productTruth = parseRole<ProductTruthSnapshot>("product_truth");
  const truth = projectProductTruthForWalmartSingleListing(productTruth);
  if (truth.status !== "READY" || truth.listing_key !== index.listing_key) {
    fail("manifest-bound Product Truth is not READY for the exact listing");
  }
  const sellerPayload = parseRole<unknown>("seller_item_payload");
  const catalogPayload = parseRole<unknown>("catalog_search_payload");
  const buyerPdp = parseRole<JsonRecord>("buyer_pdp_payload");
  const exactResolution = parseRole<unknown>("exact_resolution");
  const snapshot = parseRole<SealedWalmartBuyerSnapshot>("buyer_snapshot_manifest");
  const rebuiltResolution = resolveExactWalmartItemCandidate(
    productTruth.snapshot.sku,
    sellerPayload,
    catalogPayload,
  );
  if (!canonicalEqual(rebuiltResolution, exactResolution)
    || !canonicalEqual(snapshot.identity.seller, rebuiltResolution.seller)
    || !canonicalEqual(
      snapshot.identity.catalog_search_candidate,
      rebuiltResolution.catalog_search_candidate,
    )) {
    fail("seller/catalog identity chain does not independently rebuild");
  }
  const snapshotBody = { ...snapshot } as JsonRecord;
  delete snapshotBody.snapshot_id;
  delete snapshotBody.body_sha256;
  if (snapshot.body_sha256 !== walmartListingIntegritySha256(snapshotBody)
    || !snapshot.snapshot_id.endsWith(`-${snapshot.body_sha256.slice(0, 12)}`)
    || snapshot.target.sku !== productTruth.snapshot.sku) {
    fail("buyer snapshot identity or body seal differs");
  }
  const rebuiltBuyer = resolveExactBuyerPdp(buyerPdp, snapshot.target);
  if (rebuiltBuyer.item_id !== snapshot.identity.buyer.item_id
    || rebuiltBuyer.title !== snapshot.identity.buyer.title
    || !canonicalEqual(rebuiltBuyer.identity_evidence, snapshot.identity.buyer.identity_evidence)
    || snapshot.payload_hashes.seller_payload_canonical_sha256
      !== walmartListingIntegritySha256(sellerPayload)
    || snapshot.payload_hashes.catalog_search_payload_canonical_sha256
      !== walmartListingIntegritySha256(catalogPayload)
    || snapshot.payload_hashes.resolution_canonical_sha256
      !== walmartListingIntegritySha256(rebuiltResolution)
    || snapshot.payload_hashes.buyer_payload_canonical_sha256
      !== walmartListingIntegritySha256(buyerPdp)) {
    fail("buyer PDP and raw payload hashes do not rebuild the snapshot");
  }
  const rawImageUrls = [rebuiltBuyer.main_image_url, ...rebuiltBuyer.gallery_image_urls];
  if (rawImageUrls.length !== snapshot.assets.length
    || rawImageUrls.some((url, indexValue) => url !== snapshot.assets[indexValue]?.source_url)) {
    fail("buyer image population differs from the exact PDP");
  }
  const imageBytes = new Map<string, Uint8Array>();
  for (const [assetIndex, asset] of snapshot.assets.entries()) {
    const role = assetIndex === 0 ? "buyer_image_main" : `buyer_image_gallery_${assetIndex}`;
    const ref = fileByRole(index, role);
    const bytes = intakeBytes.get(ref.path)!;
    if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256) {
      fail(`${asset.slot} exact bytes differ from buyer snapshot`);
    }
    imageBytes.set(asset.sha256, new Uint8Array(bytes));
  }

  const planArtifact = await exactJsonFile(observationRoot, "observer-plan.json", "observer plan");
  const plan = planArtifact.value as unknown as WalmartListingSingleObserverPlan;
  verifySeal(planArtifact.value, "observer plan");
  if (plan.listing_key !== index.listing_key
    || plan.intake_index_file_sha256 !== intakeArtifact.file_sha256
    || plan.intake_index_body_sha256 !== index.body_sha256) {
    fail("observer plan differs from the exact intake");
  }
  const prepared = [];
  const modelBytesByPath = new Map<string, Buffer>();
  for (const [assetIndex, planned] of plan.assets.entries()) {
    const snapshotAsset = snapshot.assets[assetIndex];
    const source = snapshotAsset ? imageBytes.get(snapshotAsset.sha256) : null;
    if (!snapshotAsset || !source || planned.source_asset_sha256 !== snapshotAsset.sha256) {
      fail("observer source asset population differs from buyer snapshot");
    }
    const processed = await preprocessCatalogVisual(Buffer.from(source), {
      full_max_edge: 1600,
      crop_max_edge: 1800,
      analysis_max_edge: 512,
      max_crop_upscale: 2,
      limit_input_pixels: 40_000_000,
    });
    const full = processed.views.find((view) => view.role === "full");
    if (!full) fail(`${planned.slot}: deterministic full view is missing`);
    const modelBytes = await exactFile(
      observationRoot,
      planned.model_asset.path,
      `${planned.slot} model asset`,
    );
    if (sha256(modelBytes) !== full.sha256
      || planned.model_asset.sha256 !== full.sha256
      || planned.model_asset.bytes !== modelBytes.length
      || planned.model_asset.width !== full.width
      || planned.model_asset.height !== full.height) {
      fail(`${planned.slot}: model view does not rebuild from source pixels`);
    }
    modelBytesByPath.set(planned.model_asset.path, modelBytes);
    prepared.push({
      slot: planned.slot,
      source_asset_sha256: planned.source_asset_sha256,
      model_asset: { ...planned.model_asset },
    });
  }
  const rebuiltPlan = buildWalmartListingSingleObserverPlan({
    created_at: plan.created_at,
    listing_key: plan.listing_key,
    item_id: plan.item_id,
    intake_index_file_sha256: plan.intake_index_file_sha256,
    intake_index_body_sha256: plan.intake_index_body_sha256,
    prepared_assets: prepared,
    worker_contract: plan.worker_contract,
  });
  if (!canonicalEqual(rebuiltPlan, plan)) fail("observer plan does not exactly rebuild");
  const healthArtifact = await exactJsonFile(observationRoot, "worker-health.json", "worker health");
  verifyWalmartListingSingleWorkerHealth(
    healthArtifact.value,
    plan.worker_contract,
    input.observer_trust,
  );
  const executionArtifact = await exactJsonFile(
    observationRoot,
    "execution-index.json",
    "observer execution index",
  );
  verifySeal(executionArtifact.value, "observer execution index");
  const execution = executionArtifact.value;
  const executionPolicy = record(execution.execution, "observer execution policy");
  if (execution.listing_key !== index.listing_key
    || execution.observer_plan_file_sha256 !== planArtifact.file_sha256
    || execution.observer_plan_body_sha256 !== plan.body_sha256
    || execution.worker_health_file_sha256 !== healthArtifact.file_sha256
    || executionPolicy.retries !== 0
    || executionPolicy.fallbacks !== 0
    || executionPolicy.paid_api_calls !== 0
    || executionPolicy.walmart_writes !== 0) {
    fail("observer execution index violates the exact no-retry/no-write plan");
  }
  const executionCalls = Array.isArray(execution.calls) ? execution.calls : [];
  if (executionCalls.length !== plan.calls.length) fail("observer call coverage is incomplete");
  const verifiedObservations = [];
  for (const call of plan.calls) {
    const modelBytes = call.model_asset_paths.map((relative) => {
      const bytes = modelBytesByPath.get(relative);
      if (!bytes) fail(`observer model asset missing: ${relative}`);
      return bytes;
    });
    const request = buildWalmartListingSingleObserverRequest(plan, call.call_index, modelBytes);
    const prefix = `call-${String(call.call_index).padStart(2, "0")}`;
    const requestBytes = await exactFile(observationRoot, `${prefix}-request.json`, "observer request");
    if (!requestBytes.equals(Buffer.from(request.body, "utf8"))) {
      fail(`observer call ${call.call_index} request bytes differ`);
    }
    const responseBytes = await exactFile(
      observationRoot,
      `${prefix}-response.json`,
      "observer response",
    );
    const callRow = record(executionCalls[call.call_index], `execution call ${call.call_index}`);
    if (callRow.call_key !== call.call_key
      || callRow.request_file_sha256 !== sha256(requestBytes)
      || callRow.response_file_sha256 !== sha256(responseBytes)
      || callRow.subscription_calls_consumed !== 1
      || callRow.transport_attempts !== 1
      || callRow.retries !== 0) {
      fail(`observer call ${call.call_index} custody differs`);
    }
    const verified = verifyWalmartListingSingleWorkerResponse({
      plan,
      call_index: call.call_index,
      request: request.value,
      http_status: 200,
      response: JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(responseBytes)),
      trust: input.observer_trust,
    });
    verifiedObservations.push(...verified.observations);
  }
  const observationsArtifact = await exactJsonFile(
    observationRoot,
    "observations.json",
    "observations",
  );
  if (execution.observations_file_sha256 !== observationsArtifact.file_sha256
    || !canonicalEqual(observationsArtifact.value, {
      schema_version: "wm_visual_observation_batch/v3",
      observations: verifiedObservations,
    })) {
    fail("observations do not rebuild from signed worker responses");
  }

  const diagnosisArtifact = await exactJsonFile(
    diagnosisRoot,
    path.basename(input.diagnosis_path),
    "diagnosis",
  );
  verifySeal(diagnosisArtifact.value, "diagnosis");
  const diagnostic = await diagnoseWalmartSingleListing({
    product_truth: productTruth,
    buyer_snapshot: snapshot,
    buyer_pdp_payload: buyerPdp,
    image_bytes_by_sha256: imageBytes,
    blind_observations: verifiedObservations,
  });
  const outcome = classifyWalmartSingleDiagnostic(diagnostic);
  if (outcome.status !== "CLEAN_CANDIDATE" || diagnostic.status !== "DIAGNOSED") {
    fail("source-aware rebuild is not a clean candidate");
  }
  const declaredConsistency = compileWalmartListingDeclaredConsistency({
    listing_key: productTruth.snapshot.listingKey,
    buyer_snapshot: snapshot,
    buyer_pdp_payload: buyerPdp,
    blind_observations: verifiedObservations,
  });
  const diagnosisInputs = record(diagnosisArtifact.value.inputs, "diagnosis inputs");
  if (diagnosisArtifact.value.listing_key !== index.listing_key
    || diagnosisInputs.product_truth_file_sha256 !== fileByRole(index, "product_truth").file_sha256
    || diagnosisInputs.buyer_snapshot_file_sha256
      !== fileByRole(index, "buyer_snapshot_manifest").file_sha256
    || diagnosisInputs.buyer_pdp_file_sha256 !== fileByRole(index, "buyer_pdp_payload").file_sha256
    || diagnosisInputs.observations_file_sha256 !== observationsArtifact.file_sha256
    || !canonicalEqual(diagnosisArtifact.value.declared_consistency, declaredConsistency)
    || !canonicalEqual(diagnosisArtifact.value.detector_input, diagnostic.detector_input)
    || !canonicalEqual(diagnosisArtifact.value.detector_report, diagnostic.report)) {
    fail("diagnosis does not rebuild from exact verified sources");
  }
  const detectorReport = diagnostic.report;
  const checks = {
    product_truth_manifest_exact: true,
    intake_index_sealed: true,
    intake_file_population_verified: true,
    exact_listing_identity_verified: true,
    product_truth_ready: true,
    seller_catalog_chain_rebuilt: true,
    buyer_snapshot_sealed: true,
    buyer_pdp_identity_rebuilt: true,
    published_status_preserved: snapshot.identity.seller.published_status === "PUBLISHED",
    lifecycle_status_preserved: snapshot.identity.seller.lifecycle_status === "ACTIVE",
    all_image_bytes_verified: imageBytes.size === snapshot.assets.length,
    observer_plan_rebuilt: true,
    signed_observer_receipts_verified: true,
    diagnosis_rebuilt: true,
    title_description_bullets_attributes_pass: detectorReport.text_decision.verdict === "PASS",
    main_pass: detectorReport.main_decision.verdict === "PASS",
    gallery_pass: detectorReport.gallery_decisions.every((row) => row.verdict === "PASS"),
    quantity_identity_consistent: declaredConsistency.verdict !== "CONTRADICTION",
    no_walmart_write_required: true,
  };
  if (Object.values(checks).some((value) => value !== true)) {
    fail(`clean Qualification failed: ${JSON.stringify(checks)}`);
  }
  const outputDir = path.resolve(input.output_dir);
  if (outputDir !== input.output_dir || outputDir === path.parse(outputDir).root) {
    fail("output_dir must be absolute, normalized, and narrow");
  }
  let existingQualifiedAt: string | null = null;
  try {
    const existingQualification = await exactJsonFile(
      outputDir,
      "qualification-receipt.json",
      "existing clean qualification",
    );
    verifySeal(existingQualification.value, "existing clean qualification");
    existingQualifiedAt = exactText(
      existingQualification.value.qualified_at,
      "existing clean qualification qualified_at",
      64,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const qualifiedAt = existingQualifiedAt ?? (input.now ?? new Date()).toISOString();
  const listing = {
    listing_key: index.listing_key,
    sku: productTruth.snapshot.sku,
    item_id: snapshot.target.item_id,
    store_index: productTruth.snapshot.storeIndex,
  };
  const qualificationBody = {
    schema_version: WALMART_LISTING_CLEAN_QUALIFICATION_SCHEMA,
    status: "PASS",
    qualified_at: qualifiedAt,
    listing,
    product_truth_manifest_sha256: expectedManifest,
    intake_index_file_sha256: intakeArtifact.file_sha256,
    intake_index_body_sha256: index.body_sha256,
    observer_plan_file_sha256: planArtifact.file_sha256,
    observer_execution_file_sha256: executionArtifact.file_sha256,
    diagnosis_file_sha256: diagnosisArtifact.file_sha256,
    changed_fields: [] as string[],
    checks,
    external_effects: {
      walmart_reads_during_qualification: 0,
      walmart_writes: 0,
      database_writes: 0,
      model_calls_during_qualification: 0,
    },
    next_sku_unblocked: true,
  };
  const qualification = {
    ...qualificationBody,
    body_sha256: walmartListingIntegritySha256(qualificationBody),
  };
  const qualificationBytes = Buffer.from(`${JSON.stringify(qualification, null, 2)}\n`, "utf8");
  const verificationBody = {
    schema_version: WALMART_LISTING_NO_CHANGE_VERIFICATION_SCHEMA,
    status: "LIVE_SURFACE_PASS",
    completion_mode: "AUDITED_NO_CHANGE",
    qualified_at: qualifiedAt,
    listing,
    feed_id: null,
    exact_payload_sha256: null,
    qualification_receipt_file_sha256: sha256(qualificationBytes),
    product_truth_manifest_sha256: expectedManifest,
    before: {
      captured_at: index.created_at,
      intake_index_file_sha256: intakeArtifact.file_sha256,
      intake_index_body_sha256: index.body_sha256,
      buyer_pdp_file_sha256: fileByRole(index, "buyer_pdp_payload").file_sha256,
      image_sha256: snapshot.assets.map((asset) => asset.sha256),
    },
    after: {
      captured_at: index.created_at,
      intake_index_file_sha256: intakeArtifact.file_sha256,
      intake_index_body_sha256: index.body_sha256,
      buyer_pdp_file_sha256: fileByRole(index, "buyer_pdp_payload").file_sha256,
      image_sha256: snapshot.assets.map((asset) => asset.sha256),
    },
    diagnosis: {
      diagnosis_file_sha256: diagnosisArtifact.file_sha256,
      detector_report_body_sha256: detectorReport.body_sha256,
      changed_fields: [] as string[],
    },
    checks,
    qualification_boundary: {
      buyer_facing_live_surface_verified: true,
      source_aware_qualification_receipt_emitted: true,
      no_walmart_write_required: true,
      next_sku_unblocked: true,
    },
  };
  const verification = {
    ...verificationBody,
    body_sha256: walmartListingIntegritySha256(verificationBody),
  };
  const verificationBytes = Buffer.from(`${JSON.stringify(verification, null, 2)}\n`, "utf8");
  const htmlBytes = Buffer.from(renderHtml({ verification, snapshot, buyer_pdp: buyerPdp }), "utf8");
  if (existingQualifiedAt !== null) {
    const [existingQualification, existingVerification, existingHtml] = await Promise.all([
      exactFile(outputDir, "qualification-receipt.json", "existing qualification receipt"),
      exactFile(outputDir, "live-canary-verification.json", "existing no-change verification"),
      exactFile(outputDir, "before-after-gallery.html", "existing no-change gallery"),
    ]);
    if (!existingQualification.equals(qualificationBytes)
      || !existingVerification.equals(verificationBytes)
      || !existingHtml.equals(htmlBytes)) {
      fail("existing clean Qualification output differs from exact rebuilt evidence");
    }
    return {
      status: "LIVE_SURFACE_PASS" as const,
      verdict: "PASS" as const,
      completion_mode: "AUDITED_NO_CHANGE" as const,
      qualification_receipt_path: path.join(outputDir, "qualification-receipt.json"),
      qualification_receipt_file_sha256: sha256(qualificationBytes),
      verification_path: path.join(outputDir, "live-canary-verification.json"),
      verification_file_sha256: sha256(verificationBytes),
      gallery_path: path.join(outputDir, "before-after-gallery.html"),
      gallery_file_sha256: sha256(htmlBytes),
      checks: Object.keys(checks).length,
      next_sku_unblocked: true,
      walmart_writes: 0 as const,
    };
  }
  const temporary = `${outputDir}.tmp-${process.pid}`;
  await mkdir(path.dirname(outputDir), { recursive: true, mode: 0o700 });
  await mkdir(temporary, { mode: 0o700 });
  await writeExclusive(path.join(temporary, "qualification-receipt.json"), qualificationBytes);
  await writeExclusive(path.join(temporary, "live-canary-verification.json"), verificationBytes);
  await writeExclusive(path.join(temporary, "before-after-gallery.html"), htmlBytes);
  await rename(temporary, outputDir);
  return {
    status: "LIVE_SURFACE_PASS" as const,
    verdict: "PASS" as const,
    completion_mode: "AUDITED_NO_CHANGE" as const,
    qualification_receipt_path: path.join(outputDir, "qualification-receipt.json"),
    qualification_receipt_file_sha256: sha256(qualificationBytes),
    verification_path: path.join(outputDir, "live-canary-verification.json"),
    verification_file_sha256: sha256(verificationBytes),
    gallery_path: path.join(outputDir, "before-after-gallery.html"),
    gallery_file_sha256: sha256(htmlBytes),
    checks: Object.keys(checks).length,
    next_sku_unblocked: true,
    walmart_writes: 0 as const,
  };
}
