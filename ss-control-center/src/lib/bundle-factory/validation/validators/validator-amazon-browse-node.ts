/**
 * Phase 2.4 Stage 6 — Validator 8: Amazon browse node.
 *
 * Only fires for AMAZON_* channels. Non-Amazon channels pass cleanly so
 * the validator can be registered universally and skip itself.
 *
 * For multi-brand bundles the node MUST be in GIFT_BASKET_EXCEPTION_NODES
 * (same set Rule 5 of the compliance gate uses — single source of truth).
 * For single-brand bundles the node only needs to be non-empty (we don't
 * have a complete list of valid Amazon food nodes; that's a separate
 * marketplace-rules KB lookup).
 */

import {
  GIFT_BASKET_EXCEPTION_NODES,
  isGiftBasketExceptionNode,
} from "@/lib/bundle-factory/compliance/browse-nodes";
import type { ValidatorFn } from "../types";

export const validatorAmazonBrowseNode: ValidatorFn = async ({
  sku,
  bundle_components,
}) => {
  if (!sku.channel.startsWith("AMAZON_")) {
    return {
      validator_id: "validator-amazon-browse-node",
      passed: true,
      details: { skipped: true, reason: "non_amazon_channel" },
    };
  }
  const node = (sku.channel_browse_node || "").trim();
  if (!node) {
    return {
      validator_id: "validator-amazon-browse-node",
      passed: false,
      severity: "error",
      message: "Amazon ChannelSKU is missing channel_browse_node.",
    };
  }
  const brands = bundle_components
    .map((c) => (c.manufacturer_brand || "").trim().toLowerCase())
    .filter((b) => b.length > 0);
  const distinct = new Set(brands);
  const isMultiBrand = distinct.size > 1;

  if (isMultiBrand && !isGiftBasketExceptionNode(node)) {
    return {
      validator_id: "validator-amazon-browse-node",
      passed: false,
      severity: "error",
      message: `Multi-brand bundle (${distinct.size} distinct brands) requires a Gift Basket Exception node.`,
      details: {
        browse_node: node,
        distinct_brand_count: distinct.size,
        allowed_nodes: GIFT_BASKET_EXCEPTION_NODES,
      },
    };
  }
  return {
    validator_id: "validator-amazon-browse-node",
    passed: true,
    details: {
      browse_node: node,
      gift_basket_exception: isGiftBasketExceptionNode(node),
      distinct_brand_count: distinct.size,
    },
  };
};
