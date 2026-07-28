/**
 * Phase 2.6.1 — Smart Scrub for legacy AI-generated listing content.
 *
 * Amazon's modern PDP classifier (code 99300) rejects content with:
 *   - emojis (most unicode pictograph symbols)
 *   - manual bullet characters (•, ●, ►, ▪, ○, ▶, ➤, →)
 *   - subjective/promotional adjectives ("ultimate", "perfect", …)
 *   - HTML tags in product_description (esp. for grocery/food)
 *
 * Vladimir's brand-voice rule (CLAUDE.md, 2026-05-19) ALSO forbids all
 * of the above on every Salutem listing, so even when Amazon would let
 * something pass the operator wants it gone.
 *
 * This module deterministically normalises bullets + description to
 * plain factual text. No AI, no external calls, no cost. The discovery
 * pass (docs/PHASE_2_6_1_FAILED_CONTENT_ANALYSIS.md) confirmed both
 * AMZCOM and SALUTEM cohorts share the same dirty fingerprint, so a
 * single universal scrub applies to all 1038 plan rows.
 */

// Unicode pictograph + dingbat ranges. Covers ✅ 🍽 🎁 💚 🧊 ⭐ 🔥 ⚡ and
// the long tail (47 unique observed across SALUTEM samples). Combining
// marks (️ variation selector, ‍ zero-width joiner) are also
// stripped so they don't leave artefacts.
const EMOJI_AND_SYMBOL_REGEX =
  /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}︀-️‍]/gu;

// Manual bullet/list markers when they appear at the start of a line or
// after whitespace at the beginning of a fragment.
const MANUAL_BULLET_REGEX = /(?:^|\n)\s*[•●►▪○▶➤→‐-―]+\s*/g;

// Promotional / subjective adjectives. Stripped together with one
// trailing space so "the ultimate gift" → "the gift", not "the  gift".
// Order matters only for human readability — regex alternation is
// independent.
const PROMO_WORDS = [
  "ultimate",
  "perfect",
  "delightful",
  "delicious",
  "ideal",
  "amazing",
  "incredible",
  "premium",
  "exclusive",
  "must-have",
  "must have",
  "best",
  "finest",
  "exceptional",
  "outstanding",
  "magnificent",
  "wonderful",
  "fantastic",
  "superior",
  "top-quality",
  "top quality",
  "world-class",
  "world class",
  "awesome",
] as const;

const PROMO_WORDS_REGEX = new RegExp(
  `\\b(?:${PROMO_WORDS.join("|")})\\b\\s*`,
  "gi",
);

// HTML tag (open or close, with optional attributes). Anchored on `<`
// followed by a letter so we don't catch `<` from text like "less <
// more".
const HTML_TAG_REGEX = /<\/?[a-zA-Z][^>]*>/g;

const HTML_ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export interface ScrubBulletStats {
  inputBullets: number;
  outputBullets: number;
  filteredEmpty: number;
}

/**
 * Scrub a single bullet entry. May expand into multiple bullets if the
 * input contains newline-separated micro-bullets (the AMZCOM template
 * frequently stacks two `• ... • ...` lines into one stored bullet).
 *
 * Output bullets shorter than 8 chars are filtered out — they're almost
 * always residue from a bullet that was all-emojis or all-promo-words.
 */
export function scrubBullet(input: string): string[] {
  if (!input || typeof input !== "string") return [];
  const lines = input.split(/\n+/).map((line) => line.trim()).filter(Boolean);

  const cleaned: string[] = [];
  for (const line of lines) {
    let text = line;
    // Strip manual bullet chars at the start
    text = text.replace(/^\s*[•●►▪○▶➤→‐-―]+\s*/g, "");
    // Mid-string bullet markers (rare, but normalise to space)
    text = text.replace(/[•●►▪○▶➤→]/g, "");
    // Strip emojis + variation selectors + ZWJ
    text = text.replace(EMOJI_AND_SYMBOL_REGEX, "");
    // Strip promo adjectives (and following space)
    text = text.replace(PROMO_WORDS_REGEX, "");
    // Normalize whitespace
    text = text.replace(/\s+/g, " ").trim();
    // Re-capitalise first letter if scrub lowercased it
    if (text.length > 0) {
      text = text.charAt(0).toUpperCase() + text.slice(1);
    }
    cleaned.push(text);
  }

  return cleaned.filter((line) => line.length >= 8);
}

/**
 * Scrub a list of bullets. May return more (multi-line expand) or fewer
 * (filtered too-short) bullets than the input.
 */
export function scrubBulletArray(bullets: string[]): string[] {
  const result: string[] = [];
  for (const bullet of bullets) {
    result.push(...scrubBullet(bullet));
  }
  return result;
}

/**
 * Scrub a product_description string. Strips HTML, emojis, and promo
 * adjectives; converts list HTML to plain-text markers so the structure
 * survives. Output is plain text with `\n\n` paragraph breaks.
 */
export function scrubDescription(input: string): string {
  if (!input || typeof input !== "string") return "";

  let text = input;

  // Structural HTML → plain-text equivalents BEFORE the generic strip
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<p[^>]*>/gi, "");
  text = text.replace(/<li[^>]*>/gi, "- ");
  text = text.replace(/<\/li>/gi, "\n");
  text = text.replace(/<\/?ul[^>]*>/gi, "\n");
  text = text.replace(/<\/?ol[^>]*>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  // Strip all remaining tags
  text = text.replace(HTML_TAG_REGEX, "");

  // Strip emojis
  text = text.replace(EMOJI_AND_SYMBOL_REGEX, "");
  // Strip promo words
  text = text.replace(PROMO_WORDS_REGEX, "");

  // Decode common HTML entities
  for (const [k, v] of Object.entries(HTML_ENTITY_MAP)) {
    text = text.split(k).join(v);
  }

  // Normalise whitespace (preserve paragraph breaks)
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}
