-- Bundle Factory Phase 1 — initial migration.
-- Adds 14 tables for the gift-set generation pipeline. All "enum-like"
-- columns are stored as TEXT with allowed values documented in
-- src/lib/bundle-factory/enums.ts (SQLite + Prisma 7 do not support native
-- enum types). See docs/BUNDLE_FACTORY_DATA_MODEL.md for the full spec.
--
-- This migration was bootstrapped via `prisma db push` on dev.db, then
-- captured here from the resulting sqlite schema so the same DDL applies
-- cleanly to Turso via scripts/turso-migrate-bundle-factory-phase-1.mjs.

-- ─── Tables created in dependency-safe order ──────────────────────────

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
    "is_active"              BOOLEAN NOT NULL DEFAULT true,
    "is_membership_required" BOOLEAN NOT NULL DEFAULT false,
    "membership_active"      BOOLEAN NOT NULL DEFAULT false,
    "membership_renewal"     DATETIME,
    "default_priority"       INTEGER NOT NULL,
    "last_validated_at"      DATETIME,
    "notes"                  TEXT,
    "created_at"             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS "BrandAccount" (
    "id"                   TEXT NOT NULL PRIMARY KEY,
    "brand"                TEXT NOT NULL,
    "channel"              TEXT NOT NULL,
    "is_brand_owner"       BOOLEAN NOT NULL,
    "is_authorized_seller" BOOLEAN NOT NULL,
    "selling_partner_id"   TEXT,
    "is_active"            BOOLEAN NOT NULL DEFAULT true,
    "notes"                TEXT,
    "created_at"           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           DATETIME NOT NULL
);

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
);

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
);

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
);

CREATE TABLE IF NOT EXISTS "UPCPool" (
    "id"              TEXT NOT NULL PRIMARY KEY,
    "upc"             TEXT NOT NULL,
    "upc_prefix"      TEXT NOT NULL,
    "gs1_validated"   BOOLEAN NOT NULL DEFAULT false,
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
);

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
);

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
);

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
);

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
);

CREATE TABLE IF NOT EXISTS "StockCheckLog" (
    "id"               TEXT NOT NULL PRIMARY KEY,
    "store_id"         TEXT NOT NULL,
    "manufacturer_upc" TEXT,
    "product_name"     TEXT,
    "in_stock"         BOOLEAN NOT NULL,
    "price_cents"      INTEGER,
    "source_url"       TEXT,
    "raw_response"     TEXT,
    "checked_at"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "check_method"     TEXT NOT NULL,
    CONSTRAINT "StockCheckLog_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "StoreRegistry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

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
);

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
);

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
    "is_current"      BOOLEAN NOT NULL DEFAULT true,
    "notes"           TEXT,
    "created_at"      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      DATETIME NOT NULL
);

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
);

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
);

-- ─── Indexes & unique constraints ─────────────────────────────────────

CREATE INDEX        "StoreRegistry_chain_idx"                                                                    ON "StoreRegistry"("chain");
CREATE INDEX        "StoreRegistry_tier_idx"                                                                     ON "StoreRegistry"("tier");
CREATE INDEX        "StoreRegistry_is_active_idx"                                                                ON "StoreRegistry"("is_active");
CREATE INDEX        "StoreRegistry_distance_mi_idx"                                                              ON "StoreRegistry"("distance_mi");

CREATE INDEX        "BrandAccount_brand_idx"                                                                     ON "BrandAccount"("brand");
CREATE INDEX        "BrandAccount_channel_idx"                                                                   ON "BrandAccount"("channel");
CREATE UNIQUE INDEX "BrandAccount_brand_channel_key"                                                             ON "BrandAccount"("brand", "channel");

CREATE INDEX        "GenerationJob_status_idx"                                                                   ON "GenerationJob"("status");
CREATE INDEX        "GenerationJob_current_stage_idx"                                                            ON "GenerationJob"("current_stage");

CREATE INDEX        "ResearchPool_brand_idx"                                                                     ON "ResearchPool"("brand");
CREATE INDEX        "ResearchPool_generation_job_id_idx"                                                         ON "ResearchPool"("generation_job_id");
CREATE INDEX        "ResearchPool_last_seen_in_stock_idx"                                                        ON "ResearchPool"("last_seen_in_stock");

CREATE UNIQUE INDEX "MasterBundle_internal_slug_key"                                                             ON "MasterBundle"("internal_slug");
CREATE UNIQUE INDEX "MasterBundle_generation_job_id_key"                                                         ON "MasterBundle"("generation_job_id");
CREATE INDEX        "MasterBundle_brand_idx"                                                                     ON "MasterBundle"("brand");
CREATE INDEX        "MasterBundle_category_idx"                                                                  ON "MasterBundle"("category");
CREATE INDEX        "MasterBundle_lifecycle_status_idx"                                                          ON "MasterBundle"("lifecycle_status");
CREATE INDEX        "MasterBundle_created_at_idx"                                                                ON "MasterBundle"("created_at");

CREATE UNIQUE INDEX "UPCPool_upc_key"                                                                            ON "UPCPool"("upc");
CREATE UNIQUE INDEX "UPCPool_assigned_to_id_key"                                                                 ON "UPCPool"("assigned_to_id");
CREATE INDEX        "UPCPool_status_idx"                                                                         ON "UPCPool"("status");
CREATE INDEX        "UPCPool_upc_prefix_idx"                                                                     ON "UPCPool"("upc_prefix");
CREATE INDEX        "UPCPool_gs1_validated_idx"                                                                  ON "UPCPool"("gs1_validated");

CREATE UNIQUE INDEX "ChannelSKU_sku_key"                                                                         ON "ChannelSKU"("sku");
CREATE UNIQUE INDEX "ChannelSKU_upc_key"                                                                         ON "ChannelSKU"("upc");
CREATE UNIQUE INDEX "ChannelSKU_upc_pool_id_key"                                                                 ON "ChannelSKU"("upc_pool_id");
CREATE INDEX        "ChannelSKU_master_bundle_id_idx"                                                            ON "ChannelSKU"("master_bundle_id");
CREATE INDEX        "ChannelSKU_channel_idx"                                                                     ON "ChannelSKU"("channel");
CREATE INDEX        "ChannelSKU_lifecycle_status_idx"                                                            ON "ChannelSKU"("lifecycle_status");
CREATE INDEX        "ChannelSKU_asin_idx"                                                                        ON "ChannelSKU"("asin");
CREATE INDEX        "ChannelSKU_walmart_item_id_idx"                                                             ON "ChannelSKU"("walmart_item_id");

CREATE INDEX        "BundleComponent_master_bundle_id_idx"                                                       ON "BundleComponent"("master_bundle_id");
CREATE INDEX        "BundleComponent_manufacturer_brand_idx"                                                     ON "BundleComponent"("manufacturer_brand");

CREATE UNIQUE INDEX "BundleDraft_master_bundle_id_key"                                                           ON "BundleDraft"("master_bundle_id");
CREATE INDEX        "BundleDraft_generation_job_id_idx"                                                          ON "BundleDraft"("generation_job_id");
CREATE INDEX        "BundleDraft_status_idx"                                                                     ON "BundleDraft"("status");

CREATE INDEX        "ProductSourceFallback_manufacturer_upc_idx"                                                 ON "ProductSourceFallback"("manufacturer_upc");
CREATE UNIQUE INDEX "ProductSourceFallback_manufacturer_upc_primary_store_id_fallback_store_id_key"              ON "ProductSourceFallback"("manufacturer_upc", "primary_store_id", "fallback_store_id");

CREATE INDEX        "StockCheckLog_store_id_idx"                                                                 ON "StockCheckLog"("store_id");
CREATE INDEX        "StockCheckLog_manufacturer_upc_idx"                                                         ON "StockCheckLog"("manufacturer_upc");
CREATE INDEX        "StockCheckLog_checked_at_idx"                                                               ON "StockCheckLog"("checked_at");

CREATE INDEX        "GTINExemption_status_idx"                                                                   ON "GTINExemption"("status");
CREATE UNIQUE INDEX "GTINExemption_brand_channel_category_key"                                                   ON "GTINExemption"("brand", "channel", "category");

CREATE INDEX        "GenerationStage_generation_job_id_idx"                                                      ON "GenerationStage"("generation_job_id");
CREATE INDEX        "GenerationStage_stage_idx"                                                                  ON "GenerationStage"("stage");

CREATE INDEX        "MarketplaceRule_channel_idx"                                                                ON "MarketplaceRule"("channel");
CREATE INDEX        "MarketplaceRule_rule_key_idx"                                                               ON "MarketplaceRule"("rule_key");
CREATE INDEX        "MarketplaceRule_is_current_idx"                                                             ON "MarketplaceRule"("is_current");
CREATE UNIQUE INDEX "MarketplaceRule_channel_category_rule_key_key"                                              ON "MarketplaceRule"("channel", "category", "rule_key");

CREATE INDEX        "ErrorPattern_channel_idx"                                                                   ON "ErrorPattern"("channel");
CREATE INDEX        "ErrorPattern_error_category_idx"                                                            ON "ErrorPattern"("error_category");
CREATE INDEX        "ErrorPattern_error_code_idx"                                                                ON "ErrorPattern"("error_code");

CREATE INDEX        "ListingLifecycleLog_entity_type_entity_id_idx"                                              ON "ListingLifecycleLog"("entity_type", "entity_id");
CREATE INDEX        "ListingLifecycleLog_master_bundle_id_idx"                                                   ON "ListingLifecycleLog"("master_bundle_id");
CREATE INDEX        "ListingLifecycleLog_channel_sku_id_idx"                                                     ON "ListingLifecycleLog"("channel_sku_id");
CREATE INDEX        "ListingLifecycleLog_created_at_idx"                                                         ON "ListingLifecycleLog"("created_at");
