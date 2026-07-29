export type ProductTruthAuthoritativeWalmartOuterPackTitle = {
  status: "NONE" | "PARSED" | "INVALID" | "AMBIGUOUS";
  count: number | null;
  /** Ordered normalized tokens with only explicit outer-package syntax removed. */
  baseTokens: string[];
  /** Sorted unique token set for exact punctuation/case-insensitive equality. */
  normalizedBaseTokens: string[];
};

const OUTER_PACK_NOUNS = new Set([
  "pack",
  "packs",
  "pk",
  "case",
  "cases",
  "set",
  "sets",
  "lot",
  "lots",
]);

function orderedTokens(value: string | null | undefined): string[] {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Parse only explicit Walmart outer-multipack grammar. Ordinary inner counts
 * such as `12 ct` stay in the base title and no retailer/SEO words are removed.
 */
export function parseProductTruthAuthoritativeWalmartOuterPackTitle(
  value: string | null | undefined,
): ProductTruthAuthoritativeWalmartOuterPackTitle {
  const tokens = orderedTokens(value);
  const findings: Array<{ count: number; positions: number[] }> = [];
  let invalid = false;
  const add = (count: number, positions: number[]): void => {
    if (!Number.isInteger(count) || count < 1 || count > 999) {
      invalid = true;
      return;
    }
    findings.push({ count, positions });
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const compact = token.match(/^(\d+)(pack|packs|pk|case|cases|x)$/);
    if (compact) {
      add(Number(compact[1]), [index]);
      continue;
    }
    if (
      /^\d+$/.test(token)
      && (
        OUTER_PACK_NOUNS.has(tokens[index + 1] ?? "")
        || tokens[index + 1] === "x"
      )
    ) {
      add(Number(token), [index, index + 1]);
      continue;
    }
    if (
      OUTER_PACK_NOUNS.has(token)
      && tokens[index + 1] === "of"
      && /^\d+$/.test(tokens[index + 2] ?? "")
    ) {
      add(Number(tokens[index + 2]), [index, index + 1, index + 2]);
    }
  }
  const consumed = new Set(findings.flatMap((finding) => finding.positions));
  const counts = [...new Set(findings.map((finding) => finding.count))];
  const status = invalid
    ? "INVALID"
    : findings.length === 0
      ? "NONE"
      : counts.length === 1
        ? "PARSED"
        : "AMBIGUOUS";
  const baseTokens = tokens.filter((_, index) => !consumed.has(index));
  return {
    status,
    count: status === "PARSED" ? counts[0]! : null,
    baseTokens,
    normalizedBaseTokens: [...new Set(baseTokens)].sort(),
  };
}
