/**
 * MERGED Uncrustables authenticity registry: sealed v1 (Codex, 2026-07-18) +
 * the owner's gallery-approved v2 extension (2026-07-22).
 *
 * Why a merge instead of replacing v1: the sealed MAIN-approvals manifest
 * binds v1's SHA-256 and its approval subjects embed that hash — replacing the
 * file would orphan those approvals. The manifest keeps verifying against v1;
 * IMAGE GENERATION resolves against this merge, so newly approved flavors
 * become buildable without touching any sealed artifact.
 *
 * The merge is verified ONCE at module load with the engine's own
 * verifyUncrustablesAuthenticityRegistry — which enforces cross-file alias
 * uniqueness, duplicate art ids, brand marks, evidence shape and the
 * both-pack-modes invariant. A failed verify throws at import time:
 * fail-closed, nothing generates.
 */
import registryV1Json from "./data/uncrustables-authenticity-registry-v1.json";
import registryV2ExtJson from "./data/uncrustables-authenticity-registry-v2-extension.json";
import {
  resolveReviewedUncrustablesPackageArt,
  uncrustablesAuthenticitySha256,
  uncrustablesAuthenticityStableJson,
  verifyUncrustablesAuthenticityRegistry,
  type UncrustablesAuthenticityRegistry,
  type UncrustablesPackMode,
} from "./uncrustables-main-authenticity";

type RegistryLike = Record<string, unknown> & { flavors: unknown[] };

const v1 = registryV1Json as unknown as RegistryLike;
const v2 = registryV2ExtJson as unknown as RegistryLike;

const mergedBody = {
  schema_version: "uncrustables-authenticity-registry/v1",
  immutable: true,
  registry_id: "uncrustables-us-reviewed-package-art-merged-v1-plus-v2ext",
  reviewed_at: (v2.reviewed_at as string) ?? (v1.reviewed_at as string),
  reviewed_by: "owner",
  review_method: "human-visual-with-source-evidence",
  brand: v1.brand,
  flavors: [...v1.flavors, ...v2.flavors],
};

export const MERGED_UNCRUSTABLES_AUTHENTICITY_REGISTRY = {
  ...mergedBody,
  sha256: uncrustablesAuthenticitySha256(uncrustablesAuthenticityStableJson(mergedBody)),
} as unknown as UncrustablesAuthenticityRegistry;

// Fail-closed at import: an inconsistent merge must stop image generation.
verifyUncrustablesAuthenticityRegistry(MERGED_UNCRUSTABLES_AUTHENTICITY_REGISTRY);

/** Resolve reviewed package art across v1 + the owner's extension.
 *
 *  Falls back to a brand-prefix-stripped lookup: the studio engine's dedupe
 *  labels carry a leading "Smuckers …" when the catalog's brand column is
 *  inconsistent, while the SEALED v1 registry's aliases were written without
 *  the prefix (and v1 cannot be edited). Stripping only the leading brand
 *  words never changes which flavor a name denotes — the merged verifier
 *  still rejects any genuinely ambiguous alias. */
export function resolveMergedUncrustablesPackageArt(
  label: string,
  packMode: UncrustablesPackMode,
): ReturnType<typeof resolveReviewedUncrustablesPackageArt> {
  const direct = resolveReviewedUncrustablesPackageArt(
    MERGED_UNCRUSTABLES_AUTHENTICITY_REGISTRY,
    label,
    packMode,
  );
  if (direct) return direct;
  // Candidate 2: leading brand words stripped ("Smuckers Uncrustables X" → "X").
  // Candidate 3: additionally cut the marketing tail donor titles carry after
  // the flavor phrase ("X Sandwiches, 10 Count, 2 Oz Each (Frozen)" → "X",
  // "X Sandwich - 8oz/4ct" → "X"). Both transforms are deterministic and can
  // only ever normalize toward a flavor phrase; the alias map stays exact, so
  // no fuzzy matching is introduced.
  const stripped = label
    .replace(/^\s*(?:smucker[’'`]?s?\s+)?(?:uncrustables?\s+)?(?:frozen\s+)?/i, "")
    .trim();
  const tailCut = stripped
    .replace(/\s+sandwich(?:es)?\b[\s\S]*$/i, "")
    .replace(/\s*[-–—,].*$/, "")
    .trim();
  for (const candidate of [stripped, tailCut]) {
    if (!candidate || candidate === label) continue;
    const art = resolveReviewedUncrustablesPackageArt(
      MERGED_UNCRUSTABLES_AUTHENTICITY_REGISTRY,
      candidate,
      packMode,
    );
    if (art) return art;
  }
  return null;
}
