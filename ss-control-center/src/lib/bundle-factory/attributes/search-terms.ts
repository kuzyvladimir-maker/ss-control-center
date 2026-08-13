/**
 * generic_keyword — Amazon backend "search terms" builder.
 *
 * Amazon indexes `generic_keyword` for search, but the publisher NEVER populated
 * it: fill-map.ts declared it ("search terms from donor + theme") yet no code
 * filled it, and the DB `search_terms` field is only settable by hand. That is a
 * real search-visibility gap. This derives relevant backend terms from the
 * listing title + category synonyms; the publisher prefers a manual override
 * (`ChannelSKU.search_terms`) when present, else calls this.
 *
 * Backend keywords add value when they describe the exact product shoppers
 * might type; we mix product tokens from the title with narrow frozen-food
 * synonyms, dedup, and cap at Amazon's ~250-byte search-terms limit.
 * (A future upgrade can have Claude generate richer synonyms at content time.)
 */
const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "for", "with", "in", "to", "on", "by",
  "per", "pack", "count", "ct", "oz", "lb", "lbs", "total", "each", "includes",
  "include", "set", "sets", "box", "boxes", "piece", "pieces", "pcs", "size",
  "new", "assorted",
]);

const BASE_SYNONYMS = [
  "individually", "wrapped", "grab", "go", "snack", "lunchbox", "bulk",
];
const FROZEN_SYNONYMS = [
  "frozen", "thaw", "eat",
];

function uncrustablesCountPhrase(title: string): string | null {
  const total = [...title.matchAll(/(?:total\s+)?(\d{1,3})\s*(?:pieces?|count|ct)\b/giu)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (total.length === 0) return null;
  return `${total.at(-1)} count`;
}

/** Build a ≤maxBytes space-joined backend keyword string from a title. */
export function buildSearchTerms(
  title: string | null | undefined,
  brand?: string | null,
  maxBytes = 240,
): string {
  const brandTokens = new Set(
    (brand ?? "").toLowerCase().split(/\s+/).filter(Boolean),
  );
  const titleTokens = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s&-]/g, " ")
    .split(/\s+/)
    .filter(
      (w) =>
        w.length > 2 && !STOP.has(w) && !brandTokens.has(w) && !/^\d/.test(w),
    )
    .map((word) => word === "sandwiches" ? "sandwich" : word);
  const isFrozen = /frozen|chilled|refriger/i.test(title ?? "");
  const isUncrustables = /\buncrustables\b/i.test(title ?? "");

  const seen = new Set<string>();
  const parts: string[] = [];
  const push = (s: string) => {
    const k = s.toLowerCase().trim();
    if (k && !seen.has(k)) {
      seen.add(k);
      parts.push(k);
    }
  };
  // The historical Uncrustables winner indexed the exact product family,
  // flavor and total count. Preserve those high-intent facts instead of
  // diluting them with generic meal claims. The title remains the only source:
  // no sibling flavor or inferred package fact is introduced here.
  if (isUncrustables) push("uncrustables");
  titleTokens.forEach(push);
  if (isUncrustables) {
    push("sandwich");
    const countPhrase = uncrustablesCountPhrase(title ?? "");
    if (countPhrase) push(countPhrase);
  }
  if (isFrozen) FROZEN_SYNONYMS.forEach(push);
  BASE_SYNONYMS.forEach(push);

  let out = "";
  for (const p of parts) {
    const next = out ? `${out} ${p}` : p;
    if (Buffer.byteLength(next, "utf8") > maxBytes) break;
    out = next;
  }
  return out;
}
