// Rule 5 — Multi-brand bundles must live under a Gift Basket Exception node.
//
// "Multi-brand" = bundle_components contains products from >1 distinct
// manufacturer brand (case-insensitive). Empty/whitespace-only brand
// strings are ignored when counting distinct brands.
//
// HARD BLOCK — no auto-fix (changing the browse node is a publication
// decision, not a content fix).

import { isGiftBasketExceptionNode, GIFT_BASKET_EXCEPTION_NODES } from "../browse-nodes";
import type { ComplianceInput, RuleResult } from "../types";

export function ruleBrowseNode(input: ComplianceInput): RuleResult {
  const brands = (input.bundle_components || [])
    .map((c) => (c.brand || "").trim().toLowerCase())
    .filter((b) => b.length > 0);
  const distinct = new Set(brands);

  // Single-brand (or zero-component) bundles are out of scope.
  if (distinct.size <= 1) {
    return {
      rule_id: "rule-5-browse-node",
      passed: true,
      details: { distinct_brand_count: distinct.size },
    };
  }

  if (isGiftBasketExceptionNode(input.browse_node)) {
    return {
      rule_id: "rule-5-browse-node",
      passed: true,
      details: {
        distinct_brand_count: distinct.size,
        browse_node: input.browse_node,
      },
    };
  }

  return {
    rule_id: "rule-5-browse-node",
    passed: false,
    reason: "multi_brand_wrong_category",
    details: {
      distinct_brand_count: distinct.size,
      distinct_brands: Array.from(distinct),
      browse_node: input.browse_node ?? null,
      allowed_nodes: GIFT_BASKET_EXCEPTION_NODES,
    },
  };
}
