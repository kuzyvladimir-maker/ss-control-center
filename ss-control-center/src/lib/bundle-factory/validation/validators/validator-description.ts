/**
 * Phase 2.4 Stage 6 — Validator 3: Description.
 *
 * Per-channel char cap + plain-text re-check (no HTML, no emojis, no
 * manual bullets). Re-applies the Phase 2.6.2 brand-voice rules a
 * second time defensively — the description is the field that
 * historically held HTML for grocery listings (Amazon classifier code
 * 100339) so we want a hard gate before publish.
 */

import type { ValidatorFn } from "../types";
import { walmartProductDetailTextViolation } from
  "@/lib/bundle-factory/validation/walmart-product-detail-policy";

const DESC_CHAR_CAP_BY_CHANNEL: Record<string, number> = {
  AMAZON_PERSONAL: 2000,
  AMAZON_SALUTEM: 2000,
  AMAZON_AMZCOM: 2000,
  AMAZON_SIRIUS: 2000,
  AMAZON_RETAILER: 2000,
  WALMART: 4000,
  EBAY: 4000,
  TIKTOK_1: 2000,
  TIKTOK_2: 2000,
};

const HTML_TAG = /<[a-zA-Z\/!][^>]*>/;
const EMOJI_OR_SYMBOL = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u;
const MANUAL_BULLET = /[•●►▪○▶➤→]/;

function wordCount(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

export const validatorDescription: ValidatorFn = async ({ sku }) => {
  const desc = (sku.description || "").trim();
  if (!desc) {
    return {
      validator_id: "validator-description",
      passed: false,
      severity: "error",
      message: "Description is empty.",
    };
  }
  const cap = DESC_CHAR_CAP_BY_CHANNEL[sku.channel] ?? 2000;
  if (desc.length > cap) {
    return {
      validator_id: "validator-description",
      passed: false,
      severity: "error",
      message: `Description is ${desc.length} chars; ${sku.channel} limit is ${cap}.`,
      details: { length: desc.length, cap },
    };
  }
  if (sku.channel === "WALMART" && wordCount(desc) < 150) {
    return {
      validator_id: "validator-description",
      passed: false,
      severity: "error",
      message: `Walmart description has ${wordCount(desc)} words; current Product details policy requires at least 150 words.`,
      details: { words: wordCount(desc), minimum: 150 },
    };
  }
  if (HTML_TAG.test(desc)) {
    return {
      validator_id: "validator-description",
      passed: false,
      severity: "error",
      message: "Description contains an HTML tag — grocery descriptions must be plain text.",
    };
  }
  if (EMOJI_OR_SYMBOL.test(desc)) {
    return {
      validator_id: "validator-description",
      passed: false,
      severity: "error",
      message: "Description contains an emoji or pictograph symbol.",
    };
  }
  if (MANUAL_BULLET.test(desc)) {
    return {
      validator_id: "validator-description",
      passed: false,
      severity: "error",
      message: "Description contains a manual bullet marker.",
    };
  }
  if (sku.channel === "WALMART") {
    const violation = walmartProductDetailTextViolation(desc, "DESCRIPTION");
    if (violation) {
      return {
        validator_id: "validator-description",
        passed: false,
        severity: "error",
        message: `Walmart description contains ${violation}.`,
        details: { policy: "product-details-policy", violation },
      };
    }
  }
  return { validator_id: "validator-description", passed: true };
};
