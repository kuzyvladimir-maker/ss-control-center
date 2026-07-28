/**
 * Shared brand-voice library (Bundle Factory Phase 0.3).
 *
 * Single home for the brand-voice rules that apply to ALL listing content on
 * ALL channels (CLAUDE.md, owner rule 2026-05-19): no emojis, no promotional
 * adjectives, no health claims, no manual bullet glyphs, factual only.
 *
 * Previously these rules were duplicated in three places (compliance/
 * banned-words.ts, walmart/multipack/content.ts, Amazon Growth advisor). This
 * module is the canonical home: the banned-word LISTS live in
 * compliance/banned-words.ts and are re-exported here; the SCRUB + detection
 * helpers (emoji/promo) are defined here and built on those lists so nothing
 * drifts. Used by the listing builder (create), the multipack rewriter
 * (Walmart improve), and the Qualification Officer (pre-publish QA).
 */

import {
  PROMOTIONAL_BANNED,
  PROMOTIONAL_BANNED_LOWER,
  HEALTH_CLAIM_BANNED,
  HEALTH_CLAIM_BANNED_LOWER,
  FOREIGN_BRANDS_HARD_BLOCK,
  OWN_BRANDS,
  findBannedSubstrings,
  findForeignBrandsInText,
  stripOwnBrands,
} from "@/lib/bundle-factory/compliance/banned-words";

// Re-export the canonical lists + scanners so callers can `from "@/lib/brand-voice"`.
export {
  PROMOTIONAL_BANNED,
  HEALTH_CLAIM_BANNED,
  FOREIGN_BRANDS_HARD_BLOCK,
  OWN_BRANDS,
  findBannedSubstrings,
  findForeignBrandsInText,
  stripOwnBrands,
};

/** Emoji + symbol ranges + manual bullet glyphs (• ● ► ▪ ○). */
export const EMOJI_REGEX =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}•●►▪○]/gu;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Promo-adjective scrub regex, derived from the canonical PROMOTIONAL_BANNED
 *  list so it never drifts. Word-boundary, case-insensitive. */
const PROMO_REGEX = new RegExp(
  `\\b(${PROMOTIONAL_BANNED.map(escapeRegex).join("|")})\\b`,
  "gi",
);

/** True if the text contains any emoji / manual bullet glyph. */
export function hasEmoji(text: string): boolean {
  if (!text) return false;
  EMOJI_REGEX.lastIndex = 0;
  return EMOJI_REGEX.test(text);
}

/** Promo words present in the text (canonical substring scan). */
export function findPromoLanguage(text: string): string[] {
  return findBannedSubstrings(text, PROMOTIONAL_BANNED, PROMOTIONAL_BANNED_LOWER);
}

/** Health/medical claims present in the text (canonical substring scan). */
export function findHealthClaims(text: string): string[] {
  return findBannedSubstrings(text, HEALTH_CLAIM_BANNED, HEALTH_CLAIM_BANNED_LOWER);
}

/**
 * Enforce brand voice on one line of (typically donor-sourced) copy: drop
 * emojis, manual bullet glyphs, and promo adjectives; tidy whitespace +
 * punctuation; ensure a terminal period and a capitalized first letter.
 *
 * Behaviour preserved from the former Walmart multipack copy, but the promo
 * list is now the full canonical PROMOTIONAL_BANNED (more thorough).
 */
export function scrubBrandVoice(text: string): string {
  let t = (text || "").replace(EMOJI_REGEX, " ").replace(PROMO_REGEX, " ");
  t = t.replace(/\s{2,}/g, " ").replace(/\s+([,.;:!])/g, "$1").trim();
  t = t.replace(/^[\s,;:.\-–]+/, "").replace(/[\s,;:]+$/, "").trim();
  if (t && !/[.!?]$/.test(t)) t += ".";
  return t.charAt(0).toUpperCase() + t.slice(1);
}
