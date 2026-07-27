// One-off Turso migration for Bundle Factory Phase 1.
//
// Mirrors prisma/migrations/20260517000000_bundle_factory_phase_1_initial/migration.sql
// idempotently — each `CREATE TABLE` uses `IF NOT EXISTS`, each index uses
// `CREATE INDEX IF NOT EXISTS` (or `CREATE UNIQUE INDEX IF NOT EXISTS`).
// Safe to re-run.
//
// NOT run automatically. Vladimir runs this manually after PR review:
//   node scripts/turso-migrate-bundle-factory-phase-1.mjs
//
// Required env: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN.

import { createClient } from "@libsql/client";

function clean(v) {
  if (!v) return v;
  return v.trim().replace(/^['"]|['"]$/g, "");
}

const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) {
  console.error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN");
  process.exit(1);
}

const client = createClient({ url, authToken });
console.log(`→ Target: ${url.split("@")[1] || url}`);

// ─── Tables (dependency-safe order) ──────────────────────────────────

console.log("\nCreating StoreRegistry…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "StoreRegistry" (
    "id"                     TEXT NOT NULL PRIMARY KEY,
    "name"                   TEXT NOT NULL,
    "chain"                  TEXT NOT NULL,
    "store_type"             TEXT NOT NULL,
    "tier"                   TEXT NOT NULL,
    "address"                TEXT NOT NULL,
    "latitude"               REAL NOT NULL,
    "longitude"              REAL NOT NULL,
    "distance_mi"            REAL NOT NULL,
    "google_place_id"        TEXT,
    "google_maps_url"        TEXT,
    "phone"                  TEXT,
    "hours_text"             TEXT,
    "hours_json"             TEXT,
    "website_url"            TEXT,
    "delivery_program"       TEXT,
    "delivery_cost_cents"    INTEGER NOT NULL DEFAULT 0,
    "delivery_notes"         TEXT,
    "is_active"              INTEGER NOT NULL DEFAULT 1,
    "is_membership_required" INTEGER NOT NULL DEFAULT 0,
    "membership_active"      INTEGER NOT NULL DEFAULT 0,
    "membership_renewal"     DATETIME,
    "default_priority"       INTEGER NOT NULL,
    "last_validated_at"      DATETIME,
    "notes"                  TEXT,
    "created_at"             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             DATETIME NOT NULL
  )
`);

console.log("Creating BrandAccount…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "BrandAccount" (
    "id"                   TEXT NOT NULL PRIMARY KEY,
    "brand"                TEXT NOT NULL,
    "channel"              TEXT NOT NULL,
    "is_brand_owner"       INTEGER NOT NULL,
    "is_authorized_seller" INTEGER NOT NULL,
    "selling_partner_id"   TEXT,
    "is_active"            INTEGER NOT NULL DEFAULT 1,
    "notes"                TEXT,
    "created_at"           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           DATETIME NOT NULL
  )
`);

console.log("Creating GenerationJob…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "GenerationJob" (
    "id"                  TEXT NOT NULL PRIMARY KEY,
    "brief"               TEXT NOT NULL,
    "current_stage"       TEXT NOT NULL DEFAULT 'BRIEF',
    "status"              TEXT NOT NULL DEFAULT 'PENDING',
    "bundles_target"      INTEGER NOT NULL,
    "bundles_generated"   INTEGER NOT NULL DEFAULT 0,
    "bundles_approved"    INTEGER NOT NULL DEFAULT 0,
    "bundles_published"   INTEGER NOT NULL DEFAULT 0,
    "bundles_error"       INTEGER NOT NULL DEFAULT 0,
    "openai_tokens_used"  INTEGER NOT NULL DEFAULT 0,
    "perplexity_queries"  INTEGER NOT NULL DEFAULT 0,
    "images_generated"    INTEGER NOT NULL DEFAULT 0,
    "cost_cents"          INTEGER NOT NULL DEFAULT 0,
    "user_id"             TEXT,
    "notes"               TEXT,
    "created_at"          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          DATETIME NOT NULL,
    "completed_at"        DATETIME
  )
`);

console.log("Creating ResearchPool…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "ResearchPool" (
    "id"                   TEXT NOT NULL PRIMARY KEY,
    "research_query"       TEXT NOT NULL,
    "generation_job_id"    TEXT,
    "product_name"         TEXT NOT NULL,
    "brand"                TEXT NOT NULL,
    "manufacturer"         TEXT,
    "upc"                  TEXT,
    "flavors"              TEXT,
    "pack_sizes"           TEXT,
    "weight_oz"            REAL,
    "weight_lb"            REAL,
    "ingredients"          TEXT,
    "allergens"            TEXT,
    "nutrition"            TEXT,
    "storage_temp"         TEXT,
    "expiration_days"      INTEGER,
    "reference_image_urls" TEXT NOT NULL,
    "avg_price_cents"      INTEGER,
    "source_store_id"      TEXT,
    "source_url"           TEXT,
    "last_seen_in_stock"   DATETIME,
    "freshness_score"      REAL,
    "created_at"           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           DATETIME NOT NULL,
    CONSTRAINT "ResearchPool_generation_job_id_fkey" FOREIGN KEY ("generation_job_id") REFERENCES "GenerationJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ResearchPool_source_store_id_fkey"   FOREIGN KEY ("source_store_id")   REFERENCES "StoreRegistry" ("id") ON DELETE SET NULL ON UPDATE CASCADE
  )
`);

console.log("Creating MasterBundle…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "MasterBundle" (
    "id"                    TEXT NOT NULL PRIMARY KEY,
    "name"                  TEXT NOT NULL,
    "internal_slug"         TEXT NOT NULL,
    "brand"                 TEXT NOT NULL,
    "category"              TEXT NOT NULL,
    "composition_type"      TEXT NOT NULL,
    "pack_count"            INTEGER NOT NULL,
    "total_weight_oz"       REAL,
    "total_weight_lb"       REAL,
    "cost_breakdown"        TEXT NOT NULL,
    "estimated_cost_cents"  INTEGER NOT NULL,
    "suggested_price_cents" INTEGER NOT NULL,
    "packaging_spec"        TEXT NOT NULL,
    "main_image_url"        TEXT NOT NULL,
    "secondary_images"      TEXT NOT NULL,
    "image_generation_meta" TEXT,
    "lifecycle_status"      TEXT NOT NULL DEFAULT 'DRAFT',
    "generation_job_id"     TEXT,
    "research_pool_seed_id" TEXT,
    "created_at"            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            DATETIME NOT NULL,
    "created_by_user_id"    TEXT,
    CONSTRAINT "MasterBundle_generation_job_id_fkey"     FOREIGN KEY ("generation_job_id")     REFERENCES "GenerationJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MasterBundle_research_pool_seed_id_fkey" FOREIGN KEY ("research_pool_seed_id") REFERENCES "ResearchPool" ("id") ON DELETE SET NULL ON UPDATE CASCADE
  )
`);

console.log("Creating UPCPool…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "UPCPool" (
    "id"              TEXT NOT NULL PRIMARY KEY,
    "upc"             TEXT NOT NULL,
    "upc_prefix"      TEXT NOT NULL,
    "gs1_validated"   INTEGER NOT NULL DEFAULT 0,
    "gs1_owner"       TEXT,
    "status"          TEXT NOT NULL DEFAULT 'AVAILABLE',
    "assigned_to_id"  TEXT,
    "reserved_for_id" TEXT,
    "reserved_at"     DATETIME,
    "reserved_until"  DATETIME,
    "acquired_from"   TEXT,
    "acquired_at"     DATETIME,
    "notes"           TEXT,
    "created_at"      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      DATETIME NOT NULL
  )
`);

console.log("Creating ChannelSKU…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "ChannelSKU" (
    "id"                   TEXT NOT NULL PRIMARY KEY,
    "master_bundle_id"     TEXT NOT NULL,
    "channel"              TEXT NOT NULL,
    "brand_account_id"     TEXT,
    "sku"                  TEXT NOT NULL,
    "upc"                  TEXT NOT NULL,
    "upc_pool_id"          TEXT,
    "asin"                 TEXT,
    "walmart_item_id"      TEXT,
    "ebay_item_id"         TEXT,
    "tiktok_product_id"    TEXT,
    "title"                TEXT NOT NULL,
    "bullets"              TEXT NOT NULL,
    "description"          TEXT NOT NULL,
    "search_terms"         TEXT,
    "attributes"           TEXT NOT NULL,
    "channel_category"     TEXT,
    "channel_browse_node"  TEXT,
    "price_cents"          INTEGER NOT NULL,
    "business_price_cents" INTEGER,
    "lifecycle_status"     TEXT NOT NULL DEFAULT 'DRAFT',
    "submitted_at"         DATETIME,
    "processing_at"        DATETIME,
    "live_at"              DATETIME,
    "live_url"             TEXT,
    "last_error_at"        DATETIME,
    "errors"               TEXT,
    "units_sold_30d"       INTEGER DEFAULT 0,
    "revenue_30d_cents"    INTEGER DEFAULT 0,
    "created_at"           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           DATETIME NOT NULL,
    CONSTRAINT "ChannelSKU_master_bundle_id_fkey" FOREIGN KEY ("master_bundle_id") REFERENCES "MasterBundle" ("id") ON DELETE CASCADE  ON UPDATE CASCADE,
    CONSTRAINT "ChannelSKU_brand_account_id_fkey" FOREIGN KEY ("brand_account_id") REFERENCES "BrandAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ChannelSKU_upc_pool_id_fkey"      FOREIGN KEY ("upc_pool_id")      REFERENCES "UPCPool"      ("id") ON DELETE SET NULL ON UPDATE CASCADE
  )
`);

console.log("Creating BundleComponent…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "BundleComponent" (
    "id"                 TEXT NOT NULL PRIMARY KEY,
    "master_bundle_id"   TEXT NOT NULL,
    "product_name"       TEXT NOT NULL,
    "manufacturer_brand" TEXT NOT NULL,
    "manufacturer_upc"   TEXT,
    "flavor"             TEXT,
    "variant"            TEXT,
    "qty"                INTEGER NOT NULL,
    "unit_weight_oz"     REAL,
    "unit_weight_lb"     REAL,
    "unit_price_cents"   INTEGER NOT NULL,
    "source_store_id"    TEXT,
    "source_url"         TEXT,
    "ingredients"        TEXT,
    "allergens"          TEXT,
    "storage_temp"       TEXT,
    "expiration_days"    INTEGER,
    "donor_image_urls"   TEXT NOT NULL,
    "created_at"         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         DATETIME NOT NULL,
    CONSTRAINT "BundleComponent_master_bundle_id_fkey" FOREIGN KEY ("master_bundle_id") REFERENCES "MasterBundle"  ("id") ON DELETE CASCADE  ON UPDATE CASCADE,
    CONSTRAINT "BundleComponent_source_store_id_fkey"  FOREIGN KEY ("source_store_id")  REFERENCES "StoreRegistry" ("id") ON DELETE SET NULL ON UPDATE CASCADE
  )
`);

console.log("Creating BundleDraft…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "BundleDraft" (
    "id"                          TEXT NOT NULL PRIMARY KEY,
    "generation_job_id"           TEXT NOT NULL,
    "draft_name"                  TEXT NOT NULL,
    "brand"                       TEXT NOT NULL,
    "category"                    TEXT NOT NULL,
    "composition_type"            TEXT NOT NULL,
    "pack_count"                  INTEGER NOT NULL,
    "draft_components"            TEXT NOT NULL,
    "draft_title"                 TEXT,
    "draft_bullets"               TEXT,
    "draft_description"           TEXT,
    "draft_search_terms"          TEXT,
    "draft_main_image_url"        TEXT,
    "draft_secondary_images"      TEXT,
    "draft_cost_cents"            INTEGER,
    "draft_suggested_price_cents" INTEGER,
    "status"                      TEXT NOT NULL DEFAULT 'VARIATION_SELECTED',
    "approval_notes"              TEXT,
    "target_channels"             TEXT NOT NULL,
    "master_bundle_id"            TEXT,
    "created_at"                  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                  DATETIME NOT NULL,
    CONSTRAINT "BundleDraft_generation_job_id_fkey" FOREIGN KEY ("generation_job_id") REFERENCES "GenerationJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  )
`);

console.log("Creating ProductSourceFallback…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "ProductSourceFallback" (
    "id"                    TEXT NOT NULL PRIMARY KEY,
    "manufacturer_upc"      TEXT NOT NULL,
    "product_name"          TEXT NOT NULL,
    "primary_store_id"      TEXT NOT NULL,
    "fallback_store_id"     TEXT NOT NULL,
    "fallback_priority"     INTEGER NOT NULL,
    "primary_oos_count"     INTEGER NOT NULL DEFAULT 0,
    "fallback_used_count"   INTEGER NOT NULL DEFAULT 0,
    "fallback_failed_count" INTEGER NOT NULL DEFAULT 0,
    "notes"                 TEXT,
    "created_at"            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            DATETIME NOT NULL,
    CONSTRAINT "ProductSourceFallback_primary_store_id_fkey"  FOREIGN KEY ("primary_store_id")  REFERENCES "StoreRegistry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ProductSourceFallback_fallback_store_id_fkey" FOREIGN KEY ("fallback_store_id") REFERENCES "StoreRegistry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )
`);

console.log("Creating StockCheckLog…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "StockCheckLog" (
    "id"               TEXT NOT NULL PRIMARY KEY,
    "store_id"         TEXT NOT NULL,
    "manufacturer_upc" TEXT,
    "product_name"     TEXT,
    "in_stock"         INTEGER NOT NULL,
    "price_cents"      INTEGER,
    "source_url"       TEXT,
    "raw_response"     TEXT,
    "checked_at"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "check_method"     TEXT NOT NULL,
    CONSTRAINT "StockCheckLog_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "StoreRegistry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )
`);

console.log("Creating GTINExemption…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "GTINExemption" (
    "id"                  TEXT NOT NULL PRIMARY KEY,
    "brand"               TEXT NOT NULL,
    "channel"             TEXT NOT NULL,
    "category"            TEXT NOT NULL,
    "status"              TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
    "application_date"    DATETIME,
    "approval_date"       DATETIME,
    "denial_reason"       TEXT,
    "application_pdf_url" TEXT,
    "reference_id"        TEXT,
    "notes"               TEXT,
    "created_at"          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          DATETIME NOT NULL
  )
`);

console.log("Creating GenerationStage…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "GenerationStage" (
    "id"                TEXT NOT NULL PRIMARY KEY,
    "generation_job_id" TEXT NOT NULL,
    "stage"             TEXT NOT NULL,
    "status"            TEXT NOT NULL DEFAULT 'PENDING',
    "started_at"        DATETIME,
    "completed_at"      DATETIME,
    "duration_ms"       INTEGER,
    "input_snapshot"    TEXT,
    "output_snapshot"   TEXT,
    "error"             TEXT,
    CONSTRAINT "GenerationStage_generation_job_id_fkey" FOREIGN KEY ("generation_job_id") REFERENCES "GenerationJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  )
`);

console.log("Creating MarketplaceRule…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "MarketplaceRule" (
    "id"              TEXT NOT NULL PRIMARY KEY,
    "channel"         TEXT NOT NULL,
    "category"        TEXT,
    "rule_key"        TEXT NOT NULL,
    "rule_value"      TEXT NOT NULL,
    "source_doc_path" TEXT NOT NULL,
    "source_url"      TEXT,
    "scraped_at"      DATETIME,
    "validated_at"    DATETIME,
    "is_current"      INTEGER NOT NULL DEFAULT 1,
    "notes"           TEXT,
    "created_at"      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      DATETIME NOT NULL
  )
`);

console.log("Creating ErrorPattern…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "ErrorPattern" (
    "id"                    TEXT NOT NULL PRIMARY KEY,
    "channel"               TEXT NOT NULL,
    "error_category"        TEXT NOT NULL,
    "error_code"            TEXT NOT NULL,
    "error_message_pattern" TEXT NOT NULL,
    "fix_strategy"          TEXT NOT NULL,
    "fix_handler_name"      TEXT,
    "occurrences"           INTEGER NOT NULL DEFAULT 0,
    "auto_fix_success"      INTEGER NOT NULL DEFAULT 0,
    "auto_fix_failure"      INTEGER NOT NULL DEFAULT 0,
    "last_seen"             DATETIME,
    "description"           TEXT,
    "example_input"         TEXT,
    "example_output"        TEXT,
    "created_at"            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            DATETIME NOT NULL
  )
`);

console.log("Creating ListingLifecycleLog…");
await client.execute(`
  CREATE TABLE IF NOT EXISTS "ListingLifecycleLog" (
    "id"               TEXT NOT NULL PRIMARY KEY,
    "entity_type"      TEXT NOT NULL,
    "entity_id"        TEXT NOT NULL,
    "master_bundle_id" TEXT,
    "channel_sku_id"   TEXT,
    "from_status"      TEXT,
    "to_status"        TEXT NOT NULL,
    "trigger"          TEXT NOT NULL,
    "details"          TEXT,
    "user_id"          TEXT,
    "created_at"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ListingLifecycleLog_master_bundle_id_fkey" FOREIGN KEY ("master_bundle_id") REFERENCES "MasterBundle" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ListingLifecycleLog_channel_sku_id_fkey"   FOREIGN KEY ("channel_sku_id")   REFERENCES "ChannelSKU"   ("id") ON DELETE CASCADE ON UPDATE CASCADE
  )
`);

// ─── Indexes & unique constraints ─────────────────────────────────────

console.log("\nCreating indexes…");
const indexes = [
  // StoreRegistry
  `CREATE INDEX IF NOT EXISTS "StoreRegistry_chain_idx"                                                     ON "StoreRegistry"("chain")`,
  `CREATE INDEX IF NOT EXISTS "StoreRegistry_tier_idx"                                                      ON "StoreRegistry"("tier")`,
  `CREATE INDEX IF NOT EXISTS "StoreRegistry_is_active_idx"                                                 ON "StoreRegistry"("is_active")`,
  `CREATE INDEX IF NOT EXISTS "StoreRegistry_distance_mi_idx"                                               ON "StoreRegistry"("distance_mi")`,
  // BrandAccount
  `CREATE INDEX IF NOT EXISTS "BrandAccount_brand_idx"                                                      ON "BrandAccount"("brand")`,
  `CREATE INDEX IF NOT EXISTS "BrandAccount_channel_idx"                                                    ON "BrandAccount"("channel")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "BrandAccount_brand_channel_key"                                       ON "BrandAccount"("brand", "channel")`,
  // GenerationJob
  `CREATE INDEX IF NOT EXISTS "GenerationJob_status_idx"                                                    ON "GenerationJob"("status")`,
  `CREATE INDEX IF NOT EXISTS "GenerationJob_current_stage_idx"                                             ON "GenerationJob"("current_stage")`,
  // ResearchPool
  `CREATE INDEX IF NOT EXISTS "ResearchPool_brand_idx"                                                      ON "ResearchPool"("brand")`,
  `CREATE INDEX IF NOT EXISTS "ResearchPool_generation_job_id_idx"                                          ON "ResearchPool"("generation_job_id")`,
  `CREATE INDEX IF NOT EXISTS "ResearchPool_last_seen_in_stock_idx"                                         ON "ResearchPool"("last_seen_in_stock")`,
  // MasterBundle
  `CREATE UNIQUE INDEX IF NOT EXISTS "MasterBundle_internal_slug_key"                                       ON "MasterBundle"("internal_slug")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "MasterBundle_generation_job_id_key"                                   ON "MasterBundle"("generation_job_id")`,
  `CREATE INDEX IF NOT EXISTS "MasterBundle_brand_idx"                                                      ON "MasterBundle"("brand")`,
  `CREATE INDEX IF NOT EXISTS "MasterBundle_category_idx"                                                   ON "MasterBundle"("category")`,
  `CREATE INDEX IF NOT EXISTS "MasterBundle_lifecycle_status_idx"                                           ON "MasterBundle"("lifecycle_status")`,
  `CREATE INDEX IF NOT EXISTS "MasterBundle_created_at_idx"                                                 ON "MasterBundle"("created_at")`,
  // UPCPool
  `CREATE UNIQUE INDEX IF NOT EXISTS "UPCPool_upc_key"                                                      ON "UPCPool"("upc")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "UPCPool_assigned_to_id_key"                                           ON "UPCPool"("assigned_to_id")`,
  `CREATE INDEX IF NOT EXISTS "UPCPool_status_idx"                                                          ON "UPCPool"("status")`,
  `CREATE INDEX IF NOT EXISTS "UPCPool_upc_prefix_idx"                                                      ON "UPCPool"("upc_prefix")`,
  `CREATE INDEX IF NOT EXISTS "UPCPool_gs1_validated_idx"                                                   ON "UPCPool"("gs1_validated")`,
  // ChannelSKU
  `CREATE UNIQUE INDEX IF NOT EXISTS "ChannelSKU_sku_key"                                                   ON "ChannelSKU"("sku")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ChannelSKU_upc_key"                                                   ON "ChannelSKU"("upc")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ChannelSKU_upc_pool_id_key"                                           ON "ChannelSKU"("upc_pool_id")`,
  `CREATE INDEX IF NOT EXISTS "ChannelSKU_master_bundle_id_idx"                                             ON "ChannelSKU"("master_bundle_id")`,
  `CREATE INDEX IF NOT EXISTS "ChannelSKU_channel_idx"                                                      ON "ChannelSKU"("channel")`,
  `CREATE INDEX IF NOT EXISTS "ChannelSKU_lifecycle_status_idx"                                             ON "ChannelSKU"("lifecycle_status")`,
  `CREATE INDEX IF NOT EXISTS "ChannelSKU_asin_idx"                                                         ON "ChannelSKU"("asin")`,
  `CREATE INDEX IF NOT EXISTS "ChannelSKU_walmart_item_id_idx"                                              ON "ChannelSKU"("walmart_item_id")`,
  // BundleComponent
  `CREATE INDEX IF NOT EXISTS "BundleComponent_master_bundle_id_idx"                                        ON "BundleComponent"("master_bundle_id")`,
  `CREATE INDEX IF NOT EXISTS "BundleComponent_manufacturer_brand_idx"                                      ON "BundleComponent"("manufacturer_brand")`,
  // BundleDraft
  `CREATE UNIQUE INDEX IF NOT EXISTS "BundleDraft_master_bundle_id_key"                                     ON "BundleDraft"("master_bundle_id")`,
  `CREATE INDEX IF NOT EXISTS "BundleDraft_generation_job_id_idx"                                           ON "BundleDraft"("generation_job_id")`,
  `CREATE INDEX IF NOT EXISTS "BundleDraft_status_idx"                                                      ON "BundleDraft"("status")`,
  // ProductSourceFallback
  `CREATE INDEX IF NOT EXISTS "ProductSourceFallback_manufacturer_upc_idx"                                  ON "ProductSourceFallback"("manufacturer_upc")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ProductSourceFallback_manufacturer_upc_primary_store_id_fallback_store_id_key" ON "ProductSourceFallback"("manufacturer_upc", "primary_store_id", "fallback_store_id")`,
  // StockCheckLog
  `CREATE INDEX IF NOT EXISTS "StockCheckLog_store_id_idx"                                                  ON "StockCheckLog"("store_id")`,
  `CREATE INDEX IF NOT EXISTS "StockCheckLog_manufacturer_upc_idx"                                          ON "StockCheckLog"("manufacturer_upc")`,
  `CREATE INDEX IF NOT EXISTS "StockCheckLog_checked_at_idx"                                                ON "StockCheckLog"("checked_at")`,
  // GTINExemption
  `CREATE INDEX IF NOT EXISTS "GTINExemption_status_idx"                                                    ON "GTINExemption"("status")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "GTINExemption_brand_channel_category_key"                            ON "GTINExemption"("brand", "channel", "category")`,
  // GenerationStage
  `CREATE INDEX IF NOT EXISTS "GenerationStage_generation_job_id_idx"                                       ON "GenerationStage"("generation_job_id")`,
  `CREATE INDEX IF NOT EXISTS "GenerationStage_stage_idx"                                                   ON "GenerationStage"("stage")`,
  // MarketplaceRule
  `CREATE INDEX IF NOT EXISTS "MarketplaceRule_channel_idx"                                                 ON "MarketplaceRule"("channel")`,
  `CREATE INDEX IF NOT EXISTS "MarketplaceRule_rule_key_idx"                                                ON "MarketplaceRule"("rule_key")`,
  `CREATE INDEX IF NOT EXISTS "MarketplaceRule_is_current_idx"                                              ON "MarketplaceRule"("is_current")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "MarketplaceRule_channel_category_rule_key_key"                       ON "MarketplaceRule"("channel", "category", "rule_key")`,
  // ErrorPattern
  `CREATE INDEX IF NOT EXISTS "ErrorPattern_channel_idx"                                                    ON "ErrorPattern"("channel")`,
  `CREATE INDEX IF NOT EXISTS "ErrorPattern_error_category_idx"                                             ON "ErrorPattern"("error_category")`,
  `CREATE INDEX IF NOT EXISTS "ErrorPattern_error_code_idx"                                                 ON "ErrorPattern"("error_code")`,
  // ListingLifecycleLog
  `CREATE INDEX IF NOT EXISTS "ListingLifecycleLog_entity_type_entity_id_idx"                               ON "ListingLifecycleLog"("entity_type", "entity_id")`,
  `CREATE INDEX IF NOT EXISTS "ListingLifecycleLog_master_bundle_id_idx"                                    ON "ListingLifecycleLog"("master_bundle_id")`,
  `CREATE INDEX IF NOT EXISTS "ListingLifecycleLog_channel_sku_id_idx"                                      ON "ListingLifecycleLog"("channel_sku_id")`,
  `CREATE INDEX IF NOT EXISTS "ListingLifecycleLog_created_at_idx"                                          ON "ListingLifecycleLog"("created_at")`,
];

for (const sql of indexes) {
  await client.execute(sql);
}
console.log(`  + applied ${indexes.length} indexes`);

console.log("\n✓ Bundle Factory Phase 1 migration complete on Turso.");
