/**
 * Deterministic signals from Walmart US Product details policy, updated
 * 2026-05-21. These are fail-closed pilot checks for explicit violations;
 * they do not replace the candidate-bound human policy review or live spec.
 */

const URL_SIGNAL = /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org)\b)/i;
const RETAILER_SIGNAL = /\b(?:walmart|amazon|target|ebay)\b/i;
const PROMOTIONAL_SIGNAL =
  /\b(?:free shipping|walmart fulfilled|hot sale|top rated|premium quality|best[- ]selling|clearance|black friday|savings|low price)\b/i;
const AVAILABILITY_SIGNAL = /\b(?:coming soon|out[- ]of[- ]stock|discontinued)\b/i;
const TITLE_SPECIAL_CHARACTER_SIGNAL = /[~!*$]/;
const TITLE_YEAR_SIGNAL = /\b20\d{2}\b/;

export type WalmartProductDetailField = "TITLE" | "DESCRIPTION" | "KEY_FEATURE";

function isAllCapsTitle(value: string): boolean {
  const letters = value.match(/[A-Za-z]/g) ?? [];
  return letters.length >= 4 && letters.every((letter) => letter === letter.toUpperCase());
}

export function walmartProductDetailTextViolation(
  value: string,
  field: WalmartProductDetailField,
): string | null {
  if (URL_SIGNAL.test(value)) return "external URL";
  if (RETAILER_SIGNAL.test(value)) return "retailer name";
  if (PROMOTIONAL_SIGNAL.test(value)) return "promotional claim";
  if (AVAILABILITY_SIGNAL.test(value)) return "availability or lifecycle text";
  if (field === "TITLE") {
    if (isAllCapsTitle(value)) return "all-caps title";
    if (TITLE_SPECIAL_CHARACTER_SIGNAL.test(value)) return "prohibited title character";
    if (TITLE_YEAR_SIGNAL.test(value)) return "unsupported year in title";
  }
  return null;
}
