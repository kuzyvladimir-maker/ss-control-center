/**
 * Phase 2.4 Stage 6 — Validator 2: Bullets.
 *
 * Per-channel bullet count + per-bullet char limit + plain-text check.
 * The Stage 4 Compliance Gate (Rule 3) injects the disclaimer bullet, so
 * by Stage 6 we expect at least 1 bullet and at most the channel cap.
 */

import type { ValidatorFn } from "../types";

// Amazon allows up to 5 bullets (additional positions get suppressed).
// Walmart's grocery taxonomy also caps at 5 — Walmart shows only the
// first 5 in the description card.
const BULLET_COUNT_CAP_BY_CHANNEL: Record<string, number> = {
  AMAZON_PERSONAL: 10, // Amazon hard cap before code 99016
  AMAZON_SALUTEM: 10,
  AMAZON_AMZCOM: 10,
  AMAZON_SIRIUS: 10,
  AMAZON_RETAILER: 10,
  WALMART: 5,
  EBAY: 10,
  TIKTOK_1: 5,
  TIKTOK_2: 5,
};

// Per-bullet character cap. Amazon allows 500 per bullet; Walmart's
// shorter description format caps each at ~150.
const BULLET_CHAR_CAP_BY_CHANNEL: Record<string, number> = {
  AMAZON_PERSONAL: 500,
  AMAZON_SALUTEM: 500,
  AMAZON_AMZCOM: 500,
  AMAZON_SIRIUS: 500,
  AMAZON_RETAILER: 500,
  WALMART: 150,
  EBAY: 250,
  TIKTOK_1: 200,
  TIKTOK_2: 200,
};

const HTML_TAG = /<[a-zA-Z\/!][^>]*>/;
const EMOJI_OR_SYMBOL = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u;
const MANUAL_BULLET = /^[\s]*[•●►▪○▶➤→]/;

export const validatorBullets: ValidatorFn = async ({ sku }) => {
  let bullets: unknown;
  try {
    bullets = JSON.parse(sku.bullets || "[]");
  } catch (e) {
    return {
      validator_id: "validator-bullets",
      passed: false,
      severity: "error",
      message: `bullets JSON is malformed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!Array.isArray(bullets)) {
    return {
      validator_id: "validator-bullets",
      passed: false,
      severity: "error",
      message: "bullets is not an array",
    };
  }
  const strings = bullets.filter((b): b is string => typeof b === "string");
  if (strings.length === 0) {
    return {
      validator_id: "validator-bullets",
      passed: false,
      severity: "error",
      message: "bullets array is empty",
    };
  }

  const countCap = BULLET_COUNT_CAP_BY_CHANNEL[sku.channel] ?? 10;
  if (strings.length > countCap) {
    return {
      validator_id: "validator-bullets",
      passed: false,
      severity: "error",
      message: `bullets has ${strings.length} items; ${sku.channel} limit is ${countCap}.`,
      details: { count: strings.length, cap: countCap },
    };
  }

  const charCap = BULLET_CHAR_CAP_BY_CHANNEL[sku.channel] ?? 500;
  for (let i = 0; i < strings.length; i++) {
    const b = strings[i];
    if (b.length > charCap) {
      return {
        validator_id: "validator-bullets",
        passed: false,
        severity: "error",
        message: `bullets[${i}] is ${b.length} chars; ${sku.channel} limit is ${charCap}.`,
        details: { index: i, length: b.length, cap: charCap },
      };
    }
    if (HTML_TAG.test(b)) {
      return {
        validator_id: "validator-bullets",
        passed: false,
        severity: "error",
        message: `bullets[${i}] contains an HTML tag`,
        details: { index: i },
      };
    }
    if (EMOJI_OR_SYMBOL.test(b)) {
      return {
        validator_id: "validator-bullets",
        passed: false,
        severity: "error",
        message: `bullets[${i}] contains an emoji or pictograph symbol`,
        details: { index: i },
      };
    }
    if (MANUAL_BULLET.test(b)) {
      return {
        validator_id: "validator-bullets",
        passed: false,
        severity: "error",
        message: `bullets[${i}] starts with a manual bullet marker — Amazon renders bullets automatically`,
        details: { index: i },
      };
    }
  }

  return { validator_id: "validator-bullets", passed: true };
};
