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
import registryV3ExtJson from "./data/uncrustables-authenticity-registry-v3-extension.json";
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

const v3 = registryV3ExtJson as unknown as RegistryLike;

// v3 (owner review 2026-08-15) добавляет ВТОРУЮ и последующие розничные
// фасовки уже известным вкусам: виноград продаётся в 4/10/15/18/24. Поэтому
// его записи вливаются в существующий вкус ПО flavor_id, а не кладутся рядом
// отдельной записью — иначе verifier поймает дубль вкуса и коллизию алиасов.
function foldV3Arts(flavors: unknown[]): unknown[] {
  const extra = new Map<string, unknown[]>();
  for (const f of v3.flavors as Array<{ flavor_id: string; art: unknown[] }>) {
    extra.set(f.flavor_id, [...(extra.get(f.flavor_id) ?? []), ...f.art]);
  }
  const seen = new Set<string>();
  const out = flavors.map((f) => {
    const row = f as { flavor_id: string; art: unknown[] };
    const add = extra.get(row.flavor_id);
    if (!add) return f;
    seen.add(row.flavor_id);
    return { ...row, art: [...row.art, ...add] };
  });
  for (const id of extra.keys()) {
    if (!seen.has(id)) throw new Error(`v3 extension references unknown flavor_id: ${id}`);
  }
  return out;
}

const mergedBody = {
  schema_version: "uncrustables-authenticity-registry/v1",
  immutable: true,
  registry_id: "uncrustables-us-reviewed-package-art-merged-v1-plus-v2ext-plus-v3ext",
  reviewed_at: (v3.reviewed_at as string) ?? (v2.reviewed_at as string) ?? (v1.reviewed_at as string),
  reviewed_by: "owner",
  review_method: "human-visual-with-source-evidence",
  brand: v1.brand,
  flavors: foldV3Arts([...v1.flavors, ...v2.flavors]),
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
  /** Retail carton to draw; required once a flavor has more than one reviewed
   *  carton, otherwise resolution is ambiguous and fails closed. */
  retailPackSize?: number | null,
): ReturnType<typeof resolveReviewedUncrustablesPackageArt> {
  const direct = resolveReviewedUncrustablesPackageArt(
    MERGED_UNCRUSTABLES_AUTHENTICITY_REGISTRY,
    label,
    packMode,
    retailPackSize,
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
      retailPackSize,
    );
    if (art) return art;
  }
  return null;
}
