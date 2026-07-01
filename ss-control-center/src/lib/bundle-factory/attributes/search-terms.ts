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
 * Backend keywords add value when they include synonyms/use-cases a shopper
 * might type; we mix product tokens from the title with frozen/food use-case
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
  "individually wrapped", "grab and go", "ready to eat", "snack", "lunch box",
  "bulk", "variety pack", "family pack",
];
const FROZEN_SYNONYMS = [
  "frozen", "freezer", "freezer meals", "thaw and eat", "no prep", "quick meal",
];

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
    );
  const isFrozen = /frozen|chilled|refriger/i.test(title ?? "");

  const seen = new Set<string>();
  const parts: string[] = [];
  const push = (s: string) => {
    const k = s.toLowerCase().trim();
    if (k && !seen.has(k)) {
      seen.add(k);
      parts.push(k);
    }
  };
  titleTokens.forEach(push);
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
