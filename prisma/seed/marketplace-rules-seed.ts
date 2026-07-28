/**
 * Pre-seed for `MarketplaceRule` — top-30 hot-path rules cached in the DB
 * for fast lookup by Stage 4 (Content Generation) and Stage 6
 * (Validation). The Markdown files in docs/marketplace-rules/ remain the
 * source of truth; this is just a cache.
 *
 * `rule_value` is stored as JSON (string), so scalar values are serialised
 * via JSON.stringify().
 */

type SeedRule = {
  channel: string;
  category: string | null;
  rule_key: string;
  rule_value: unknown;
  source_doc_path: string;
  notes?: string;
};

const RAW_RULES: SeedRule[] = [
  // ─── Amazon — global (no category) ───────────────────────────────
  {
    channel: "AMAZON_SALUTEM",
    category: null,
    rule_key: "title.max_length",
    rule_value: 200,
    source_doc_path: "docs/marketplace-rules/amazon/title-policy.md",
  },
  {
    channel: "AMAZON_SALUTEM",
    category: null,
    rule_key: "bullets.count",
    rule_value: 5,
    source_doc_path: "docs/marketplace-rules/amazon/bullet-points-policy.md",
  },
  {
    channel: "AMAZON_SALUTEM",
    category: null,
    rule_key: "bullets.max_length_each",
    rule_value: 1000,
    source_doc_path: "docs/marketplace-rules/amazon/bullet-points-policy.md",
  },
  {
    channel: "AMAZON_SALUTEM",
    category: null,
    rule_key: "description.max_length",
    rule_value: 2000,
    source_doc_path: "docs/marketplace-rules/amazon/description-policy.md",
  },
  {
    channel: "AMAZON_SALUTEM",
    category: null,
    rule_key: "search_terms.max_bytes",
    rule_value: 250,
    source_doc_path: "docs/marketplace-rules/amazon/title-policy.md",
    notes: "Backend keywords field — 250 bytes total, not chars.",
  },
  {
    channel: "AMAZON_SALUTEM",
    category: null,
    rule_key: "images.main.min_dim_px",
    rule_value: 1000,
    source_doc_path: "docs/marketplace-rules/amazon/image-requirements.md",
    notes: "1000×1000 minimum for zoom; 1600+ recommended.",
  },
  {
    channel: "AMAZON_SALUTEM",
    category: null,
    rule_key: "images.main.background",
    rule_value: "pure_white_RGB_255_255_255",
    source_doc_path: "docs/marketplace-rules/amazon/image-requirements.md",
  },
  {
    channel: "AMAZON_SALUTEM",
    category: null,
    rule_key: "images.gallery.max_count",
    rule_value: 9,
    source_doc_path: "docs/marketplace-rules/amazon/image-requirements.md",
  },
  {
    channel: "AMAZON_SALUTEM",
    category: null,
    rule_key: "gift_set.policy_doc",
    rule_value: "Gift Basket Exception (Oct 14, 2024 Product Bundling Policy)",
    source_doc_path: "docs/marketplace-rules/amazon/gift-set-policy.md",
  },
  {
    channel: "AMAZON_SALUTEM",
    category: null,
    rule_key: "gift_set.brand_count_min",
    rule_value: 2,
    source_doc_path: "docs/marketplace-rules/amazon/gift-set-policy.md",
    notes: "Gift basket exception requires products from 2+ brands.",
  },

  // ─── Amazon — Frozen Grocery ─────────────────────────────────────
  {
    channel: "AMAZON_SALUTEM",
    category: "FROZEN_GROCERY",
    rule_key: "browse_node.gift_basket",
    rule_value: "16322521",
    source_doc_path: "docs/marketplace-rules/amazon/browse-nodes-grocery.md",
    notes: "Food Assortments & Variety Gifts.",
  },
  {
    channel: "AMAZON_SALUTEM",
    category: "FROZEN_GROCERY",
    rule_key: "attributes.storage_temp",
    rule_value: "Frozen",
    source_doc_path: "docs/marketplace-rules/amazon/category-frozen-grocery.md",
  },
  {
    channel: "AMAZON_SALUTEM",
    category: "FROZEN_GROCERY",
    rule_key: "attributes.allergens_required",
    rule_value: true,
    source_doc_path: "docs/marketplace-rules/amazon/compliance-grocery.md",
  },

  // ─── Amazon — Refrigerated ───────────────────────────────────────
  {
    channel: "AMAZON_SALUTEM",
    category: "REFRIGERATED",
    rule_key: "attributes.storage_temp",
    rule_value: "Refrigerated",
    source_doc_path: "docs/marketplace-rules/amazon/category-refrigerated.md",
  },

  // ─── Amazon — Shelf-stable ───────────────────────────────────────
  {
    channel: "AMAZON_SALUTEM",
    category: "SHELF_STABLE",
    rule_key: "attributes.storage_temp",
    rule_value: "Ambient",
    source_doc_path: "docs/marketplace-rules/amazon/category-shelf-stable.md",
  },

  // ─── Amazon — Pet Food ───────────────────────────────────────────
  {
    channel: "AMAZON_SALUTEM",
    category: "PET_FOOD",
    rule_key: "attributes.target_species_required",
    rule_value: true,
    source_doc_path: "docs/marketplace-rules/amazon/category-pet-food.md",
  },

  // ─── Walmart — global ─────────────────────────────────────────────
  {
    channel: "WALMART",
    category: null,
    rule_key: "title.max_length",
    rule_value: 75,
    source_doc_path: "docs/marketplace-rules/walmart/title-policy.md",
  },
  {
    channel: "WALMART",
    category: null,
    rule_key: "title.brand_prefix_required",
    rule_value: true,
    source_doc_path: "docs/marketplace-rules/walmart/title-policy.md",
  },
  {
    channel: "WALMART",
    category: null,
    rule_key: "images.main.min_dim_px",
    rule_value: 1500,
    source_doc_path: "docs/marketplace-rules/walmart/images.md",
  },
  {
    channel: "WALMART",
    category: null,
    rule_key: "images.gallery.max_count",
    rule_value: 8,
    source_doc_path: "docs/marketplace-rules/walmart/images.md",
  },
  {
    channel: "WALMART",
    category: null,
    rule_key: "multipack.required_attr",
    rule_value: "multipack_quantity",
    source_doc_path: "docs/marketplace-rules/walmart/multipack-policy.md",
  },
  {
    channel: "WALMART",
    category: null,
    rule_key: "prohibited_items.policy_doc",
    rule_value: "docs/marketplace-rules/walmart/prohibited-items.md",
    source_doc_path: "docs/marketplace-rules/walmart/prohibited-items.md",
  },

  // ─── Walmart — Frozen (RESTRICTED for Vladimir's account) ────────
  {
    channel: "WALMART",
    category: "FROZEN_GROCERY",
    rule_key: "access.allowed",
    rule_value: false,
    source_doc_path: "docs/marketplace-rules/walmart/frozen-restrictions.md",
    notes:
      "Vladimir's Walmart Marketplace account does NOT have frozen access. Phase 2 task.",
  },

  // ─── Walmart — Grocery (shelf-stable) ────────────────────────────
  {
    channel: "WALMART",
    category: "SHELF_STABLE",
    rule_key: "category_path",
    rule_value: "Food/Pantry",
    source_doc_path: "docs/marketplace-rules/walmart/category-grocery.md",
  },

  // ─── Cross-channel meta: AMAZON_PERSONAL / _AMZCOM / _RETAILER ──
  // Mirror the Salutem listing rules; AI uses these to push the same
  // recipe to other Amazon brand accounts without re-fetching docs.
  {
    channel: "AMAZON_PERSONAL",
    category: null,
    rule_key: "title.max_length",
    rule_value: 200,
    source_doc_path: "docs/marketplace-rules/amazon/title-policy.md",
  },
  {
    channel: "AMAZON_AMZCOM",
    category: null,
    rule_key: "title.max_length",
    rule_value: 200,
    source_doc_path: "docs/marketplace-rules/amazon/title-policy.md",
  },
  {
    channel: "AMAZON_SIRIUS",
    category: null,
    rule_key: "title.max_length",
    rule_value: 200,
    source_doc_path: "docs/marketplace-rules/amazon/title-policy.md",
  },
  {
    channel: "AMAZON_RETAILER",
    category: null,
    rule_key: "title.max_length",
    rule_value: 200,
    source_doc_path: "docs/marketplace-rules/amazon/title-policy.md",
  },

  // ─── eBay / TikTok placeholders (Phase 2 — KB files are stubs) ──
  {
    channel: "EBAY",
    category: null,
    rule_key: "title.max_length",
    rule_value: 80,
    source_doc_path: "docs/marketplace-rules/ebay/basics.md",
  },
  {
    channel: "TIKTOK_1",
    category: null,
    rule_key: "title.max_length",
    rule_value: 100,
    source_doc_path: "docs/marketplace-rules/tiktok-shop/basics.md",
  },
];

/** Idempotent seeder — uses (channel, category, rule_key) composite key. */
export async function seedMarketplaceRules(
  prisma: import("../../src/generated/prisma/client").PrismaClient
): Promise<number> {
  let count = 0;
  for (const r of RAW_RULES) {
    const rule_value_json = JSON.stringify(r.rule_value);
    // Prisma's compound-unique `where` excludes null fields; use upsert via
    // find-first + create/update fallback for category=null rows.
    const existing = await prisma.marketplaceRule.findFirst({
      where: {
        channel: r.channel,
        category: r.category,
        rule_key: r.rule_key,
      },
    });
    if (existing) {
      await prisma.marketplaceRule.update({
        where: { id: existing.id },
        data: {
          rule_value: rule_value_json,
          source_doc_path: r.source_doc_path,
          notes: r.notes ?? null,
          is_current: true,
        },
      });
    } else {
      await prisma.marketplaceRule.create({
        data: {
          channel: r.channel,
          category: r.category,
          rule_key: r.rule_key,
          rule_value: rule_value_json,
          source_doc_path: r.source_doc_path,
          notes: r.notes ?? null,
        },
      });
    }
    count++;
  }
  return count;
}

export const MARKETPLACE_RULE_SEED_COUNT = RAW_RULES.length;
