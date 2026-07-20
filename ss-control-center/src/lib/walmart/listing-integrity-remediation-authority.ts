/**
 * Owner-authenticated authority boundary for Walmart Listing Integrity repair.
 *
 * A sequence authorization freezes the complete ordered review/remediation
 * population but authorizes zero marketplace writes.  Every marketplace write
 * needs a separate Ed25519-signed one-SKU permit bound to the exact plan,
 * Product Truth revision, request payload, apply release, and durable
 * consumption-ledger identity.
 *
 * Private keys and signing helpers intentionally do not exist here. Production
 * fails closed until a reviewed public key is enrolled in PINNED_OWNER_KEYS.
 */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";

export const WALMART_LISTING_REPAIR_SEQUENCE_AUTHORIZATION_SCHEMA =
  "walmart-listing-repair-sequence-authorization/v1" as const;
export const WALMART_LISTING_REPAIR_ONE_SKU_PERMIT_SCHEMA =
  "walmart-listing-repair-one-sku-permit/v1" as const;
export const WALMART_LISTING_REPAIR_OWNER_ALGORITHM = "Ed25519" as const;
export const WALMART_LISTING_REPAIR_SEQUENCE_ACTION =
  "WALMART_LISTING_REPAIR_SEQUENCE_SCOPE" as const;
export const WALMART_LISTING_REPAIR_ONE_SKU_ACTION =
  "WALMART_LISTING_REPAIR_ONE_SKU_APPLY" as const;

const SEQUENCE_SIGNING_DOMAIN = Buffer.from(
  "SS_COMMAND_CENTER\0WALMART_LISTING_REPAIR_SEQUENCE\0v1\0",
  "utf8",
);
const ONE_SKU_SIGNING_DOMAIN = Buffer.from(
  "SS_COMMAND_CENTER\0WALMART_LISTING_REPAIR_ONE_SKU_PERMIT\0v1\0",
  "utf8",
);
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const MAX_SEQUENCE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_ONE_SKU_TTL_MS = 30 * 60 * 1_000;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;

type JsonRecord = Record<string, unknown>;
export type WalmartListingRepairEnvironment = "PRODUCTION" | "TEST_FIXTURE_ONLY";

export interface WalmartListingRepairListingIdentity {
  channel: "WALMART_US";
  store_index: number;
  sku: string;
  listing_key: string;
  item_id: string;
}

export interface WalmartListingRepairConsumptionLedgerBinding {
  policy_id: "walmart-listing-repair-permit-consumption-ledger/1.0.0";
  ledger_id: string;
  ledger_epoch: string;
  state_directory_path_sha256: string;
  directory_identity_sha256: string;
  identity_artifact_sha256: string;
  reservation_filename_policy: "authorization-sha256.json/exclusive-create/v1";
  trusted_single_custody_host_only: true;
  distributed_at_most_once_claimed: false;
}

export interface WalmartListingRepairSequenceSignedBody {
  action: typeof WALMART_LISTING_REPAIR_SEQUENCE_ACTION;
  environment: WalmartListingRepairEnvironment;
  sequence_id: string;
  sequence_epoch: string;
  issued_at: string;
  expires_at: string;
  approved_by: string;
  decision_ref: string;
  seller_account_fingerprint_sha256: string;
  population_artifact_sha256: string;
  frozen_verifier_engine_release_sha256: string;
  capture_authority_public_key_spki_sha256: string;
  ordered_listings: WalmartListingRepairListingIdentity[];
  claims: {
    exact_ordered_population: true;
    source_aware_rebuild_required: true;
    next_sku_requires_rebuilt_pass: true;
    marketplace_writes_authorized: false;
    sequence_is_not_a_write_permit: true;
    mass_apply_allowed: false;
  };
}

export interface WalmartListingRepairOneSkuPermitSignedBody {
  action: typeof WALMART_LISTING_REPAIR_ONE_SKU_ACTION;
  environment: WalmartListingRepairEnvironment;
  permit_id: string;
  issued_at: string;
  expires_at: string;
  approved_by: string;
  decision_ref: string;
  sequence_authorization_sha256: string;
  sequence_id: string;
  sequence_epoch: string;
  sequence_position: number;
  listing: WalmartListingRepairListingIdentity;
  plan_id: string;
  plan_body_sha256: string;
  target_sha256: string;
  baseline_capture_exchange_sha256: string;
  product_truth: {
    expected_sha256: string;
    product_truth_snapshot_id: string;
    product_truth_snapshot_body_sha256: string;
    truth_revision_id: string;
    truth_revision_body_sha256: string;
    truth_approval_sha256: string;
  };
  apply_engine_release_sha256: string;
  request_manifest_sha256: string;
  request_payload_sha256: string;
  consumption_ledger: WalmartListingRepairConsumptionLedgerBinding;
  claims: {
    exact_listing_count: 1;
    marketplace_write_calls: 1;
    retry_allowed: false;
    automatic_reapply_allowed: false;
    mass_apply_allowed: false;
    delist: false;
    reprice: false;
    purchase: false;
    schedule: false;
  };
}

export interface WalmartListingRepairOwnerSigningEnvelope<TBody> {
  schema_version:
    | typeof WALMART_LISTING_REPAIR_SEQUENCE_AUTHORIZATION_SCHEMA
    | typeof WALMART_LISTING_REPAIR_ONE_SKU_PERMIT_SCHEMA;
  algorithm: typeof WALMART_LISTING_REPAIR_OWNER_ALGORITHM;
  key_id: string;
  owner_public_key_spki_sha256: string;
  signed_body: TBody;
}

export interface WalmartListingRepairOwnerAuthorization<TBody>
  extends WalmartListingRepairOwnerSigningEnvelope<TBody> {
  signature_base64: string;
  signature_sha256: string;
  authorization_sha256: string;
}

export type WalmartListingRepairSequenceAuthorization =
  WalmartListingRepairOwnerAuthorization<WalmartListingRepairSequenceSignedBody>;
export type WalmartListingRepairOneSkuPermit =
  WalmartListingRepairOwnerAuthorization<WalmartListingRepairOneSkuPermitSignedBody>;

interface TrustedOwnerKey {
  key_id: string;
  public_key_spki_der_base64: string;
  public_key_spki_sha256: string;
  status: "ACTIVE" | "REVOKED";
  environment: WalmartListingRepairEnvironment;
}

/** Dedicated domain, but it may enroll the same owner public key used elsewhere. */
const PINNED_OWNER_KEYS: readonly TrustedOwnerKey[] = Object.freeze([]);

function fail(message: string): never {
  const error = new Error(message);
  (error as Error & { code: string }).code = "WALMART_LISTING_REPAIR_AUTHORITY_ERROR";
  throw error;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} contains missing or extra fields`);
  }
}

function text(value: unknown, label: string, maximum = 10_000): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be a non-empty exact string`);
  }
  return value;
}

function safeId(value: unknown, label: string): string {
  const parsed = text(value, label, 200);
  if (!SAFE_ID.test(parsed) || parsed.includes("//") || parsed.endsWith("/")) {
    fail(`${label} must be a safe identifier`);
  }
  return parsed;
}

function digest(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!SHA256.test(parsed)) fail(`${label} must be lowercase SHA-256`);
  return parsed;
}

function instant(value: unknown, label: string): string {
  const parsed = text(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parsed)
    || new Date(parsed).toISOString() !== parsed) {
    fail(`${label} must be canonical UTC milliseconds`);
  }
  return parsed;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as JsonRecord;
    return `{${Object.keys(row).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(row[key])}`
    )).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("canonical JSON rejects undefined");
  return encoded;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalBase64(value: unknown, label: string): { value: string; bytes: Buffer } {
  const parsed = text(value, label, 16_384);
  if (/\s/u.test(parsed)) fail(`${label} must be canonical base64`);
  const bytes = Buffer.from(parsed, "base64");
  if (bytes.byteLength < 1 || bytes.toString("base64") !== parsed) {
    fail(`${label} must be canonical base64`);
  }
  return { value: parsed, bytes };
}

function listingIdentity(value: unknown, label: string): WalmartListingRepairListingIdentity {
  const raw = record(value, label);
  exactKeys(raw, ["channel", "store_index", "sku", "listing_key", "item_id"], label);
  if (raw.channel !== "WALMART_US" || !Number.isSafeInteger(raw.store_index)
    || Number(raw.store_index) < 1) {
    fail(`${label} must be a positive-store Walmart listing`);
  }
  return {
    channel: "WALMART_US",
    store_index: Number(raw.store_index),
    sku: text(raw.sku, `${label}.sku`, 512),
    listing_key: text(raw.listing_key, `${label}.listing_key`, 512),
    item_id: text(raw.item_id, `${label}.item_id`, 128),
  };
}

function ledgerBinding(
  value: unknown,
  label: string,
): WalmartListingRepairConsumptionLedgerBinding {
  const raw = record(value, label);
  exactKeys(raw, [
    "policy_id", "ledger_id", "ledger_epoch", "state_directory_path_sha256",
    "directory_identity_sha256", "identity_artifact_sha256",
    "reservation_filename_policy", "trusted_single_custody_host_only",
    "distributed_at_most_once_claimed",
  ], label);
  if (raw.policy_id !== "walmart-listing-repair-permit-consumption-ledger/1.0.0"
    || raw.reservation_filename_policy
      !== "authorization-sha256.json/exclusive-create/v1"
    || raw.trusted_single_custody_host_only !== true
    || raw.distributed_at_most_once_claimed !== false) {
    fail(`${label} policy is invalid`);
  }
  return {
    policy_id: "walmart-listing-repair-permit-consumption-ledger/1.0.0",
    ledger_id: safeId(raw.ledger_id, `${label}.ledger_id`),
    ledger_epoch: safeId(raw.ledger_epoch, `${label}.ledger_epoch`),
    state_directory_path_sha256: digest(
      raw.state_directory_path_sha256,
      `${label}.state_directory_path_sha256`,
    ),
    directory_identity_sha256: digest(
      raw.directory_identity_sha256,
      `${label}.directory_identity_sha256`,
    ),
    identity_artifact_sha256: digest(
      raw.identity_artifact_sha256,
      `${label}.identity_artifact_sha256`,
    ),
    reservation_filename_policy: "authorization-sha256.json/exclusive-create/v1",
    trusted_single_custody_host_only: true,
    distributed_at_most_once_claimed: false,
  };
}

function sequenceClaims(value: unknown): WalmartListingRepairSequenceSignedBody["claims"] {
  const raw = record(value, "sequence claims");
  exactKeys(raw, [
    "exact_ordered_population", "source_aware_rebuild_required",
    "next_sku_requires_rebuilt_pass", "marketplace_writes_authorized",
    "sequence_is_not_a_write_permit", "mass_apply_allowed",
  ], "sequence claims");
  if (raw.exact_ordered_population !== true || raw.source_aware_rebuild_required !== true
    || raw.next_sku_requires_rebuilt_pass !== true
    || raw.marketplace_writes_authorized !== false
    || raw.sequence_is_not_a_write_permit !== true || raw.mass_apply_allowed !== false) {
    fail("sequence claims may not authorize or relax marketplace writes");
  }
  return {
    exact_ordered_population: true,
    source_aware_rebuild_required: true,
    next_sku_requires_rebuilt_pass: true,
    marketplace_writes_authorized: false,
    sequence_is_not_a_write_permit: true,
    mass_apply_allowed: false,
  };
}

function oneSkuClaims(value: unknown): WalmartListingRepairOneSkuPermitSignedBody["claims"] {
  const raw = record(value, "one-SKU permit claims");
  exactKeys(raw, [
    "exact_listing_count", "marketplace_write_calls", "retry_allowed",
    "automatic_reapply_allowed", "mass_apply_allowed", "delist", "reprice",
    "purchase", "schedule",
  ], "one-SKU permit claims");
  if (raw.exact_listing_count !== 1 || raw.marketplace_write_calls !== 1
    || raw.retry_allowed !== false || raw.automatic_reapply_allowed !== false
    || raw.mass_apply_allowed !== false || raw.delist !== false || raw.reprice !== false
    || raw.purchase !== false || raw.schedule !== false) {
    fail("one-SKU permit claims may authorize only one exact non-replay repair write");
  }
  return {
    exact_listing_count: 1,
    marketplace_write_calls: 1,
    retry_allowed: false,
    automatic_reapply_allowed: false,
    mass_apply_allowed: false,
    delist: false,
    reprice: false,
    purchase: false,
    schedule: false,
  };
}

export function parseWalmartListingRepairSequenceSignedBody(
  value: unknown,
): WalmartListingRepairSequenceSignedBody {
  const raw = record(value, "sequence signed body");
  exactKeys(raw, [
    "action", "environment", "sequence_id", "sequence_epoch", "issued_at",
    "expires_at", "approved_by", "decision_ref", "seller_account_fingerprint_sha256",
    "population_artifact_sha256", "frozen_verifier_engine_release_sha256",
    "capture_authority_public_key_spki_sha256", "ordered_listings", "claims",
  ], "sequence signed body");
  if (raw.action !== WALMART_LISTING_REPAIR_SEQUENCE_ACTION
    || !["PRODUCTION", "TEST_FIXTURE_ONLY"].includes(String(raw.environment))) {
    fail("sequence action/environment is invalid");
  }
  const issuedAt = instant(raw.issued_at, "sequence issued_at");
  const expiresAt = instant(raw.expires_at, "sequence expires_at");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)
    || Date.parse(expiresAt) - Date.parse(issuedAt) > MAX_SEQUENCE_TTL_MS) {
    fail("sequence authorization window must be positive and at most seven days");
  }
  if (!Array.isArray(raw.ordered_listings) || raw.ordered_listings.length < 1
    || raw.ordered_listings.length > 10_000) {
    fail("sequence ordered_listings must be a bounded non-empty array");
  }
  const listings = raw.ordered_listings.map((row, index) => (
    listingIdentity(row, `sequence ordered_listings[${index}]`)
  ));
  if (new Set(listings.map((row) => row.listing_key)).size !== listings.length) {
    fail("sequence ordered_listings contains duplicate listing_key values");
  }
  const stores = new Set(listings.map((row) => row.store_index));
  if (stores.size !== 1) fail("one repair sequence must remain inside one Walmart store");
  return {
    action: WALMART_LISTING_REPAIR_SEQUENCE_ACTION,
    environment: raw.environment as WalmartListingRepairEnvironment,
    sequence_id: safeId(raw.sequence_id, "sequence_id"),
    sequence_epoch: safeId(raw.sequence_epoch, "sequence_epoch"),
    issued_at: issuedAt,
    expires_at: expiresAt,
    approved_by: text(raw.approved_by, "sequence approved_by", 256),
    decision_ref: text(raw.decision_ref, "sequence decision_ref", 2_048),
    seller_account_fingerprint_sha256: digest(
      raw.seller_account_fingerprint_sha256,
      "sequence seller_account_fingerprint_sha256",
    ),
    population_artifact_sha256: digest(
      raw.population_artifact_sha256,
      "sequence population_artifact_sha256",
    ),
    frozen_verifier_engine_release_sha256: digest(
      raw.frozen_verifier_engine_release_sha256,
      "sequence frozen_verifier_engine_release_sha256",
    ),
    capture_authority_public_key_spki_sha256: digest(
      raw.capture_authority_public_key_spki_sha256,
      "sequence capture_authority_public_key_spki_sha256",
    ),
    ordered_listings: listings,
    claims: sequenceClaims(raw.claims),
  };
}

function productTruthBinding(value: unknown): WalmartListingRepairOneSkuPermitSignedBody["product_truth"] {
  const raw = record(value, "permit product_truth");
  exactKeys(raw, [
    "expected_sha256", "product_truth_snapshot_id",
    "product_truth_snapshot_body_sha256", "truth_revision_id",
    "truth_revision_body_sha256", "truth_approval_sha256",
  ], "permit product_truth");
  return {
    expected_sha256: digest(raw.expected_sha256, "permit expected_sha256"),
    product_truth_snapshot_id: safeId(
      raw.product_truth_snapshot_id,
      "permit product_truth_snapshot_id",
    ),
    product_truth_snapshot_body_sha256: digest(
      raw.product_truth_snapshot_body_sha256,
      "permit product_truth_snapshot_body_sha256",
    ),
    truth_revision_id: safeId(raw.truth_revision_id, "permit truth_revision_id"),
    truth_revision_body_sha256: digest(
      raw.truth_revision_body_sha256,
      "permit truth_revision_body_sha256",
    ),
    truth_approval_sha256: digest(
      raw.truth_approval_sha256,
      "permit truth_approval_sha256",
    ),
  };
}

export function parseWalmartListingRepairOneSkuPermitSignedBody(
  value: unknown,
): WalmartListingRepairOneSkuPermitSignedBody {
  const raw = record(value, "one-SKU permit signed body");
  exactKeys(raw, [
    "action", "environment", "permit_id", "issued_at", "expires_at", "approved_by",
    "decision_ref", "sequence_authorization_sha256", "sequence_id", "sequence_epoch",
    "sequence_position", "listing", "plan_id", "plan_body_sha256", "target_sha256",
    "baseline_capture_exchange_sha256", "product_truth", "apply_engine_release_sha256",
    "request_manifest_sha256", "request_payload_sha256", "consumption_ledger", "claims",
  ], "one-SKU permit signed body");
  if (raw.action !== WALMART_LISTING_REPAIR_ONE_SKU_ACTION
    || !["PRODUCTION", "TEST_FIXTURE_ONLY"].includes(String(raw.environment))) {
    fail("one-SKU permit action/environment is invalid");
  }
  const issuedAt = instant(raw.issued_at, "permit issued_at");
  const expiresAt = instant(raw.expires_at, "permit expires_at");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)
    || Date.parse(expiresAt) - Date.parse(issuedAt) > MAX_ONE_SKU_TTL_MS) {
    fail("one-SKU permit window must be positive and at most 30 minutes");
  }
  if (!Number.isSafeInteger(raw.sequence_position) || Number(raw.sequence_position) < 0) {
    fail("permit sequence_position must be a non-negative safe integer");
  }
  return {
    action: WALMART_LISTING_REPAIR_ONE_SKU_ACTION,
    environment: raw.environment as WalmartListingRepairEnvironment,
    permit_id: safeId(raw.permit_id, "permit_id"),
    issued_at: issuedAt,
    expires_at: expiresAt,
    approved_by: text(raw.approved_by, "permit approved_by", 256),
    decision_ref: text(raw.decision_ref, "permit decision_ref", 2_048),
    sequence_authorization_sha256: digest(
      raw.sequence_authorization_sha256,
      "permit sequence_authorization_sha256",
    ),
    sequence_id: safeId(raw.sequence_id, "permit sequence_id"),
    sequence_epoch: safeId(raw.sequence_epoch, "permit sequence_epoch"),
    sequence_position: Number(raw.sequence_position),
    listing: listingIdentity(raw.listing, "permit listing"),
    plan_id: safeId(raw.plan_id, "permit plan_id"),
    plan_body_sha256: digest(raw.plan_body_sha256, "permit plan_body_sha256"),
    target_sha256: digest(raw.target_sha256, "permit target_sha256"),
    baseline_capture_exchange_sha256: digest(
      raw.baseline_capture_exchange_sha256,
      "permit baseline_capture_exchange_sha256",
    ),
    product_truth: productTruthBinding(raw.product_truth),
    apply_engine_release_sha256: digest(
      raw.apply_engine_release_sha256,
      "permit apply_engine_release_sha256",
    ),
    request_manifest_sha256: digest(
      raw.request_manifest_sha256,
      "permit request_manifest_sha256",
    ),
    request_payload_sha256: digest(
      raw.request_payload_sha256,
      "permit request_payload_sha256",
    ),
    consumption_ledger: ledgerBinding(raw.consumption_ledger, "permit consumption_ledger"),
    claims: oneSkuClaims(raw.claims),
  };
}

function validateTrustedKey(key: TrustedOwnerKey): void {
  safeId(key.key_id, "owner key_id");
  const encoded = canonicalBase64(key.public_key_spki_der_base64, "owner public key");
  if (digest(key.public_key_spki_sha256, "owner public-key fingerprint")
      !== sha256(encoded.bytes)) {
    fail("owner public-key fingerprint mismatch");
  }
  let publicKey;
  try {
    publicKey = createPublicKey({ key: encoded.bytes, format: "der", type: "spki" });
  } catch {
    fail("owner public key is not SPKI DER");
  }
  if (publicKey.asymmetricKeyType !== "ed25519"
    || !["ACTIVE", "REVOKED"].includes(key.status)
    || !["PRODUCTION", "TEST_FIXTURE_ONLY"].includes(key.environment)) {
    fail("owner trust root is invalid");
  }
}

function fixtureKey(env: NodeJS.ProcessEnv): TrustedOwnerKey | null {
  if (env.NODE_ENV !== "test" || env.WALMART_LISTING_REPAIR_TEST_MODE !== "1") return null;
  const keyId = env.WALMART_LISTING_REPAIR_TEST_OWNER_KEY_ID;
  const encoded = env.WALMART_LISTING_REPAIR_TEST_OWNER_PUBLIC_KEY_SPKI_DER_BASE64;
  if (!keyId || !encoded) return null;
  const bytes = Buffer.from(encoded, "base64");
  return {
    key_id: keyId,
    public_key_spki_der_base64: encoded,
    public_key_spki_sha256: sha256(bytes),
    status: "ACTIVE",
    environment: "TEST_FIXTURE_ONLY",
  };
}

function trustedKeys(env: NodeJS.ProcessEnv): readonly TrustedOwnerKey[] {
  const fixture = fixtureKey(env);
  const keys = fixture ? [...PINNED_OWNER_KEYS, fixture] : [...PINNED_OWNER_KEYS];
  const ids = new Set<string>();
  for (const key of keys) {
    validateTrustedKey(key);
    if (ids.has(key.key_id)) fail("duplicate owner key_id");
    ids.add(key.key_id);
  }
  return Object.freeze(keys);
}

export function inspectWalmartListingRepairOwnerTrustRoot(
  environment: WalmartListingRepairEnvironment = "PRODUCTION",
  env: NodeJS.ProcessEnv = process.env,
): { ready: boolean; active_key_ids: string[]; active_key_fingerprints: string[] } {
  const active = trustedKeys(env).filter((key) => (
    key.status === "ACTIVE" && key.environment === environment
  ));
  return {
    ready: active.length > 0,
    active_key_ids: active.map((key) => key.key_id).sort(),
    active_key_fingerprints: active.map((key) => key.public_key_spki_sha256).sort(),
  };
}

function signingDomain(schema: string): Buffer {
  return schema === WALMART_LISTING_REPAIR_SEQUENCE_AUTHORIZATION_SCHEMA
    ? SEQUENCE_SIGNING_DOMAIN : ONE_SKU_SIGNING_DOMAIN;
}

export function walmartListingRepairOwnerSigningMessage<TBody>(
  envelope: WalmartListingRepairOwnerSigningEnvelope<TBody>,
): Buffer {
  return Buffer.concat([
    signingDomain(envelope.schema_version),
    Buffer.from(canonicalJson(envelope), "utf8"),
  ]);
}

function verifyAuthorization<TBody>(
  value: unknown,
  schema: typeof WALMART_LISTING_REPAIR_SEQUENCE_AUTHORIZATION_SCHEMA
    | typeof WALMART_LISTING_REPAIR_ONE_SKU_PERMIT_SCHEMA,
  parseBody: (value: unknown) => TBody,
  environment: WalmartListingRepairEnvironment,
  env: NodeJS.ProcessEnv,
): WalmartListingRepairOwnerAuthorization<TBody> {
  const raw = record(value, "owner authorization");
  exactKeys(raw, [
    "schema_version", "algorithm", "key_id", "owner_public_key_spki_sha256",
    "signed_body", "signature_base64", "signature_sha256", "authorization_sha256",
  ], "owner authorization");
  if (raw.schema_version !== schema || raw.algorithm !== WALMART_LISTING_REPAIR_OWNER_ALGORITHM) {
    fail("owner authorization schema/algorithm is invalid");
  }
  const keyId = safeId(raw.key_id, "owner authorization key_id");
  const key = trustedKeys(env).find((candidate) => (
    candidate.key_id === keyId && candidate.status === "ACTIVE"
      && candidate.environment === environment
  ));
  if (!key) fail("owner authorization key is untrusted or revoked");
  const fingerprint = digest(
    raw.owner_public_key_spki_sha256,
    "owner authorization public-key fingerprint",
  );
  if (fingerprint !== key.public_key_spki_sha256) fail("owner key fingerprint is not pinned");
  const body = parseBody(raw.signed_body);
  if (record(body, "owner signed body").environment !== environment) {
    fail("owner authorization environment differs from the trusted key domain");
  }
  const signature = canonicalBase64(raw.signature_base64, "owner signature");
  const signatureSha = digest(raw.signature_sha256, "owner signature_sha256");
  if (signature.bytes.byteLength !== 64 || signatureSha !== sha256(signature.bytes)) {
    fail("owner signature bytes/hash are invalid");
  }
  const envelope: WalmartListingRepairOwnerSigningEnvelope<TBody> = {
    schema_version: schema,
    algorithm: WALMART_LISTING_REPAIR_OWNER_ALGORITHM,
    key_id: key.key_id,
    owner_public_key_spki_sha256: key.public_key_spki_sha256,
    signed_body: body,
  };
  const publicKey = createPublicKey({
    key: Buffer.from(key.public_key_spki_der_base64, "base64"),
    format: "der",
    type: "spki",
  });
  if (!verifySignature(
    null,
    walmartListingRepairOwnerSigningMessage(envelope),
    publicKey,
    signature.bytes,
  )) {
    fail("owner Ed25519 signature is invalid");
  }
  const unsigned = {
    ...envelope,
    signature_base64: signature.value,
    signature_sha256: signatureSha,
  };
  const authorizationSha = digest(raw.authorization_sha256, "authorization_sha256");
  if (authorizationSha !== sha256(canonicalJson(unsigned))) {
    fail("owner authorization hash is invalid");
  }
  return { ...unsigned, authorization_sha256: authorizationSha };
}

function assertCurrentWindow(
  issuedAt: string,
  expiresAt: string,
  now: Date,
  label: string,
): void {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || Date.parse(issuedAt) > nowMs + CLOCK_SKEW_MS
    || nowMs < Date.parse(issuedAt) - CLOCK_SKEW_MS || nowMs >= Date.parse(expiresAt)) {
    fail(`${label} is not current`);
  }
}

export function verifyWalmartListingRepairSequenceAuthorization(
  value: unknown,
  now = new Date(),
): WalmartListingRepairSequenceAuthorization {
  const authorization = verifyAuthorization(
    value,
    WALMART_LISTING_REPAIR_SEQUENCE_AUTHORIZATION_SCHEMA,
    parseWalmartListingRepairSequenceSignedBody,
    "PRODUCTION",
    process.env,
  );
  assertCurrentWindow(
    authorization.signed_body.issued_at,
    authorization.signed_body.expires_at,
    now,
    "sequence authorization",
  );
  return authorization;
}

/** Historical structural/signature verification for post-apply qualification. */
export function verifyWalmartListingRepairOneSkuPermitHistorical(
  value: unknown,
): WalmartListingRepairOneSkuPermit {
  return verifyAuthorization(
    value,
    WALMART_LISTING_REPAIR_ONE_SKU_PERMIT_SCHEMA,
    parseWalmartListingRepairOneSkuPermitSignedBody,
    "PRODUCTION",
    process.env,
  );
}

/** Live writer boundary: signature plus a current authorization window. */
export function verifyCurrentWalmartListingRepairOneSkuPermit(
  value: unknown,
  now = new Date(),
): WalmartListingRepairOneSkuPermit {
  const permit = verifyWalmartListingRepairOneSkuPermitHistorical(value);
  assertCurrentWindow(
    permit.signed_body.issued_at,
    permit.signed_body.expires_at,
    now,
    "one-SKU permit",
  );
  return permit;
}

/** Test-only verification; production cannot select the fixture trust domain. */
export function verifyWalmartListingRepairSequenceAuthorizationForTest(
  value: unknown,
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): WalmartListingRepairSequenceAuthorization {
  if (process.env.NODE_ENV !== "test" || process.env.WALMART_LISTING_REPAIR_TEST_MODE !== "1") {
    fail("test authority injection is disabled");
  }
  const authorization = verifyAuthorization(
    value,
    WALMART_LISTING_REPAIR_SEQUENCE_AUTHORIZATION_SCHEMA,
    parseWalmartListingRepairSequenceSignedBody,
    "TEST_FIXTURE_ONLY",
    env,
  );
  assertCurrentWindow(
    authorization.signed_body.issued_at,
    authorization.signed_body.expires_at,
    now,
    "sequence authorization",
  );
  return authorization;
}

/** Test-only verification; production cannot select the fixture trust domain. */
export function verifyWalmartListingRepairOneSkuPermitHistoricalForTest(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): WalmartListingRepairOneSkuPermit {
  if (process.env.NODE_ENV !== "test" || process.env.WALMART_LISTING_REPAIR_TEST_MODE !== "1") {
    fail("test authority injection is disabled");
  }
  return verifyAuthorization(
    value,
    WALMART_LISTING_REPAIR_ONE_SKU_PERMIT_SCHEMA,
    parseWalmartListingRepairOneSkuPermitSignedBody,
    "TEST_FIXTURE_ONLY",
    env,
  );
}

/** Test-only live-window verification. */
export function verifyCurrentWalmartListingRepairOneSkuPermitForTest(
  value: unknown,
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): WalmartListingRepairOneSkuPermit {
  const permit = verifyWalmartListingRepairOneSkuPermitHistoricalForTest(value, env);
  assertCurrentWindow(
    permit.signed_body.issued_at,
    permit.signed_body.expires_at,
    now,
    "one-SKU permit",
  );
  return permit;
}

/** Helper for external assembly/tests; it never accesses a private key. */
export function assembleWalmartListingRepairOwnerAuthorization<TBody>(input: {
  envelope: WalmartListingRepairOwnerSigningEnvelope<TBody>;
  signature_base64: string;
}): WalmartListingRepairOwnerAuthorization<TBody> {
  const signature = canonicalBase64(input.signature_base64, "detached owner signature");
  if (signature.bytes.byteLength !== 64) fail("detached owner signature must be 64 bytes");
  const unsigned = {
    ...input.envelope,
    signature_base64: signature.value,
    signature_sha256: sha256(signature.bytes),
  };
  return {
    ...unsigned,
    authorization_sha256: sha256(canonicalJson(unsigned)),
  };
}

export function walmartListingRepairSequenceSigningEnvelope(input: {
  key_id: string;
  owner_public_key_spki_sha256: string;
  signed_body: WalmartListingRepairSequenceSignedBody;
}): WalmartListingRepairOwnerSigningEnvelope<WalmartListingRepairSequenceSignedBody> {
  return {
    schema_version: WALMART_LISTING_REPAIR_SEQUENCE_AUTHORIZATION_SCHEMA,
    algorithm: WALMART_LISTING_REPAIR_OWNER_ALGORITHM,
    key_id: safeId(input.key_id, "sequence key_id"),
    owner_public_key_spki_sha256: digest(
      input.owner_public_key_spki_sha256,
      "sequence owner_public_key_spki_sha256",
    ),
    signed_body: parseWalmartListingRepairSequenceSignedBody(input.signed_body),
  };
}

export function walmartListingRepairOneSkuPermitSigningEnvelope(input: {
  key_id: string;
  owner_public_key_spki_sha256: string;
  signed_body: WalmartListingRepairOneSkuPermitSignedBody;
}): WalmartListingRepairOwnerSigningEnvelope<WalmartListingRepairOneSkuPermitSignedBody> {
  return {
    schema_version: WALMART_LISTING_REPAIR_ONE_SKU_PERMIT_SCHEMA,
    algorithm: WALMART_LISTING_REPAIR_OWNER_ALGORITHM,
    key_id: safeId(input.key_id, "permit key_id"),
    owner_public_key_spki_sha256: digest(
      input.owner_public_key_spki_sha256,
      "permit owner_public_key_spki_sha256",
    ),
    signed_body: parseWalmartListingRepairOneSkuPermitSignedBody(input.signed_body),
  };
}

export function walmartListingRepairAuthoritySha256(value: unknown): string {
  return sha256(canonicalJson(value));
}
