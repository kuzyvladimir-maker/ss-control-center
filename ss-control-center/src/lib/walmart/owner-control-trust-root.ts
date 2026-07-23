import { createHash, createPublicKey } from "node:crypto";

export type WalmartOwnerControlEnvironment =
  | "PRODUCTION"
  | "TEST_FIXTURE_ONLY";

export interface WalmartOwnerControlTrustedKey {
  key_id: string;
  public_key_spki_der_base64: string;
  public_key_spki_sha256: string;
  status: "ACTIVE" | "REVOKED";
  environment: WalmartOwnerControlEnvironment;
}

/**
 * One owner-control public key may authorize multiple independently
 * domain-separated Walmart actions. The private key never belongs in this
 * repository or any operator release. Adding/revoking a production public key
 * is an owner/Codex reviewed release change.
 */
const PINNED_OWNER_CONTROL_KEYS: readonly WalmartOwnerControlTrustedKey[] =
  Object.freeze([
    {
      key_id: "walmart-owner-control-2026-01",
      public_key_spki_der_base64:
        "MCowBQYDK2VwAyEAIT9cBEcfy0WfQAe5qb6z/R1E357FnZAce12X6XmBjTw=",
      public_key_spki_sha256:
        "ca74a2134808ab46eb162b14dfe481730fc69df00b57283cffd7a7bb1d37883a",
      status: "ACTIVE",
      environment: "PRODUCTION",
    },
  ]);

function canonicalBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 40 || /\s/u.test(value)) {
    return false;
  }
  try {
    const bytes = Buffer.from(value, "base64");
    return bytes.length > 0 && bytes.toString("base64") === value;
  } catch {
    return false;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateWalmartOwnerControlTrustedKey(
  key: WalmartOwnerControlTrustedKey,
): void {
  if (
    !/^[a-z0-9][a-z0-9._-]{2,127}$/iu.test(key.key_id) ||
    !canonicalBase64(key.public_key_spki_der_base64) ||
    !/^[a-f0-9]{64}$/u.test(key.public_key_spki_sha256) ||
    !["ACTIVE", "REVOKED"].includes(key.status) ||
    !["PRODUCTION", "TEST_FIXTURE_ONLY"].includes(key.environment)
  ) {
    throw new Error("Walmart owner-control trust root is malformed");
  }
  const der = Buffer.from(key.public_key_spki_der_base64, "base64");
  if (sha256(der) !== key.public_key_spki_sha256) {
    throw new Error("Walmart owner-control public-key fingerprint mismatch");
  }
  const publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Walmart owner-control trust root must be Ed25519");
  }
}

export function walmartOwnerControlProductionTrustedKeys():
readonly WalmartOwnerControlTrustedKey[] {
  const keys = [...PINNED_OWNER_CONTROL_KEYS];
  const ids = new Set<string>();
  for (const key of keys) {
    validateWalmartOwnerControlTrustedKey(key);
    if (key.environment !== "PRODUCTION") {
      throw new Error("Pinned Walmart owner-control key must be PRODUCTION");
    }
    if (ids.has(key.key_id)) {
      throw new Error("Duplicate Walmart owner-control key_id");
    }
    ids.add(key.key_id);
  }
  return Object.freeze(keys);
}
