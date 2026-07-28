/**
 * Deterministic intent parsing for the Command Center Walmart prompt.
 *
 * The Studio UI previously accepted a prompt such as "5 listings, 8 cans
 * each", omitted both structured values from the request, and silently stored
 * the pilot defaults (2 listings, pack of 2).  A marketplace request must
 * never be changed that way.  This module keeps prompt-derived and structured
 * intent visible, rejects disagreement, and enforces the exact capabilities
 * of the currently frozen Walmart pilot.
 */

export const WALMART_PILOT_MAX_LISTINGS = 2;
export const WALMART_PILOT_PACK_COUNTS = [2, 3] as const;

export type WalmartStudioRequestBlockerCode =
  | "LISTING_COUNT_CONFLICT"
  | "LISTING_COUNT_OUTSIDE_PILOT"
  | "PACK_COUNT_CONFLICT"
  | "PACK_COUNT_OUTSIDE_PILOT";

export interface WalmartStudioRequestBlocker {
  code: WalmartStudioRequestBlockerCode;
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
      message:
        `The prompt asks for ${parsed.listing_count} listings, but the ` +
        `Listings field says ${input.listingCount}. Make them match.`,
    });
  }
  if (listingCount > WALMART_PILOT_MAX_LISTINGS) {
    blockers.push({
      code: "LISTING_COUNT_OUTSIDE_PILOT",
      message:
        `The request asks for ${listingCount} listings. The currently ` +
        `verified Walmart pilot can prepare only 1–${WALMART_PILOT_MAX_LISTINGS} ` +
        "listings per request.",
    });
  }
  if (
    input.packCount != null &&
    parsed.pack_count != null &&
    input.packCount !== parsed.pack_count
  ) {
    blockers.push({
      code: "PACK_COUNT_CONFLICT",
      message:
        `The prompt asks for ${parsed.pack_count} units per listing, but the ` +
        `Units field says ${input.packCount}. Make them match.`,
    });
  }
  if (
    !WALMART_PILOT_PACK_COUNTS.includes(
      packCount as (typeof WALMART_PILOT_PACK_COUNTS)[number],
    )
  ) {
    blockers.push({
      code: "PACK_COUNT_OUTSIDE_PILOT",
      message:
        `The request asks for ${packCount} units per listing. The currently ` +
        `verified Walmart pilot supports only packs of ` +
        `${WALMART_PILOT_PACK_COUNTS.join(" or ")}.`,
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
