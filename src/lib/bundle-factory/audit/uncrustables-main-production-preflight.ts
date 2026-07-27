/**
 * Production boundary for Uncrustables MAIN-image authenticity.
 *
 * The reviewed registry and owner approvals below are versioned, immutable,
 * SHA-sealed artifacts. A runtime listing may use one only when its exact MAIN
 * bytes, SKU, canonical flavor quantities, total physical count, package mode,
 * package size/decomposition, visual observations, and human approval all
 * resolve to the same approved proof. Absence and ambiguity fail closed.
 */

// 2026-07-22 preview→publish batch: production proofs live in the v3 manifest
// and are bound to the MERGED registry (sealed v1 + the owner's 11-flavor
// extension) because the new listings use extension-only flavors. The v1/v2
// artifacts stay untouched on disk as history.
import approvalsJson from "./data/uncrustables-main-owner-approvals-v3.json";
import trialApprovalsJson from "./data/uncrustables-main-owner-approvals-trial1.json";

import { MERGED_UNCRUSTABLES_AUTHENTICITY_REGISTRY } from "./uncrustables-authenticity-merged";

import {
  evaluateUncrustablesMainAuthenticity,
  resolveReviewedUncrustablesFlavorId,
  uncrustablesAuthenticitySha256,
  uncrustablesAuthenticityStableJson,
  verifyUncrustablesAuthenticityRegistry,
  type UncrustablesAuthenticityRegistry,
  type UncrustablesMainAuthenticityInput,
  type UncrustablesMainAuthenticityResult,
} from "./uncrustables-main-authenticity";

export const UNCRUSTABLES_MAIN_OWNER_APPROVALS_SCHEMA =
  "uncrustables-main-owner-approvals/v2" as const;
export const UNCRUSTABLES_MAIN_PUBLISH_PERMIT_SCHEMA =
  "uncrustables-main-publish-permit/v2" as const;

export interface UncrustablesOwnerApprovedMainProof
  extends Omit<UncrustablesMainAuthenticityInput, "registry"> {
  proof_id: string;
  asin: string;
  approval_scope: "style-reference-only" | "production-main";
  production_eligible: boolean;
  pixel_dimensions: { width: number; height: number };
  /** Required for production-main. A transformed image is a different asset
   * and must identify both its input and exact output bytes. */
  production_provenance?: {
    origin: "raw-generation" | "derived-artifact";
    output_sha256: string;
    source_image_sha256?: string;
    transformation_manifest: {
      kind: "generation-manifest";
      locator: string;
      sha256: string;
    };
  };
  human_approval: NonNullable<
    UncrustablesMainAuthenticityInput["human_approval"]
  >;
}

export interface UncrustablesMainOwnerApprovalManifestBody {
  schema_version: typeof UNCRUSTABLES_MAIN_OWNER_APPROVALS_SCHEMA;
  immutable: true;
  manifest_id: string;
  captured_at: string;
  approved_by: string;
  registry_sha256: string;
  entries: UncrustablesOwnerApprovedMainProof[];
}

export interface UncrustablesMainOwnerApprovalManifest
  extends UncrustablesMainOwnerApprovalManifestBody {
  sha256: string;
}

export interface ProductionUncrustablesRecipeComponent {
  product_name: string;
  flavor?: string | null;
  qty: number;
}

export interface ProductionUncrustablesMainIdentity {
  sku: string;
  main_image_url: string;
  pack_count: number;
  components: ProductionUncrustablesRecipeComponent[];
}

export type UncrustablesMainPreflightFailureCode =
  | "PRODUCTION_ARTIFACT_INVALID"
  | "NO_APPROVED_PROOF_FOR_SKU"
  | "APPROVAL_NOT_PRODUCTION_ELIGIBLE"
  | "IMAGE_URL_INVALID"
  | "IMAGE_FETCH_FAILED"
  | "IMAGE_HASH_NOT_APPROVED"
  | "IMAGE_DIMENSIONS_MISMATCH"
  | "RUNTIME_RECIPE_INVALID"
  | "RUNTIME_RECIPE_MISMATCH"
  | "AUTHENTICITY_GATE_BLOCKED";

export interface UncrustablesMainPreflightFinding {
  code: UncrustablesMainPreflightFailureCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface UncrustablesMainPublishPermitBody {
  schema_version: typeof UNCRUSTABLES_MAIN_PUBLISH_PERMIT_SCHEMA;
  immutable: true;
  sku: string;
  main_image_url: string;
  main_image_sha256: string;
  pack_count: number;
  runtime_recipe_sha256: string;
  proof_id: string;
  registry_sha256: string;
  owner_approval_manifest_sha256: string;
  approval_sha256: string;
  approved_subject_sha256: string;
  approved_recipe_sha256: string;
}

export interface UncrustablesMainPublishPermit
  extends UncrustablesMainPublishPermitBody {
  sha256: string;
}

export interface UncrustablesMainProductionPreflightResult {
  pass: boolean;
  decision: "CAN_PUBLISH" | "BLOCKED";
  findings: UncrustablesMainPreflightFinding[];
  image_sha256?: string;
  proof_id?: string;
  authenticity?: UncrustablesMainAuthenticityResult;
  permit?: UncrustablesMainPublishPermit;
}

export type UncrustablesMainImageBytesFetcher = (
  url: string,
) => Promise<Buffer>;

export const PRODUCTION_UNCRUSTABLES_AUTHENTICITY_REGISTRY =
  MERGED_UNCRUSTABLES_AUTHENTICITY_REGISTRY as unknown as UncrustablesAuthenticityRegistry;
export const PRODUCTION_UNCRUSTABLES_MAIN_OWNER_APPROVALS =
  approvalsJson as unknown as UncrustablesMainOwnerApprovalManifest;
// Sealed manifests are additive: batch 1+2 (v3) stays immutable; each later
// batch ships its own sealed manifest. Every manifest is verified in full and
// proof_id/subject uniqueness is enforced ACROSS manifests.
export const PRODUCTION_UNCRUSTABLES_MAIN_OWNER_APPROVAL_MANIFESTS = [
  approvalsJson,
  trialApprovalsJson,
] as unknown as UncrustablesMainOwnerApprovalManifest[];

function allProductionOwnerApprovedProofs(): UncrustablesOwnerApprovedMainProof[] {
  return PRODUCTION_UNCRUSTABLES_MAIN_OWNER_APPROVAL_MANIFESTS.flatMap(
    (manifest) => manifest.entries,
  );
}

function manifestContainingProof(
  proofId: string,
): UncrustablesMainOwnerApprovalManifest {
  const manifest = PRODUCTION_UNCRUSTABLES_MAIN_OWNER_APPROVAL_MANIFESTS.find(
    (candidate) => candidate.entries.some((proof) => proof.proof_id === proofId),
  );
  if (!manifest) {
    throw new Error(`No sealed owner-approval manifest contains proof ${proofId}.`);
  }
  return manifest;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const MAX_MAIN_IMAGE_BYTES = 25 * 1024 * 1024;
const MAIN_IMAGE_FETCH_TIMEOUT_MS = 20_000;

function digestObject(value: unknown): string {
  return uncrustablesAuthenticitySha256(
    uncrustablesAuthenticityStableJson(value),
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finding(
  code: UncrustablesMainPreflightFailureCode,
  message: string,
  details?: Record<string, unknown>,
): UncrustablesMainPreflightFinding {
  return details ? { code, message, details } : { code, message };
}

/** Throws when either production artifact, any proof, or any human seal drifts. */
export function verifyProductionUncrustablesAuthenticityArtifacts(): void {
  const registry = PRODUCTION_UNCRUSTABLES_AUTHENTICITY_REGISTRY;
  verifyUncrustablesAuthenticityRegistry(registry);
  // Uniqueness sets span ALL manifests: a proof_id or review subject may
  // never be approved twice, even across separately sealed batches.
  const proofIds = new Set<string>();
  const approvedSubjects = new Set<string>();
  for (const manifest of PRODUCTION_UNCRUSTABLES_MAIN_OWNER_APPROVAL_MANIFESTS) {
  if (
    manifest.schema_version !== UNCRUSTABLES_MAIN_OWNER_APPROVALS_SCHEMA ||
    manifest.immutable !== true ||
    !nonEmpty(manifest.manifest_id) ||
    !nonEmpty(manifest.approved_by) ||
    !nonEmpty(manifest.captured_at) ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length === 0 ||
    !SHA256_PATTERN.test(manifest.sha256)
  ) {
    throw new Error("Owner-approval manifest is incomplete or unsupported.");
  }
  const { sha256: claimedManifestSha, ...manifestBody } = manifest;
  if (claimedManifestSha.toLowerCase() !== digestObject(manifestBody)) {
    throw new Error("Owner-approval manifest SHA-256 seal does not match.");
  }
  if (manifest.registry_sha256.toLowerCase() !== registry.sha256.toLowerCase()) {
    throw new Error("Owner-approval manifest is bound to another registry.");
  }

  for (const proof of manifest.entries) {
    if (
      !nonEmpty(proof.proof_id) ||
      !nonEmpty(proof.sku) ||
      !nonEmpty(proof.asin) ||
      proof.image?.kind !== "generated-main" ||
      !SHA256_PATTERN.test(proof.image?.sha256 ?? "") ||
      proof.generation_manifest?.kind !== "generation-manifest" ||
      !SHA256_PATTERN.test(proof.generation_manifest?.sha256 ?? "") ||
      !Number.isInteger(proof.pixel_dimensions?.width) ||
      !Number.isInteger(proof.pixel_dimensions?.height) ||
      proof.pixel_dimensions.width <= 0 ||
      proof.pixel_dimensions.height <= 0 ||
      !proof.human_approval
    ) {
      throw new Error("Owner-approval manifest contains an incomplete proof.");
    }
    if (proofIds.has(proof.proof_id)) {
      throw new Error(`Duplicate owner-approved proof_id: ${proof.proof_id}.`);
    }
    proofIds.add(proof.proof_id);
    if (approvedSubjects.has(proof.human_approval.subject_sha256.toLowerCase())) {
      throw new Error("Two owner-approved proofs reuse the same review subject.");
    }
    approvedSubjects.add(proof.human_approval.subject_sha256.toLowerCase());
    if (
      proof.human_approval.reviewer !== manifest.approved_by ||
      proof.human_approval.decision !== "APPROVED"
    ) {
      throw new Error(`Proof ${proof.proof_id} lacks the declared owner approval.`);
    }
    if (proof.approval_scope === "style-reference-only") {
      if (proof.production_eligible !== false || proof.production_provenance) {
        throw new Error(
          `Style proof ${proof.proof_id} must not authorize production bytes.`,
        );
      }
    } else if (proof.approval_scope === "production-main") {
      const provenance = proof.production_provenance;
      if (
        proof.production_eligible !== true ||
        proof.pixel_dimensions.width < 2000 ||
        proof.pixel_dimensions.height < 2000 ||
        !provenance ||
        (provenance.origin !== "raw-generation" &&
          provenance.origin !== "derived-artifact") ||
        provenance.output_sha256.toLowerCase() !== proof.image.sha256.toLowerCase() ||
        provenance.transformation_manifest?.kind !== "generation-manifest" ||
        !nonEmpty(provenance.transformation_manifest.locator) ||
        !SHA256_PATTERN.test(provenance.transformation_manifest.sha256) ||
        (provenance.origin === "derived-artifact" &&
          (!SHA256_PATTERN.test(provenance.source_image_sha256 ?? "") ||
            provenance.source_image_sha256?.toLowerCase() ===
              proof.image.sha256.toLowerCase()))
      ) {
        throw new Error(
          `Production proof ${proof.proof_id} lacks 2000px+ exact derived/generation provenance.`,
        );
      }
    } else {
      throw new Error(`Proof ${proof.proof_id} has an unknown approval scope.`);
    }
    const result = evaluateUncrustablesMainAuthenticity({
      ...proof,
      registry,
    });
    if (!result.pass || !result.verified) {
      throw new Error(
        `Production proof ${proof.proof_id} fails authenticity: ${result.hard_fails
          .map((item) => item.code)
          .join(", ")}.`,
      );
    }
  }
  }
}

interface RuntimeRecipeResolution {
  quantities: Map<string, number>;
  total: number;
  sha256: string;
}

function resolveRuntimeRecipe(
  identity: ProductionUncrustablesMainIdentity,
): { value?: RuntimeRecipeResolution; error?: string } {
  if (
    !nonEmpty(identity.sku) ||
    !Number.isInteger(identity.pack_count) ||
    identity.pack_count <= 0 ||
    !Array.isArray(identity.components) ||
    identity.components.length === 0
  ) {
    return { error: "SKU, positive pack_count, and recipe components are required." };
  }
  const quantities = new Map<string, number>();
  let total = 0;
  for (const [index, component] of identity.components.entries()) {
    if (
      !component ||
      !nonEmpty(component.product_name) ||
      !Number.isInteger(component.qty) ||
      component.qty <= 0
    ) {
      return { error: `Runtime recipe component ${index} is incomplete.` };
    }
    const productFlavor = resolveReviewedUncrustablesFlavorId(
      PRODUCTION_UNCRUSTABLES_AUTHENTICITY_REGISTRY,
      component.product_name,
    );
    if (!productFlavor) {
      return {
        error: `Runtime product is absent from the reviewed registry: ${component.product_name}.`,
      };
    }
    if (nonEmpty(component.flavor)) {
      const explicitFlavor = resolveReviewedUncrustablesFlavorId(
        PRODUCTION_UNCRUSTABLES_AUTHENTICITY_REGISTRY,
        component.flavor,
      );
      if (!explicitFlavor) {
        return { error: `Runtime flavor is unknown: ${component.flavor}.` };
      }
      if (explicitFlavor !== productFlavor) {
        return {
          error: `Runtime flavor conflicts with product identity on component ${index}.`,
        };
      }
    }
    quantities.set(
      productFlavor,
      (quantities.get(productFlavor) ?? 0) + component.qty,
    );
    total += component.qty;
  }
  if (total !== identity.pack_count) {
    return {
      error: `Runtime recipe quantity ${total} does not equal pack_count ${identity.pack_count}.`,
    };
  }
  const canonical = [...quantities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([flavor_id, quantity]) => ({ flavor_id, quantity }));
  return { value: { quantities, total, sha256: digestObject(canonical) } };
}

function proofRecipeQuantities(
  proof: UncrustablesOwnerApprovedMainProof,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const component of proof.recipe.components) {
    const flavorId = resolveReviewedUncrustablesFlavorId(
      PRODUCTION_UNCRUSTABLES_AUTHENTICITY_REGISTRY,
      component.flavor,
    );
    if (!flavorId) {
      throw new Error(`Approved proof ${proof.proof_id} contains an unknown flavor.`);
    }
    out.set(flavorId, (out.get(flavorId) ?? 0) + component.quantity);
  }
  return out;
}

function sameQuantities(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([flavor, quantity]) => right.get(flavor) === quantity)
  );
}

function createPermit(args: {
  identity: ProductionUncrustablesMainIdentity;
  imageSha256: string;
  runtimeRecipeSha256: string;
  proof: UncrustablesOwnerApprovedMainProof;
  authenticity: UncrustablesMainAuthenticityResult;
}): UncrustablesMainPublishPermit {
  const body: UncrustablesMainPublishPermitBody = {
    schema_version: UNCRUSTABLES_MAIN_PUBLISH_PERMIT_SCHEMA,
    immutable: true,
    sku: args.identity.sku,
    main_image_url: args.identity.main_image_url,
    main_image_sha256: args.imageSha256.toLowerCase(),
    pack_count: args.identity.pack_count,
    runtime_recipe_sha256: args.runtimeRecipeSha256,
    proof_id: args.proof.proof_id,
    registry_sha256: PRODUCTION_UNCRUSTABLES_AUTHENTICITY_REGISTRY.sha256,
    owner_approval_manifest_sha256: manifestContainingProof(
      args.proof.proof_id,
    ).sha256,
    approval_sha256: args.proof.human_approval.sha256,
    approved_subject_sha256: args.authenticity.subject_sha256,
    approved_recipe_sha256: digestObject(args.proof.recipe),
  };
  return { ...body, sha256: digestObject(body) };
}

/**
 * Validate a declared exact hash (used by sealed offline repair manifests).
 * The live distribution path must call preflightProductionUncrustablesMain(),
 * which reads the URL bytes itself and does not trust a declared hash.
 */
export function preflightDeclaredUncrustablesMainHash(
  identity: ProductionUncrustablesMainIdentity & { image_sha256: string },
): UncrustablesMainProductionPreflightResult {
  try {
    verifyProductionUncrustablesAuthenticityArtifacts();
  } catch (error) {
    return {
      pass: false,
      decision: "BLOCKED",
      findings: [
        finding(
          "PRODUCTION_ARTIFACT_INVALID",
          error instanceof Error ? error.message : String(error),
        ),
      ],
    };
  }
  const allProofsForSku = allProductionOwnerApprovedProofs().filter(
    (proof) => proof.sku === identity.sku,
  );
  const proofsForSku = allProofsForSku.filter(
    (proof) =>
      proof.approval_scope === "production-main" &&
      proof.production_eligible === true,
  );
  if (allProofsForSku.length === 0) {
    return {
      pass: false,
      decision: "BLOCKED",
      findings: [
        finding(
          "NO_APPROVED_PROOF_FOR_SKU",
          `No owner-approved MAIN proof exists for SKU ${identity.sku}.`,
        ),
      ],
    };
  }
  if (proofsForSku.length === 0) {
    return {
      pass: false,
      decision: "BLOCKED",
      findings: [
        finding(
          "APPROVAL_NOT_PRODUCTION_ELIGIBLE",
          `SKU ${identity.sku} has owner-approved 1536px style references, but no separately reviewed 2000px+ production MAIN bytes.`,
        ),
      ],
    };
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(identity.main_image_url);
  } catch {
    return {
      pass: false,
      decision: "BLOCKED",
      findings: [finding("IMAGE_URL_INVALID", "MAIN image URL is invalid.")],
    };
  }
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username ||
    parsedUrl.password ||
    !parsedUrl.hostname.endsWith(".r2.dev")
  ) {
    return {
      pass: false,
      decision: "BLOCKED",
      findings: [
        finding(
          "IMAGE_URL_INVALID",
          "Uncrustables MAIN must use a credential-free HTTPS R2 URL.",
        ),
      ],
    };
  }
  if (!SHA256_PATTERN.test(identity.image_sha256)) {
    return {
      pass: false,
      decision: "BLOCKED",
      findings: [finding("IMAGE_HASH_NOT_APPROVED", "MAIN image SHA-256 is invalid.")],
    };
  }
  const proof = proofsForSku.find(
    (candidate) =>
      candidate.image.sha256.toLowerCase() === identity.image_sha256.toLowerCase(),
  );
  if (!proof) {
    return {
      pass: false,
      decision: "BLOCKED",
      image_sha256: identity.image_sha256.toLowerCase(),
      findings: [
        finding(
          "IMAGE_HASH_NOT_APPROVED",
          `Exact MAIN bytes for SKU ${identity.sku} have not been owner-approved.`,
        ),
      ],
    };
  }
  const runtime = resolveRuntimeRecipe(identity);
  if (!runtime.value) {
    return {
      pass: false,
      decision: "BLOCKED",
      image_sha256: identity.image_sha256.toLowerCase(),
      proof_id: proof.proof_id,
      findings: [
        finding("RUNTIME_RECIPE_INVALID", runtime.error ?? "Runtime recipe is invalid."),
      ],
    };
  }
  const approvedQuantities = proofRecipeQuantities(proof);
  const approvedTotal = [...approvedQuantities.values()].reduce(
    (sum, quantity) => sum + quantity,
    0,
  );
  if (
    approvedTotal !== identity.pack_count ||
    !sameQuantities(runtime.value.quantities, approvedQuantities)
  ) {
    return {
      pass: false,
      decision: "BLOCKED",
      image_sha256: identity.image_sha256.toLowerCase(),
      proof_id: proof.proof_id,
      findings: [
        finding(
          "RUNTIME_RECIPE_MISMATCH",
          "Runtime flavor quantities/count do not match the exact owner-approved package decomposition.",
          {
            runtime_pack_count: identity.pack_count,
            approved_pack_count: approvedTotal,
          },
        ),
      ],
    };
  }
  const authenticity = evaluateUncrustablesMainAuthenticity({
    ...proof,
    registry: PRODUCTION_UNCRUSTABLES_AUTHENTICITY_REGISTRY,
  });
  if (!authenticity.pass || !authenticity.verified) {
    return {
      pass: false,
      decision: "BLOCKED",
      image_sha256: identity.image_sha256.toLowerCase(),
      proof_id: proof.proof_id,
      authenticity,
      findings: [
        finding(
          "AUTHENTICITY_GATE_BLOCKED",
          "Exact owner-approved proof no longer passes the authenticity gate.",
          { hard_fails: authenticity.hard_fails.map((item) => item.code) },
        ),
      ],
    };
  }
  const permit = createPermit({
    identity,
    imageSha256: identity.image_sha256,
    runtimeRecipeSha256: runtime.value.sha256,
    proof,
    authenticity,
  });
  return {
    pass: true,
    decision: "CAN_PUBLISH",
    findings: [],
    image_sha256: identity.image_sha256.toLowerCase(),
    proof_id: proof.proof_id,
    authenticity,
    permit,
  };
}

function configuredR2Hostname(): string | null {
  const raw = process.env.R2_PUBLIC_URL;
  if (!raw) return null;
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function fetchProductionMainImageBytes(url: string): Promise<Buffer> {
  const parsed = new URL(url);
  const configuredHost = configuredR2Hostname();
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (!host.endsWith(".r2.dev") && host !== configuredHost)
  ) {
    throw new Error("MAIN image URL is not on the configured HTTPS R2 host.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAIN_IMAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(parsed, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`R2 returned HTTP ${response.status}.`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MAIN_IMAGE_BYTES) {
      throw new Error("MAIN image exceeds the 25 MiB verification limit.");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_MAIN_IMAGE_BYTES) {
      throw new Error("MAIN image is empty or exceeds the verification limit.");
    }
    return bytes;
  } finally {
    clearTimeout(timeout);
  }
}

function imagePixelDimensions(
  bytes: Buffer,
): { width: number; height: number } | null {
  const pngSignature = "89504e470d0a1a0a";
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).toString("hex") === pngSignature &&
    bytes.subarray(12, 16).toString("ascii") === "IHDR"
  ) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ]);
  let offset = 2;
  while (offset + 8 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) return null;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  return null;
}

/** Fetch and hash the exact runtime URL before any marketplace/DB mutation. */
export async function preflightProductionUncrustablesMain(
  identity: ProductionUncrustablesMainIdentity,
  options: { fetchImageBytes?: UncrustablesMainImageBytesFetcher } = {},
): Promise<UncrustablesMainProductionPreflightResult> {
  // A missing proof is rejected before any network read.
  if (
    !allProductionOwnerApprovedProofs().some(
      (proof) =>
        proof.sku === identity.sku &&
        proof.approval_scope === "production-main" &&
        proof.production_eligible === true,
    )
  ) {
    return preflightDeclaredUncrustablesMainHash({
      ...identity,
      image_sha256: "0".repeat(64),
    });
  }
  let bytes: Buffer;
  try {
    bytes = await (options.fetchImageBytes ?? fetchProductionMainImageBytes)(
      identity.main_image_url,
    );
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new Error("Image byte reader returned no bytes.");
    }
  } catch (error) {
    return {
      pass: false,
      decision: "BLOCKED",
      findings: [
        finding(
          "IMAGE_FETCH_FAILED",
          error instanceof Error ? error.message : String(error),
        ),
      ],
    };
  }
  const imageSha256 = uncrustablesAuthenticitySha256(bytes);
  const exactProof = allProductionOwnerApprovedProofs().find(
    (proof) =>
      proof.sku === identity.sku &&
      proof.approval_scope === "production-main" &&
      proof.production_eligible === true &&
      proof.image.sha256.toLowerCase() === imageSha256,
  );
  if (exactProof) {
    const dimensions = imagePixelDimensions(bytes);
    if (
      !dimensions ||
      dimensions.width < 2000 ||
      dimensions.height < 2000 ||
      dimensions.width !== exactProof.pixel_dimensions.width ||
      dimensions.height !== exactProof.pixel_dimensions.height
    ) {
      return {
        pass: false,
        decision: "BLOCKED",
        image_sha256: imageSha256,
        proof_id: exactProof.proof_id,
        findings: [
          finding(
            "IMAGE_DIMENSIONS_MISMATCH",
            "Exact MAIN bytes do not match the reviewed 2000px+ production dimensions.",
            {
              observed: dimensions,
              approved: exactProof.pixel_dimensions,
            },
          ),
        ],
      };
    }
  }
  return preflightDeclaredUncrustablesMainHash({
    ...identity,
    image_sha256: imageSha256,
  });
}

/** Validate a distribution-issued permit at the final Amazon boundary. */
export function verifyUncrustablesMainPublishPermit(
  permit: UncrustablesMainPublishPermit | null | undefined,
  expected: { sku: string; main_image_url: string; pack_count: number },
): { valid: boolean; error?: string } {
  if (!permit) return { valid: false, error: "Authenticity publish permit is missing." };
  try {
    verifyProductionUncrustablesAuthenticityArtifacts();
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (
    permit.schema_version !== UNCRUSTABLES_MAIN_PUBLISH_PERMIT_SCHEMA ||
    permit.immutable !== true ||
    !SHA256_PATTERN.test(permit.sha256)
  ) {
    return { valid: false, error: "Authenticity publish permit is malformed." };
  }
  const { sha256: claimed, ...body } = permit;
  if (claimed.toLowerCase() !== digestObject(body)) {
    return { valid: false, error: "Authenticity publish permit seal does not match." };
  }
  if (
    permit.sku !== expected.sku ||
    permit.main_image_url !== expected.main_image_url ||
    permit.pack_count !== expected.pack_count
  ) {
    return {
      valid: false,
      error: "Authenticity publish permit is bound to another SKU, URL, or count.",
    };
  }
  if (
    permit.registry_sha256 !==
      PRODUCTION_UNCRUSTABLES_AUTHENTICITY_REGISTRY.sha256
  ) {
    return { valid: false, error: "Authenticity publish permit is stale." };
  }
  const proof = allProductionOwnerApprovedProofs().find(
    (candidate) =>
      candidate.proof_id === permit.proof_id &&
      candidate.approval_scope === "production-main" &&
      candidate.production_eligible === true,
  );
  // The permit must carry the seal of the exact manifest holding its proof.
  if (
    proof &&
    permit.owner_approval_manifest_sha256 !==
      manifestContainingProof(proof.proof_id).sha256
  ) {
    return { valid: false, error: "Authenticity publish permit is stale." };
  }
  if (
    !proof ||
    proof.sku !== permit.sku ||
    proof.image.sha256.toLowerCase() !== permit.main_image_sha256.toLowerCase() ||
    proof.human_approval.sha256 !== permit.approval_sha256 ||
    proof.human_approval.subject_sha256 !== permit.approved_subject_sha256 ||
    digestObject(proof.recipe) !== permit.approved_recipe_sha256
  ) {
    return { valid: false, error: "Authenticity publish permit proof binding failed." };
  }
  return { valid: true };
}
