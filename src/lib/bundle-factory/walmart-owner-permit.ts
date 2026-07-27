import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";

import {
  validateWalmartOwnerControlTrustedKey,
  walmartOwnerControlProductionTrustedKeys,
  type WalmartOwnerControlTrustedKey,
} from "@/lib/walmart/owner-control-trust-root";

import { stableWalmartJson } from "./walmart-listing-contract";

export const WALMART_OWNER_PERMIT_SCHEMA =
  "walmart-new-sku-owner-permit/2.0.0" as const;
export const WALMART_OWNER_PERMIT_ALGORITHM = "Ed25519" as const;
export const WALMART_OWNER_PERMIT_ACTION = "WALMART_MP_ITEM_SUBMIT" as const;
export type WalmartOwnerPermitEnvironment =
  | "PRODUCTION"
  | "TEST_FIXTURE_ONLY";
const SIGNING_DOMAIN = Buffer.from(
  "SS_COMMAND_CENTER\0WALMART_NEW_SKU_OWNER_PERMIT\0v2\0",
  "utf8",
);

export interface WalmartOwnerPermitClaims {
  exact_one_sku: true;
  marketplace_submission_max: 1;
  delist: false;
  reprice: false;
  purchase: false;
  schedule: false;
}

export interface WalmartOwnerPermitSignedBody {
  permit_id: string;
  action: typeof WALMART_OWNER_PERMIT_ACTION;
  environment: WalmartOwnerPermitEnvironment;
  engine_release_sha256: string;
  approval_sha256: string;
  doctor_receipt_sha256: string;
  apply_preview_receipt_sha256: string;
  certification_sha256: string;
  candidate_key: string;
  channel_sku_id: string;
  sku: string;
  upc: string;
  payload_sha256: string;
  store_index: number;
  seller_account_fingerprint_sha256: string;
  database_target_fingerprint_sha256: string;
  pilot_slot: 1 | 2;
  max_pilot_skus: 2;
  issued_at: string;
  expires_at: string;
  approved_by: string;
  decision_ref: string;
  live_submission_authorized: true;
  claims: WalmartOwnerPermitClaims;
}

export interface WalmartOwnerPermitSigningEnvelope {
  schema_version: typeof WALMART_OWNER_PERMIT_SCHEMA;
  algorithm: typeof WALMART_OWNER_PERMIT_ALGORITHM;
  key_id: string;
  owner_public_key_spki_sha256: string;
  signed_body: WalmartOwnerPermitSignedBody;
}

export interface WalmartOwnerPermit extends WalmartOwnerPermitSigningEnvelope {
  signature_base64: string;
  signature_sha256: string;
  permit_sha256: string;
}

export interface WalmartOwnerPermitSigningRequest
  extends WalmartOwnerPermitSigningEnvelope {
  signing_message_base64: string;
  signature_base64: "TODO_EXTERNAL_OWNER_ED25519_SIGNATURE_BASE64";
  signature_sha256: "TODO_AFTER_EXTERNAL_SIGNATURE";
  permit_sha256: "TODO_AFTER_EXTERNAL_SIGNATURE";
}

export type WalmartOwnerPermitTrustedKey = WalmartOwnerControlTrustedKey;

function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function canonicalBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 40 || /\s/.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64");
    return bytes.length > 0 && bytes.toString("base64") === value;
  } catch {
    return false;
  }
}

function validReference(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || /TODO|PLACEHOLDER/i.test(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return Boolean(url.protocol && url.protocol !== "javascript:");
  } catch {
    return false;
  }
}

function testFixtureKey(env: NodeJS.ProcessEnv): WalmartOwnerPermitTrustedKey | null {
  if (
    env.NODE_ENV !== "test" ||
    env.WALMART_NEW_SKU_TEST_MODE !== "1" ||
    !/\.fixture\.test(?::\d+)?$/i.test(
      (() => {
        try {
          return new URL(env.WALMART_API_BASE_URL ?? "").host;
        } catch {
          return "";
        }
      })(),
    )
  ) {
    return null;
  }
  const keyId = env.WALMART_NEW_SKU_TEST_OWNER_KEY_ID;
  const publicKey = env.WALMART_NEW_SKU_TEST_OWNER_PUBLIC_KEY_SPKI_DER_BASE64;
  if (!keyId || !publicKey) return null;
  const der = Buffer.from(publicKey, "base64");
  return {
    key_id: keyId,
    public_key_spki_der_base64: publicKey,
    public_key_spki_sha256: sha256Bytes(der),
    status: "ACTIVE",
    environment: "TEST_FIXTURE_ONLY",
  };
}

export function walmartOwnerPermitTrustedKeys(
  env: NodeJS.ProcessEnv = process.env,
): readonly WalmartOwnerPermitTrustedKey[] {
  const fixture = testFixtureKey(env);
  const productionKeys = walmartOwnerControlProductionTrustedKeys();
  const keys = fixture ? [...productionKeys, fixture] : [...productionKeys];
  const ids = new Set<string>();
  for (const key of keys) {
    validateWalmartOwnerControlTrustedKey(key);
    if (ids.has(key.key_id)) throw new Error("Duplicate Walmart owner permit key_id");
    ids.add(key.key_id);
  }
  return Object.freeze(keys);
}

export function inspectWalmartOwnerPermitTrustRoot(
  env: NodeJS.ProcessEnv = process.env,
  environment?: WalmartOwnerPermitEnvironment,
): {
  ready: boolean;
  active_key_ids: string[];
  active_key_fingerprints: string[];
} {
  const active = walmartOwnerPermitTrustedKeys(env).filter(
    (key) =>
      key.status === "ACTIVE" &&
      (environment === undefined || key.environment === environment),
  );
  return {
    ready: active.length > 0,
    active_key_ids: active.map((key) => key.key_id).sort(),
    active_key_fingerprints: active
      .map((key) => key.public_key_spki_sha256)
      .sort(),
  };
}

function resolveTrustedKey(
  keyId: string,
  env: NodeJS.ProcessEnv = process.env,
  expectedEnvironment: WalmartOwnerPermitEnvironment = "PRODUCTION",
): WalmartOwnerPermitTrustedKey {
  const key = walmartOwnerPermitTrustedKeys(env).find(
    (candidate) => candidate.key_id === keyId,
  );
  if (
    !key ||
    key.status !== "ACTIVE" ||
    key.environment !== expectedEnvironment
  ) {
    throw new Error("WALMART_OWNER_PERMIT_KEY_UNTRUSTED_OR_REVOKED");
  }
  return key;
}

/**
 * Test permits are deliberately a different authority domain. This helper is
 * used only to build/verify non-production fixtures; the mutation transport
 * always uses the default PRODUCTION verifier and therefore cannot accept a
 * TEST_FIXTURE_ONLY key.
 */
export function walmartOwnerPermitRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): WalmartOwnerPermitEnvironment {
  return testFixtureKey(env) ? "TEST_FIXTURE_ONLY" : "PRODUCTION";
}

/** Mutation-transport verifier domain. Test authority is accepted only by the
 * explicit fake-POST harness; normal test processes still exercise the
 * production fail-closed boundary. `testFixtureKey` additionally requires
 * NODE_ENV=test, TEST_MODE=1 and a `.fixture.test` Walmart host. */
export function walmartOwnerPermitTransportEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): WalmartOwnerPermitEnvironment {
  return env.WALMART_NEW_SKU_TEST_ALLOW_FEED_POST === "1"
    ? walmartOwnerPermitRuntimeEnvironment(env)
    : "PRODUCTION";
}

export function walmartOwnerPermitSigningMessage(
  envelope: WalmartOwnerPermitSigningEnvelope,
): Buffer {
  return Buffer.concat([
    SIGNING_DOMAIN,
    Buffer.from(stableWalmartJson(envelope), "utf8"),
  ]);
}

export function buildWalmartOwnerPermitSigningRequest(input: {
  key_id: string;
  signed_body: WalmartOwnerPermitSignedBody;
  env?: NodeJS.ProcessEnv;
}): WalmartOwnerPermitSigningRequest {
  const key = resolveTrustedKey(
    input.key_id,
    input.env,
    input.signed_body.environment,
  );
  const envelope: WalmartOwnerPermitSigningEnvelope = {
    schema_version: WALMART_OWNER_PERMIT_SCHEMA,
    algorithm: WALMART_OWNER_PERMIT_ALGORITHM,
    key_id: key.key_id,
    owner_public_key_spki_sha256: key.public_key_spki_sha256,
    signed_body: input.signed_body,
  };
  return {
    ...envelope,
    signing_message_base64: walmartOwnerPermitSigningMessage(envelope).toString("base64"),
    signature_base64: "TODO_EXTERNAL_OWNER_ED25519_SIGNATURE_BASE64",
    signature_sha256: "TODO_AFTER_EXTERNAL_SIGNATURE",
    permit_sha256: "TODO_AFTER_EXTERNAL_SIGNATURE",
  };
}

export function assembleWalmartOwnerPermit(input: {
  request: WalmartOwnerPermitSigningRequest;
  signature_base64: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): WalmartOwnerPermit {
  const signing_message_base64 = input.request.signing_message_base64;
  const envelope: WalmartOwnerPermitSigningEnvelope = {
    schema_version: input.request.schema_version,
    algorithm: input.request.algorithm,
    key_id: input.request.key_id,
    owner_public_key_spki_sha256:
      input.request.owner_public_key_spki_sha256,
    signed_body: input.request.signed_body,
  };
  if (
    signing_message_base64 !==
      walmartOwnerPermitSigningMessage(envelope).toString("base64") ||
    !canonicalBase64(input.signature_base64)
  ) {
    throw new Error("WALMART_OWNER_PERMIT_SIGNING_REQUEST_INVALID");
  }
  const signatureSha256 = sha256Bytes(Buffer.from(input.signature_base64, "base64"));
  const unsigned = {
    ...envelope,
    signature_base64: input.signature_base64,
    signature_sha256: signatureSha256,
  };
  const permit: WalmartOwnerPermit = {
    ...unsigned,
    permit_sha256: sha256Bytes(stableWalmartJson(unsigned)),
  };
  assertWalmartOwnerPermitSignature(permit, {
    env: input.env,
    now: input.now,
    expectedEnvironment: input.request.signed_body.environment,
  });
  return permit;
}

export interface WalmartOwnerPermitExpectedBindings {
  engine_release_sha256: string;
  approval_sha256: string;
  doctor_receipt_sha256: string;
  apply_preview_receipt_sha256: string;
  certification_sha256: string;
  candidate_key: string;
  channel_sku_id: string;
  sku: string;
  upc: string;
  payload_sha256: string;
  store_index: number;
  seller_account_fingerprint_sha256: string;
  database_target_fingerprint_sha256: string;
}

export function assertWalmartOwnerPermitSignature(
  permit: WalmartOwnerPermit,
  options: {
    expected?: WalmartOwnerPermitExpectedBindings;
    now?: Date;
    env?: NodeJS.ProcessEnv;
    expectedEnvironment?: WalmartOwnerPermitEnvironment;
  } = {},
): void {
  const body = permit.signed_body;
  const expectedEnvironment = options.expectedEnvironment ?? "PRODUCTION";
  const key = resolveTrustedKey(
    permit.key_id,
    options.env,
    expectedEnvironment,
  );
  const issuedAt = Date.parse(body?.issued_at);
  const expiresAt = Date.parse(body?.expires_at);
  const now = (options.now ?? new Date()).getTime();
  const digests = [
    permit.owner_public_key_spki_sha256,
    permit.signature_sha256,
    permit.permit_sha256,
    body?.engine_release_sha256,
    body?.approval_sha256,
    body?.doctor_receipt_sha256,
    body?.apply_preview_receipt_sha256,
    body?.certification_sha256,
    body?.payload_sha256,
    body?.seller_account_fingerprint_sha256,
    body?.database_target_fingerprint_sha256,
  ];
  const { permit_sha256: actualPermitSha, ...unsignedPermit } = permit;
  const envelope: WalmartOwnerPermitSigningEnvelope = {
    schema_version: permit.schema_version,
    algorithm: permit.algorithm,
    key_id: permit.key_id,
    owner_public_key_spki_sha256: permit.owner_public_key_spki_sha256,
    signed_body: body,
  };
  const signature = canonicalBase64(permit.signature_base64)
    ? Buffer.from(permit.signature_base64, "base64")
    : Buffer.alloc(0);
  const publicKey = createPublicKey({
    key: Buffer.from(key.public_key_spki_der_base64, "base64"),
    format: "der",
    type: "spki",
  });
  const expected = options.expected;
  if (
    permit.schema_version !== WALMART_OWNER_PERMIT_SCHEMA ||
    permit.algorithm !== WALMART_OWNER_PERMIT_ALGORITHM ||
    permit.owner_public_key_spki_sha256 !== key.public_key_spki_sha256 ||
    digests.some((value) => !isSha256(value)) ||
    actualPermitSha !== sha256Bytes(stableWalmartJson(unsignedPermit)) ||
    permit.signature_sha256 !== sha256Bytes(signature) ||
    signature.length !== 64 ||
    !verifySignature(null, walmartOwnerPermitSigningMessage(envelope), publicKey, signature) ||
    !/^[-a-zA-Z0-9:._/]{8,200}$/.test(body?.permit_id ?? "") ||
    body?.action !== WALMART_OWNER_PERMIT_ACTION ||
    body?.environment !== expectedEnvironment ||
    key.environment !== body?.environment ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > now + 5 * 60_000 ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 30 * 60_000 ||
    now > expiresAt ||
    !body?.approved_by?.trim() ||
    !validReference(body?.decision_ref) ||
    body?.live_submission_authorized !== true ||
    ![1, 2].includes(body?.pilot_slot) ||
    body?.max_pilot_skus !== 2 ||
    body?.claims?.exact_one_sku !== true ||
    body?.claims?.marketplace_submission_max !== 1 ||
    body?.claims?.delist !== false ||
    body?.claims?.reprice !== false ||
    body?.claims?.purchase !== false ||
    body?.claims?.schedule !== false ||
    (expected && Object.entries(expected).some(
      ([name, value]) => body?.[name as keyof WalmartOwnerPermitSignedBody] !== value,
    ))
  ) {
    throw new Error("WALMART_OWNER_PERMIT_SIGNATURE_OR_BINDING_INVALID");
  }
}
