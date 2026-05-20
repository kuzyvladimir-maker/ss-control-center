/**
 * Phase 2.4 Stage 6 — Validator 1: Title.
 *
 * Per-channel character cap + forbidden-char screen + a defence-in-depth
 * re-check for foreign brand names in the title (overlap with Rule 1 of
 * the compliance gate — we run it again here because by Stage 6 the
 * title has been adapted per channel and we want to fail fast at this
 * gate rather than at the final compliance-rerun validator).
 */

import { findForeignBrandsInText } from "@/lib/bundle-factory/compliance/banned-words";
import type { ValidatorFn } from "../types";

// Amazon main product title spec: 200 chars max. Walmart's grocery
// taxonomy enforces 75 chars; the Walmart marketplace spec allows up to
// 150 for some categories — we pick the lower cap to be safe.
const TITLE_CHAR_CAP_BY_CHANNEL: Record<string, number> = {
  AMAZON_PERSONAL: 200,
  AMAZON_SALUTEM: 200,
  AMAZON_AMZCOM: 200,
  AMAZON_SIRIUS: 200,
  AMAZON_RETAILER: 200,
  WALMART: 150,
  EBAY: 80,
  TIKTOK_1: 100,
  TIKTOK_2: 100,
};

// Characters that fail Amazon listing validation (PDP code 99021).
const FORBIDDEN_TITLE_CHARS = /[<>{}[\]^~`|\\]/;

export const validatorTitle: ValidatorFn = async ({ sku }) => {
  const title = (sku.title || "").trim();

  if (!title) {
    return {
      validator_id: "validator-title",
      passed: false,
      severity: "error",
      message: "Title is empty.",
    };
  }

  const cap = TITLE_CHAR_CAP_BY_CHANNEL[sku.channel] ?? 200;
  if (title.length > cap) {
    return {
      validator_id: "validator-title",
      passed: false,
      severity: "error",
      message: `Title is ${title.length} chars; ${sku.channel} limit is ${cap}.`,
      details: { length: title.length, cap },
    };
  }

  const forbidden = title.match(FORBIDDEN_TITLE_CHARS);
  if (forbidden) {
    return {
      validator_id: "validator-title",
      passed: false,
      severity: "error",
      message: `Title contains forbidden character ${JSON.stringify(forbidden[0])}.`,
      details: { offending_char: forbidden[0] },
    };
  }

  const foreign = findForeignBrandsInText(title);
  if (foreign.length > 0) {
    return {
      validator_id: "validator-title",
      passed: false,
      severity: "error",
      message: `Foreign brand(s) detected in title: ${foreign.join(", ")}.`,
      details: { foreign_brands: foreign },
    };
  }

  return { validator_id: "validator-title", passed: true };
};
