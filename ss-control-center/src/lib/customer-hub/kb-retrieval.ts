/**
 * Knowledge-base retrieval — pure functions, no DB access.
 *
 * Before 2026-10-19 the analyzer looked up KB examples with
 * `scenario contains <first 100 chars of the buyer message>`, which almost
 * never matched, so drafts were written without any worked example
 * (see docs/wiki/customer-hub-autopilot-architecture.md §3).
 *
 * Now:
 *   1. predictProblemTypes() — cheap keyword pre-classifier over the
 *      trigger-phrase table (CUSTOMER_HUB_ALGORITHM_v3.0.md §5), run
 *      BEFORE the LLM call.
 *   2. rankKnowledgeBase() — the caller loads KB rows for those types
 *      (the table is small), we rank them in memory by token overlap with
 *      the buyer message, same productType/channel, and source
 *      (owner examples beat hand seeds).
 */

/** T-type → trigger phrases (lower-case). Mirrors the algorithm doc §5. */
export const TRIGGER_PHRASES: Record<string, string[]> = {
  T1: ["where is", "where's my", "haven't received", "have not received", "not received", "when will", "tracking", "still waiting", "status of my order"],
  T2: ["never got", "didn't receive", "did not receive", "says delivered", "marked delivered", "shows delivered", "not delivered"],
  T3: ["took too long", "delayed", "late", "delay", "still not here"],
  T4: ["thawed", "melted", "warm", "spoiled", "rancid", "defrosted", "not frozen", "no ice", "ice packs"],
  T5: ["damaged", "broken", "crushed", "leaked", "leaking", "smashed", "dented"],
  T6: ["wrong item", "wrong product", "different item", "incorrect", "not what i ordered", "wrong flavor"],
  T7: ["missing", "incomplete", "only got", "only received", "short"],
  T8: ["expired", "best by", "expiration", "expiry"],
  T9: ["shipping cost", "too expensive", "shipping fee", "overcharged for shipping"],
  T10: ["cancel", "don't want", "do not want", "changed my mind"],
  T11: ["refund", "return", "money back", "reimburse"],
  T12: ["didn't order", "did not order", "not my order", "fraud", "unauthorized"],
  T13: ["a-to-z", "a to z", "atoz", "guarantee claim", "file a claim"],
  T14: ["1 star", "one star", "bad review", "negative review", "leave a review", "report you"],
  T15: ["sick", "food poisoning", "fda", "lawyer", "hospital", "allergic reaction", "vomit"],
  T16: ["pay extra", "postage due"],
  T17: ["taste", "quality", "doesn't work", "does not work", "stale"],
  T18: ["ingredients", "allergen", "allergy", "shelf life", "gluten", "do you have", "is this", "can you ship", "in stock"],
  T19: ["already refunded", "got refund", "received refund", "got a refund"],
};

export interface PredictedType {
  problemType: string;
  hits: number;
}

/**
 * Predict likely problem types from the buyer text. Returns types ordered
 * by number of trigger hits (most first). `shippingMismatch` always adds
 * T21 first — the canonical mismatch scenario must reach the prompt.
 */
export function predictProblemTypes(
  text: string | null | undefined,
  opts: { shippingMismatch?: boolean } = {}
): PredictedType[] {
  const lower = (text || "").toLowerCase();
  const out: PredictedType[] = [];
  for (const [type, phrases] of Object.entries(TRIGGER_PHRASES)) {
    let hits = 0;
    for (const p of phrases) if (lower.includes(p)) hits++;
    if (hits > 0) out.push({ problemType: type, hits });
  }
  out.sort((a, b) => b.hits - a.hits);
  if (opts.shippingMismatch) out.unshift({ problemType: "T21", hits: 99 });
  return out;
}

const STOPWORDS = new Set(
  "a an and are as at be but by can do for from has have hi hello i if in is it its me my no not of on or our please so that the their them there they this to was we were what when will with you your order amazon thank thanks dear regards".split(
    " "
  )
);

export function tokenize(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const raw of (text || "").toLowerCase().split(/[^a-z0-9']+/)) {
    const t = raw.replace(/'/g, "");
    if (t.length < 3 || STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

/** Overlap coefficient |A∩B| / min(|A|,|B|) — robust to length mismatch. */
export function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.min(a.size, b.size);
}

export interface RankableKbRow {
  problemType: string;
  scenario: string;
  customerSaid: string;
  productType?: string | null;
  source?: string | null;
  channel?: string | null;
}

export interface RankInput {
  customerMessage: string | null | undefined;
  productType?: string | null;
  channel?: string | null;
  predicted: PredictedType[];
}

export interface RankedCase<T> {
  row: T;
  score: number;
}

/**
 * Score = text overlap (0..1)
 *       + 0.35 if the row's type is the top predicted type, 0.2 if any predicted
 *       + 0.1 same productType, −0.3 different channel
 *       + 0.15 owner example (source=owner_chatgpt / owner_edit)
 */
export function rankKnowledgeBase<T extends RankableKbRow>(
  rows: T[],
  input: RankInput,
  limit = 4
): RankedCase<T>[] {
  const msgTokens = tokenize(input.customerMessage);
  const topType = input.predicted[0]?.problemType;
  const predictedSet = new Set(input.predicted.map((p) => p.problemType));

  const scored = rows.map((row) => {
    let score = overlap(msgTokens, tokenize(`${row.customerSaid} ${row.scenario}`));
    if (row.problemType === topType) score += 0.35;
    else if (predictedSet.has(row.problemType)) score += 0.2;
    if (input.productType && row.productType && row.productType === input.productType) score += 0.1;
    if (input.channel && row.channel && row.channel !== input.channel) score -= 0.3;
    if (row.source === "owner_chatgpt" || row.source === "owner_edit") score += 0.15;
    return { row, score: Math.round(score * 1000) / 1000 };
  });

  return scored
    .filter((s) => s.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
