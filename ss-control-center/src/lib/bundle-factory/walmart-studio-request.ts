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
  | "PACK_COUNT_CONFLICT";

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
}

export interface WalmartStudioRequestIntent {
  listing_count: number;
  pack_count: number;
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
  return {
    listing_count: listingCount,
    pack_count: packCount,
  };
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
  return {
    listing_count: listingCount,
    pack_count: packCount,
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
