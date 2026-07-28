import type {
  ResolvedReviewedUncrustablesPackageArt,
} from "./uncrustables-main-authenticity";

export type ReviewedCartonDecompositionFailureCode =
  | "INVALID_FLAVOR"
  | "INVALID_QUANTITY"
  | "NO_REVIEWED_CARTON_ART"
  | "ART_SCOPE_MISMATCH"
  | "ART_INVALID"
  | "AMBIGUOUS_REVIEWED_PACK_SIZE"
  | "NO_EXACT_DECOMPOSITION";

export interface ReviewedCartonPlanLine {
  flavor_id: string;
  art_id: string;
  retail_pack_size: number;
  visible_carton_count: number;
}

export type ReviewedCartonDecomposition =
  | {
      ok: true;
      flavor_id: string;
      quantity: number;
      total_cartons: number;
      /** Grouped in the stable order supplied by the reviewed registry. */
      lines: ReviewedCartonPlanLine[];
      /** Expanded in the same stable registry order; useful for exact QA. */
      expanded_pack_sizes: number[];
    }
  | {
      ok: false;
      code: ReviewedCartonDecompositionFailureCode;
      message: string;
    };

function fail(
  code: ReviewedCartonDecompositionFailureCode,
  message: string,
): ReviewedCartonDecomposition {
  return { ok: false, code, message };
}

function compareStableIndexSequences(left: number[], right: number[]): number {
  if (left.length !== right.length) return left.length - right.length;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

const SOURCE_EVIDENCE_KINDS = new Set([
  "retailer-product-page",
  "retailer-source-image",
  "manufacturer-source",
  "reviewed-artifact",
]);

function validReviewedEvidence(
  evidence: ResolvedReviewedUncrustablesPackageArt["evidence"][number],
): boolean {
  return (
    typeof evidence === "object" &&
    evidence !== null &&
    SOURCE_EVIDENCE_KINDS.has(evidence.kind) &&
    typeof evidence.locator === "string" &&
    evidence.locator.trim().length > 0 &&
    !/[\u0000-\u001f]/.test(evidence.locator) &&
    typeof evidence.sha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(evidence.sha256)
  );
}

/**
 * Find an exact single-flavor retail-carton decomposition using only package
 * designs already reviewed for that exact flavor.
 *
 * Selection is deterministic: minimize physical carton count first, then use
 * the supplied registry order as the tie-breaker. Invalid, cross-flavor,
 * wrapper, duplicate-size, or non-decomposable inputs fail closed.
 */
export function planExactReviewedCartonDecomposition(args: {
  flavor_id: string;
  quantity: number;
  reviewed_art: readonly ResolvedReviewedUncrustablesPackageArt[];
}): ReviewedCartonDecomposition {
  const flavorId = args.flavor_id.trim();
  if (!flavorId) {
    return fail("INVALID_FLAVOR", "An exact reviewed flavor_id is required.");
  }
  if (!Number.isInteger(args.quantity) || args.quantity <= 0) {
    return fail(
      "INVALID_QUANTITY",
      "Recipe quantity must be a positive integer.",
    );
  }
  if (args.reviewed_art.length === 0) {
    return fail(
      "NO_REVIEWED_CARTON_ART",
      `No reviewed retail-carton art exists for ${flavorId}.`,
    );
  }

  const seenArtIds = new Set<string>();
  const seenPackSizes = new Set<number>();
  for (const artCandidate of args.reviewed_art) {
    if (typeof artCandidate !== "object" || artCandidate === null) {
      return fail(
        "ART_INVALID",
        "Reviewed art entry is missing or malformed.",
      );
    }
    const art = artCandidate as ResolvedReviewedUncrustablesPackageArt;
    if (art.flavor_id !== flavorId || art.pack_mode !== "retail-carton") {
      return fail(
        "ART_SCOPE_MISMATCH",
        `Reviewed art ${art.art_id || "<missing>"} is not retail-carton art for exact flavor ${flavorId}.`,
      );
    }
    if (
      typeof art.art_id !== "string" ||
      !art.art_id.trim() ||
      seenArtIds.has(art.art_id) ||
      !Number.isInteger(art.retail_pack_size) ||
      art.retail_pack_size < 2 ||
      !Array.isArray(art.evidence) ||
      art.evidence.length === 0 ||
      art.evidence.some((evidence) => !validReviewedEvidence(evidence)) ||
      new Set(
        art.evidence.map((evidence) =>
          `${evidence.kind}\u0000${evidence.locator}\u0000${evidence.sha256.toLowerCase()}`),
      ).size !== art.evidence.length
    ) {
      return fail(
        "ART_INVALID",
        `Reviewed art ${art.art_id || "<missing>"} or its exact source evidence is incomplete, malformed, or duplicated.`,
      );
    }
    if (seenPackSizes.has(art.retail_pack_size)) {
      return fail(
        "AMBIGUOUS_REVIEWED_PACK_SIZE",
        `More than one reviewed ${art.retail_pack_size}-count design exists for ${flavorId}; an explicit art decision is required.`,
      );
    }
    seenArtIds.add(art.art_id);
    seenPackSizes.add(art.retail_pack_size);
  }

  // Each state is a canonical nondecreasing sequence of registry indexes.
  // Comparing sequence length minimizes cartons; lexicographic comparison
  // makes the original reviewed-registry order the stable tie-breaker.
  const best: Array<number[] | null> = Array.from(
    { length: args.quantity + 1 },
    () => null,
  );
  best[0] = [];
  for (let units = 1; units <= args.quantity; units += 1) {
    for (let artIndex = 0; artIndex < args.reviewed_art.length; artIndex += 1) {
      const size = args.reviewed_art[artIndex].retail_pack_size;
      const prior = units >= size ? best[units - size] : null;
      if (!prior) continue;
      const candidate = [...prior, artIndex].sort((left, right) => left - right);
      const current = best[units];
      if (!current || compareStableIndexSequences(candidate, current) < 0) {
        best[units] = candidate;
      }
    }
  }

  const selected = best[args.quantity];
  if (!selected) {
    return fail(
      "NO_EXACT_DECOMPOSITION",
      `Quantity ${args.quantity} has no exact decomposition using reviewed ${flavorId} pack sizes [${args.reviewed_art.map((art) => art.retail_pack_size).join(", ")}].`,
    );
  }

  const counts = new Map<number, number>();
  for (const artIndex of selected) {
    counts.set(artIndex, (counts.get(artIndex) ?? 0) + 1);
  }
  const lines = args.reviewed_art.flatMap((art, artIndex) => {
    const visibleCartonCount = counts.get(artIndex) ?? 0;
    return visibleCartonCount === 0
      ? []
      : [{
          flavor_id: flavorId,
          art_id: art.art_id,
          retail_pack_size: art.retail_pack_size,
          visible_carton_count: visibleCartonCount,
        }];
  });
  const expandedPackSizes = lines.flatMap((line) =>
    Array.from(
      { length: line.visible_carton_count },
      () => line.retail_pack_size,
    ),
  );

  return {
    ok: true,
    flavor_id: flavorId,
    quantity: args.quantity,
    total_cartons: selected.length,
    lines,
    expanded_pack_sizes: expandedPackSizes,
  };
}
