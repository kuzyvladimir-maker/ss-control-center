/**
 * Deterministic intent parsing for the Command Center Walmart prompt.
 *
 * The Studio UI previously accepted a prompt such as "5 listings, 8 cans
 * each", omitted both structured values from the request, and silently stored
 * defaults (2 listings, pack of 2). A marketplace request must never be
 * changed that way. This module keeps prompt-derived and structured intent
 * visible and rejects disagreement.
 *
 * Owner requests are not constrained by the size of one protected marketplace
 * apply. A request for five listings is preserved as five one-listing work
 * items; the Walmart branch can execute those work items sequentially without
 * silently shrinking the requested assortment.
 */

export type WalmartStudioRequestBlockerCode =
  | "LISTING_COUNT_CONFLICT"
  | "PACK_COUNT_CONFLICT"
  | "PACK_COMPOSITION_CONFLICT";

export type WalmartStudioRequestBlockerKind = "INPUT_CONFLICT";

export interface WalmartStudioRequestBlocker {
  code: WalmartStudioRequestBlockerCode;
  kind: WalmartStudioRequestBlockerKind;
  can_data_collection_fix: false;
  message: string;
}

export interface WalmartPromptIntent {
  listing_count: number | null;
  pack_count: number | null;
  /** Different products sharing one listing. null means a plain multipack. */
  flavors_per_listing: number | null;
  /** Units of each product. flavors x units must equal pack_count. */
  units_per_flavor: number | null;
}

export interface WalmartStudioRequestIntent {
  listing_count: number;
  pack_count: number;
  /** 1 for the plain multipack this lane has always built. */
  flavors_per_listing: number;
  /** Units of each product; equals pack_count when there is one product. */
  units_per_flavor: number;
  prompt_listing_count: number | null;
  prompt_pack_count: number | null;
  blockers: WalmartStudioRequestBlocker[];
}

export interface WalmartStudioWorkItem {
  ordinal: number;
  listing_count: 1;
  pack_count: number;
}

function firstCapturedInteger(
  text: string,
  patterns: RegExp[],
): number | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isInteger(value) && value > 0 && value <= 500) return value;
  }
  return null;
}

export function parseWalmartPromptIntent(prompt: string): WalmartPromptIntent {
  const text = prompt.normalize("NFKC");
  const listingCount = firstCapturedInteger(text, [
    /(?:^|[^\p{L}\p{N}])(\d{1,3})\s+(?:нов(?:ый|ых|ые)\s+)?(?:листинг(?:а|ов|и)?|карточ(?:ки|ек)|sku)(?=$|[^\p{L}\p{N}])/iu,
    /(?:^|[^\p{L}\p{N}])(\d{1,3})\s+(?:new\s+)?(?:listings?|skus?|product\s+pages?)(?=$|[^\p{L}\p{N}])/iu,
  ]);
  const packCount = firstCapturedInteger(text, [
    /(?:по|фасовк\p{L}*\s+(?:должн\p{L}*\s+быть\s+)?по)\s*(\d{1,3})\s+(?:бан(?:ок|ки|ка)|штук(?:и)?|единиц(?:ы)?|упаков(?:ок|ки)|пач(?:ек|ки))(?=$|[^\p{L}\p{N}])/iu,
    /(?:^|[^\p{L}\p{N}])(\d{1,3})\s+(?:бан(?:ок|ки|ка)|штук(?:и)?|единиц(?:ы)?|упаков(?:ок|ки)|пач(?:ек|ки))\s+(?:в|на)\s+(?:одн\p{L}+\s+)?(?:листинг\p{L}*|карточк\p{L}*)(?=$|[^\p{L}\p{N}])/iu,
    /(?:pack|case|set)\s+(?:of\s+)?(\d{1,3})(?=$|[^\p{L}\p{N}])/iu,
    /(?:^|[^\p{L}\p{N}])(\d{1,3})[\s-]*(?:pack|count|ct)(?=$|[^\p{L}\p{N}])/iu,
    /(?:^|[^\p{L}\p{N}])(\d{1,3})\s+(?:cans?|units?|items?)\s+(?:per|in\s+each)\s+(?:listing|sku|pack)(?=$|[^\p{L}\p{N}])/iu,
  ]);
  // "по 2 вида супа … по 4 банки каждого вкуса" — the part that used to be
  // dropped silently, turning a mixed assortment into twenty single-flavor
  // packs. Read both halves; either one plus the pack size gives the other.
  const flavorsPerListing = firstCapturedInteger(text, [
    /(?:по|каждом\p{L}*\s+(?:должно\s+быть\s+)?по)\s*(\d{1,2})\s+(?:вид(?:а|ов)?|сорт(?:а|ов)?|вкус(?:а|ов)?|разновидност\p{L}*)(?=$|[^\p{L}\p{N}])/iu,
    /(?:^|[^\p{L}\p{N}])(\d{1,2})\s+(?:вид(?:а|ов)?|сорт(?:а|ов)?|вкус(?:а|ов)?)\s+(?:в|на)\s+(?:одн\p{L}+\s+)?(?:листинг\p{L}*|карточк\p{L}*|набор\p{L}*)(?=$|[^\p{L}\p{N}])/iu,
    /(?:^|[^\p{L}\p{N}])(\d{1,2})\s+(?:different\s+)?(?:flavou?rs?|varieties|kinds|types)(?=$|[^\p{L}\p{N}])/iu,
    // Last resort: a bare "3 вида" with no preposition and no trailing clause.
    // Without this, "8 банок, 3 вида" parsed as no mix at all and quietly built
    // eight cans of one soup — the silent wrong build the review caught.
    /(?:^|[^\p{L}\p{N}])(\d{1,2})\s+(?:вид(?:а|ов)?|сорт(?:а|ов)?|вкус(?:а|ов)?)(?=$|[^\p{L}\p{N}])/iu,
  ]);
  const unitsPerFlavor = firstCapturedInteger(text, [
    /(?:по)\s*(\d{1,3})\s+(?:бан(?:ок|ки|ка)|штук(?:и)?|единиц(?:ы)?|пач(?:ек|ки))\s+(?:каждого|кажд\p{L}+)(?=$|[^\p{L}\p{N}])/iu,
    /(?:^|[^\p{L}\p{N}])(\d{1,3})\s+(?:cans?|units?|items?)\s+(?:of\s+)?each(?=$|[^\p{L}\p{N}])/iu,
    // Bare "4 of each", with no unit noun — what the Interpret/Use-this button
    // writes back into the prompt. Unrecognised, the count was re-derived from
    // whatever pack size was in force, so changing Pack Count silently changed
    // "4 cans of each" into something else (third review, 2026-08-08).
    /(?:^|[^\p{L}\p{N}])(\d{1,3})\s+of\s+each(?=$|[^\p{L}\p{N}])/iu,
    /(?:^|[^\p{L}\p{N}])по\s*(\d{1,3})\s+кажд\p{L}+(?=$|[^\p{L}\p{N}])/iu,
  ]);

  return {
    listing_count: listingCount,
    pack_count: packCount,
    // Raw, exactly as the words said. The arithmetic happens in
    // resolveWalmartStudioRequestIntent, where the pack size in force is known:
    // resolving here against the PROMPT's pack count silently dropped the
    // composition whenever the operator supplied the count in the form instead
    // — which is what the Interpret/Use-this path does (re-review 2026-08-08).
    flavors_per_listing: flavorsPerListing,
    units_per_flavor: unitsPerFlavor,
  };
}

/**
 * Make the three numbers agree, or report no mix at all.
 *
 * Two of them determine the third, so a request only has to say two. When they
 * contradict each other the reading is not trustworthy enough to build on, and
 * a plain multipack — which the pack count alone already describes — is the
 * safer thing to fall back to.
 */
function resolvePromptComposition(
  flavors: number | null,
  units: number | null,
  packCount: number | null,
): {
  flavors_per_listing: number | null;
  units_per_flavor: number | null;
  contradictory?: boolean;
} {
  let resolvedFlavors = flavors;
  let resolvedUnits = units;
  if (resolvedFlavors && !resolvedUnits && packCount && packCount % resolvedFlavors === 0) {
    resolvedUnits = packCount / resolvedFlavors;
  }
  if (resolvedUnits && !resolvedFlavors && packCount && packCount % resolvedUnits === 0) {
    resolvedFlavors = packCount / resolvedUnits;
  }
  // A named number of kinds that does not divide the pack is a contradiction
  // even when the per-kind count was never stated: "8 банок, 3 вида" cannot be
  // built, and silently making it one product would ship eight of one soup.
  if (resolvedFlavors && resolvedFlavors >= 2 && !resolvedUnits && packCount) {
    return {
      flavors_per_listing: resolvedFlavors,
      units_per_flavor: null,
      contradictory: true,
    };
  }
  if (!resolvedFlavors || resolvedFlavors < 2 || !resolvedUnits) {
    return { flavors_per_listing: null, units_per_flavor: null };
  }
  if (packCount && resolvedFlavors * resolvedUnits !== packCount) {
    // Contradictory, and it must NOT quietly become a single-product pack:
    // "8 банок, 3 вида по 3" would then build eight cans of one soup. Report
    // the mix that was asked for so the caller can raise it as a conflict.
    return {
      flavors_per_listing: resolvedFlavors,
      units_per_flavor: resolvedUnits,
      contradictory: true,
    };
  }
  return { flavors_per_listing: resolvedFlavors, units_per_flavor: resolvedUnits };
}

export function resolveWalmartStudioRequestIntent(input: {
  prompt: string;
  listingCount: number | null;
  packCount: number | null;
}): WalmartStudioRequestIntent {
  const parsed = parseWalmartPromptIntent(input.prompt);
  const listingCount = input.listingCount ?? parsed.listing_count ?? 2;
  const packCount = input.packCount ?? parsed.pack_count ?? 2;
  const blockers: WalmartStudioRequestBlocker[] = [];

  if (
    input.listingCount != null &&
    parsed.listing_count != null &&
    input.listingCount !== parsed.listing_count
  ) {
    blockers.push({
      code: "LISTING_COUNT_CONFLICT",
      kind: "INPUT_CONFLICT",
      can_data_collection_fix: false,
      message:
        `The prompt asks for ${parsed.listing_count} listings, but the ` +
        `Listings field says ${input.listingCount}. Make them match.`,
    });
  }
  if (
    input.packCount != null &&
    parsed.pack_count != null &&
    input.packCount !== parsed.pack_count
  ) {
    blockers.push({
      code: "PACK_COUNT_CONFLICT",
      kind: "INPUT_CONFLICT",
      can_data_collection_fix: false,
      message:
        `The prompt asks for ${parsed.pack_count} units per listing, but the ` +
        `Units field says ${input.packCount}. Make them match.`,
    });
  }
  // The mix is only honoured when it divides the pack size actually being
  // built. If the operator overrode the units field, the prompt's "4 of each"
  // may no longer fit — and quietly building a different composition than the
  // one asked for is the failure this whole change exists to prevent.
  const resolvedComposition = resolvePromptComposition(
    parsed.flavors_per_listing,
    parsed.units_per_flavor,
    packCount,
  );
  const composition = resolvedComposition.flavors_per_listing
    && resolvedComposition.units_per_flavor
    && !resolvedComposition.contradictory
    ? {
      flavors: resolvedComposition.flavors_per_listing,
      units: resolvedComposition.units_per_flavor,
    }
    : { flavors: 1, units: packCount };
  if (parsed.flavors_per_listing && composition.flavors === 1) {
    blockers.push({
      code: "PACK_COMPOSITION_CONFLICT",
      kind: "INPUT_CONFLICT",
      can_data_collection_fix: false,
      message:
        `The prompt asks for ${parsed.flavors_per_listing} kinds per listing`
        + (parsed.units_per_flavor ? ` of ${parsed.units_per_flavor} each` : "")
        + `, which does not add up to ${packCount} units. Make them match.`,
    });
  }

  return {
    listing_count: listingCount,
    pack_count: packCount,
    flavors_per_listing: composition.flavors,
    units_per_flavor: composition.units,
    prompt_listing_count: parsed.listing_count,
    prompt_pack_count: parsed.pack_count,
    blockers,
  };
}

/**
 * Split a complete owner request into the one-listing units consumed by the
 * protected Walmart workflow. This is an execution detail, not an owner-facing
 * request limit.
 */
export function buildWalmartStudioWorkItems(
  intent: Pick<WalmartStudioRequestIntent, "listing_count" | "pack_count">,
): WalmartStudioWorkItem[] {
  return Array.from({ length: intent.listing_count }, (_, index) => ({
    ordinal: index + 1,
    listing_count: 1,
    pack_count: intent.pack_count,
  }));
}
