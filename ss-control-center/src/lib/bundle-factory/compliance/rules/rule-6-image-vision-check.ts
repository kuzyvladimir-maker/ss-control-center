// Rule 6 — Main image must not expose foreign brand logos.
//
// Wraps the existing `detectForeignLogosInImage` from
// `bundle-factory/audit/vision-check.ts` so the compliance gate, the
// audit pipeline, and any future caller all see the SAME own-brand
// whitelist and generic-deli ignorelist (Phase 2.6.0 refinement).
//
// Fail-CLOSED: if the vision call returns an `error` (no API key, network,
// JSON parse), the rule treats this as BLOCKED. Vladimir explicitly chose
// this in the spec: "treat as BLOCKED, never CAN_PUBLISH if vision call
// fails". This is the opposite of how the audit pipeline treats errors
// (which is fail-soft — keep the text-only score).
//
// Skipping: when `input.skip_image_check` is true OR `main_image_url`
// is missing, returns passed=true with `details.skipped` so smoke tests
// can run without burning Anthropic credits.

import { detectForeignLogosInImage } from "@/lib/bundle-factory/audit/vision-check";
import {
  isOwnBrandPassthrough,
  OWN_BRAND_PASSTHROUGH_BRANDS,
} from "../../own-brand";
import type { ComplianceInput, RuleResult } from "../types";

export async function ruleImageVisionCheck(
  input: ComplianceInput,
): Promise<RuleResult> {
  if (input.skip_image_check) {
    return {
      rule_id: "rule-6-image-vision-check",
      passed: true,
      details: { skipped: true, reason: "skip_image_check_flag" },
    };
  }

  const url = (input.main_image_url || "").trim();
  if (!url) {
    return {
      rule_id: "rule-6-image-vision-check",
      passed: true,
      details: { skipped: true, reason: "no_main_image_url" },
    };
  }

  const ownBrand = (input.brand || "").trim() || "Salutem Vita";
  // Phase 3 — the bundle's own component brands (genuine goods we resell,
  // shown on purpose in the frozen hero under the gift-basket exception) are
  // EXPECTED, not foreign-brand violations. Pass them as allowed so only
  // UNEXPECTED brands (a hallucinated logo) flag.
  const allowedBrands = [
    // The listing's own brand is always allowed on the image (it IS the
    // product for own-brand listings; the Salutem cooler for gift sets).
    ownBrand,
    ...(input.bundle_components ?? [])
      .map((c) => (c.brand ?? "").trim())
      .filter((b) => b.length > 0),
  ];
  // Own-brand passthrough (Uncrustables): the REAL product logo must survive on
  // the image — that's the whole point of listing under the donor brand. The
  // vision model reports both "Uncrustables" AND "Smucker's" (the parent mark on
  // the box), so allow the FULL passthrough allowlist, not just the single
  // component brand. Without this the gate flagged "Smucker's", blocked, and the
  // retry stripped the genuine logo off the box (Vladimir 2026-07-01).
  if (isOwnBrandPassthrough(input.brand)) {
    allowedBrands.push(...OWN_BRAND_PASSTHROUGH_BRANDS);
  }
  const result = await detectForeignLogosInImage(url, ownBrand, allowedBrands);

  if (result.error) {
    return {
      rule_id: "rule-6-image-vision-check",
      passed: false,
      reason: "image_vision_error",
      details: {
        error: result.error,
        main_image_url: url,
      },
      cost_cents: result.cost_cents,
    };
  }

  if (result.has_foreign_logos) {
    return {
      rule_id: "rule-6-image-vision-check",
      passed: false,
      reason: "main_image_foreign_logos",
      details: {
        detected_logos: result.detected_logos,
        main_image_url: url,
      },
      cost_cents: result.cost_cents,
    };
  }

  return {
    rule_id: "rule-6-image-vision-check",
    passed: true,
    details: {
      detected_logos: result.detected_logos,
      main_image_url: url,
    },
    cost_cents: result.cost_cents,
  };
}
