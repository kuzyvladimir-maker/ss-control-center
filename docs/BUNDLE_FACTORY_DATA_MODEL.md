# BUNDLE FACTORY — Data Model v1.0 (Prisma Schema)

> **Date:** 2026-05-17
> **Source of truth:** [`BUNDLE_FACTORY_CONCEPT_v1_0.md`](BUNDLE_FACTORY_CONCEPT_v1_0.md)
> **Sourcing data:** [`BUNDLE_FACTORY_SOURCING_MAP.md`](BUNDLE_FACTORY_SOURCING_MAP.md)
> **Status:** Schema design finalized, ready for Phase 1 migration

---

## 🎯 ЦЕЛЬ ДОКУМЕНТА

Полная Prisma schema для модуля Bundle Factory. Это **executable spec** — документ читается Claude Code в VS Code и используется для генерации миграций Prisma + TypeScript типов.

Дизайн схемы решает 5 архитектурных задач:

1. **Раздельный жизненный цикл Master Bundle и Channel SKU** — рецепт продукта живёт отдельно, listings на каналах живут отдельно, синхронизация через явные foreign keys.
2. **Lifecycle tracking** — каждое состояние bundle и SKU записывается в audit log.
3. **Sourcing fallback graph** — substitute logic между магазинами через `ProductSourceFallback`.
4. **Error pattern learning** — `ErrorPattern` накапливает решения для повторных ошибок.
5. **Multi-account brand authority** — `BrandAccount` mapping (Salutem Vita → 4 accounts, Starfit → 1 account).

---

## 🗺️ SCHEMA OVERVIEW

```
                                    ┌────────────────────────────┐
                                    │   ResearchPool (1 row per  │
                                    │   product found via AI)    │
                                    └─────────┬──────────────────┘
                                              │ 1:N (component candidates)
                                              ▼
                              ┌────────────────────────────────┐
                              │   BundleDraft (in-progress)    │
                              │   Stages 1-6 of pipeline       │
                              └─────────┬──────────────────────┘
                                        │ 1:1 (after approval)
                                        ▼
   ┌──────────────────┐        ┌────────────────────────┐
   │   UPCPool        │ ──┐    │   MasterBundle         │
   │   (available)    │   │ ┌──┤   (final recipe)       │ ────────┐
   └──────────────────┘   │ │  └─────────┬──────────────┘         │
                          ▼ │            │ 1:N                    │ 1:N
            ┌────────────────────┐       ▼                        ▼
            │   ChannelSKU       │ ────► BundleComponent     ListingLifecycleLog
            │   (per channel)    │       (Jimmy Dean × 12)
            └────────┬───────────┘
                     │ N:1
                     ▼
            ┌─────────────────┐         ┌──────────────────────────┐
            │  BrandAccount   │         │  StoreRegistry           │
            │  (mapping)      │ ┌─────► │  (32 stores pre-seeded)  │
            └─────────────────┘ │       └─────────┬────────────────┘
                                │                 │ N:M (substitutes)
                                │                 ▼
                                │       ┌──────────────────────┐
            BundleComponent ────┘       │ ProductSourceFallback│
            source_store_id             └──────────────────────┘

   ┌──────────────────┐        ┌──────────────────┐
   │ GenerationJob    │ ─────► │  GenerationStage │  (logs of pipeline stages 1-7)
   └──────────────────┘  1:N   └──────────────────┘

   ┌──────────────────┐        ┌──────────────────┐
   │ MarketplaceRule  │        │ ErrorPattern     │
   │  (KB cache)      │        │ (learning loop)  │
   └──────────────────┘        └──────────────────┘

   ┌──────────────────────┐
   │   GTINExemption       │  (per-category status)
   └──────────────────────┘
```

Всего **14 моделей**. Для Phase 1 миграции — все 14 создаются разом (нет смысла делить).

---

## 🔢 ENUMS

```prisma
// Lifecycle состояний MasterBundle и ChannelSKU
enum LifecycleState {
  DRAFT
  RESEARCHED
  VARIATION_SELECTED
  GENERATED
  APPROVED
  QUEUED
  SUBMITTED
  PROCESSING
  LIVE
  ERROR
  SUSPENDED
  SUNSET_REQUESTED
  ARCHIVED
}

// Категория продуктов
enum ProductCategory {
  FROZEN_GROCERY
  REFRIGERATED
  SHELF_STABLE
  PET_FOOD
  HEALTH_BEAUTY
  BABY
  OTHER
}

// Канал продажи
enum SalesChannel {
  AMAZON_PERSONAL      // Vladimir Kuznetsov (personal)
  AMAZON_SALUTEM       // Salutem Solutions (brand owner of Salutem Vita)
  AMAZON_AMZCOM        // AMZ Commerce (authorized)
  AMAZON_SIRIUS        // Sirius International (brand owner of Starfit)
  AMAZON_RETAILER      // Retailer Distributor (authorized)
  WALMART              // Walmart Marketplace
  EBAY                 // eBay (Phase 2)
  TIKTOK_1             // TikTok Shop #1 (Phase 2)
  TIKTOK_2             // TikTok Shop #2 (Phase 2)
}

// Тип композиции bundle
enum CompositionType {
  SINGLE_FLAVOR        // Pack of 12 same Uncrustables PB
  MIXED_FLAVOR         // Variety pack
  USE_CASE             // School lunch box mix
  HOLIDAY_THEMED       // Christmas / Valentine / etc.
  CROSS_BRAND          // Mix of multi-brand products (gift basket)
}

// Стадия pipeline
enum PipelineStage {
  BRIEF
  RESEARCH
  VARIATION_MATRIX
  CONTENT_GENERATION
  IMAGE_GENERATION
  VALIDATION
  DISTRIBUTION
}

// Статус выполнения этапа
enum StageStatus {
  PENDING
  IN_PROGRESS
  COMPLETED
  FAILED
  SKIPPED
}

// Категории ошибок (для Error Feedback Loop)
enum ErrorCategory {
  MISSING_REQUIRED_ATTRIBUTE
  TITLE_LENGTH_EXCEEDED
  BANNED_WORD
  IMAGE_URL_INACCESSIBLE
  DUPLICATE_GTIN
  INVALID_BROWSE_NODE
  POLICY_VIOLATION_BRAND
  POLICY_VIOLATION_BUNDLE
  COMPLIANCE_GROCERY
  COMPLIANCE_FROZEN
  UNKNOWN
}

// Статус UPC в pool
enum UPCStatus {
  AVAILABLE             // Не использован, доступен
  RESERVED              // Зарезервирован под bundle (в процессе генерации)
  ASSIGNED              // Назначен ChannelSKU
  RETIRED               // Отозван (например, listing удалён)
  INVALID               // Не прошёл GEPIR validation
}

// Тип магазина в Sourcing
enum StoreType {
  SUPERCENTER           // Walmart Supercenter
  NEIGHBORHOOD_MARKET   // Walmart NM
  WAREHOUSE_CLUB        // BJ's, Sam's, Costco
  STANDARD_GROCERY      // Publix, Winn-Dixie
  DEPARTMENT_STORE      // Target
  DISCOUNT_GROCERY      // ALDI
  PREMIUM_GROCERY       // Whole Foods, Fresh Market, Trader Joe's
  SPECIALTY             // Restaurant Depot, Costco Business
}

// Tier приоритета магазина
enum StoreTier {
  TIER_1                // Primary (Walmart, BJ's)
  TIER_2                // Secondary (Target, Publix)
  TIER_3                // Bulk specialist (Sam's, Costco)
  TIER_4                // Discount fallback (ALDI)
  TIER_5                // Specialty / extended (Whole Foods, TJ's, Fresh Market, Winn-Dixie)
}

// GTIN exemption статус
enum GTINExemptionStatus {
  NOT_REQUESTED
  PENDING_APPLICATION   // Документы подготовлены, Vladimir submit'нул
  UNDER_REVIEW          // Amazon обрабатывает
  APPROVED
  DENIED
}
```

---

## 🏛️ CORE MODELS

### `MasterBundle` — рецепт продукта

Концептуальная единица, которая может быть размножена на каналы. Один `MasterBundle` → несколько `ChannelSKU`.

```prisma
model MasterBundle {
  id                    String              @id @default(cuid())

  // Identity
  name                  String              // "Jimmy Dean Breakfast Sandwich Gift Set, Pack of 12"
  internal_slug         String              @unique  // "jimmy-dean-breakfast-12pack-v1"
  brand                 String              // "Salutem Vita" | "Starfit"
  category              ProductCategory

  // Composition
  composition_type      CompositionType
  pack_count            Int                 // 12
  total_weight_oz       Float?              // вычисляется суммой компонентов
  total_weight_lb       Float?

  // Pricing (per marketplace, см. ChannelSKU тоже)
  cost_breakdown        Json                // { goods_cents: 4500, packaging_cents: 350, sourcing_overhead_cents: 200 }
  estimated_cost_cents  Int
  suggested_price_cents Int

  // Packaging
  packaging_spec        Json                // { cooler_size: "small", gel_packs_qty: 2, outer_box: "Salutem Solutions GIFT SET 12 COUNT" }

  // Images (master, used across all channels по умолчанию)
  main_image_url        String              // CDN URL of AI-generated main
  secondary_images      Json                // ["url1", "url2", "url3"] — array
  image_generation_meta Json?               // { engine: "gpt-image-2", prompt_id: "...", generated_at: ... }

  // Lifecycle
  lifecycle_status      LifecycleState      @default(DRAFT)

  // Relations
  components            BundleComponent[]
  channel_skus          ChannelSKU[]
  lifecycle_logs        ListingLifecycleLog[]
  generation_job_id     String?             @unique
  generation_job        GenerationJob?      @relation(fields: [generation_job_id], references: [id])
  research_pool_seed_id String?
  research_pool_seed    ResearchPool?       @relation(fields: [research_pool_seed_id], references: [id])

  // Audit
  created_at            DateTime            @default(now())
  updated_at            DateTime            @updatedAt
  created_by_user_id    String?

  @@index([brand])
  @@index([category])
  @@index([lifecycle_status])
  @@index([created_at])
}
```

### `BundleComponent` — состав bundle

Каждый component — один тип продукта внутри bundle. У одного `MasterBundle` обычно 1-5 components.

```prisma
model BundleComponent {
  id                    String              @id @default(cuid())
  master_bundle_id      String
  master_bundle         MasterBundle        @relation(fields: [master_bundle_id], references: [id], onDelete: Cascade)

  // Product identity
  product_name          String              // "Jimmy Dean Breakfast Sandwich, 4.9 oz"
  manufacturer_brand    String              // "Jimmy Dean" — НЕ Salutem Vita; это бренд исходного продукта
  manufacturer_upc      String?             // UPC original Jimmy Dean (не наш)
  flavor                String?             // "Sausage, Egg & Cheese"
  variant               String?

  // Quantity in bundle
  qty                   Int                 // 12

  // Weight per unit
  unit_weight_oz        Float?
  unit_weight_lb        Float?

  // Cost
  unit_price_cents      Int                 // $4.99 from Walmart → 499
  source_store_id       String?
  source_store          StoreRegistry?      @relation(fields: [source_store_id], references: [id])
  source_url            String?             // URL of product on walmart.com / target.com

  // Metadata
  ingredients           String?             // для compliance с FDA
  allergens             Json?               // ["wheat", "dairy", "soy"]
  storage_temp          String?             // "Frozen" | "Refrigerated" | "Shelf-stable"
  expiration_days       Int?

  // Image references (donor pool — для использования в Stage 5)
  donor_image_urls      Json                // ["url1", "url2"]

  created_at            DateTime            @default(now())
  updated_at            DateTime            @updatedAt

  @@index([master_bundle_id])
  @@index([manufacturer_brand])
}
```

### `ChannelSKU` — listing на конкретном канале

Один `ChannelSKU` = один listing на одном marketplace под одним аккаунтом. У одного `MasterBundle` обычно 5-9 `ChannelSKU` (по числу активных каналов).

```prisma
model ChannelSKU {
  id                    String              @id @default(cuid())
  master_bundle_id      String
  master_bundle         MasterBundle        @relation(fields: [master_bundle_id], references: [id], onDelete: Cascade)

  // Channel binding
  channel               SalesChannel
  brand_account_id      String?
  brand_account         BrandAccount?       @relation(fields: [brand_account_id], references: [id])

  // Identity
  sku                   String              @unique     // XX-XXXX-XXXX, например 0A-2DLV-8XJU
  upc                   String              @unique     // из UPCPool
  upc_pool_id           String?
  upc_pool              UPCPool?            @relation(fields: [upc_pool_id], references: [id])

  // Marketplace IDs (после публикации)
  asin                  String?             // Amazon ASIN
  walmart_item_id       String?
  ebay_item_id          String?
  tiktok_product_id     String?

  // Content (adapted to channel char limits)
  title                 String              // ≤200 chars Amazon, ≤75 Walmart, ≤80 eBay, ≤100 TikTok
  bullets               Json                // array of 5 strings
  description           String              // HTML for Amazon (A+ Content), plain for Walmart/eBay/TikTok
  search_terms          String?             // 250 байт backend keywords (Amazon)
  attributes            Json                // channel-specific schema (browse_node, storage_temp, allergens, etc.)

  // Browse node / category на channel (компонент policy enforcement)
  channel_category      String?             // "Food Assortments & Variety Gifts" для Amazon
  channel_browse_node   String?             // "16322521" (numeric ID)

  // Pricing (per-channel)
  price_cents           Int
  business_price_cents  Int?                // только для Amazon B2B

  // Lifecycle
  lifecycle_status      LifecycleState      @default(DRAFT)

  // Publication tracking
  submitted_at          DateTime?
  processing_at         DateTime?
  live_at               DateTime?
  live_url              String?             // https://amazon.com/dp/B0FH...
  last_error_at         DateTime?
  errors                Json?               // array of {code, message, category}

  // Sales tracking (populated через периодический sync)
  units_sold_30d        Int?                @default(0)
  revenue_30d_cents     Int?                @default(0)

  // Relations
  lifecycle_logs        ListingLifecycleLog[]

  // Audit
  created_at            DateTime            @default(now())
  updated_at            DateTime            @updatedAt

  @@index([master_bundle_id])
  @@index([channel])
  @@index([lifecycle_status])
  @@index([asin])
  @@index([walmart_item_id])
}
```

### `ResearchPool` — продукты, найденные на Stage 2

Каждая запись — один продукт, обнаруженный AI-агентом в магазине. Используется как пул для генерации `BundleDraft`.

```prisma
model ResearchPool {
  id                    String              @id @default(cuid())

  // Search context
  research_query        String              // "Jimmy Dean breakfast sandwich"
  generation_job_id     String?
  generation_job        GenerationJob?      @relation(fields: [generation_job_id], references: [id])

  // Product data
  product_name          String
  brand                 String              // manufacturer brand
  manufacturer          String?
  upc                   String?             // original UPC if scraped

  // Variations
  flavors               Json?               // array of strings
  pack_sizes            Json?               // array of integers
  weight_oz             Float?
  weight_lb             Float?

  // Composition
  ingredients           String?
  allergens             Json?
  nutrition             Json?
  storage_temp          String?
  expiration_days       Int?

  // Reference images (donor pool)
  reference_image_urls  Json                // ["url1", "url2", ...]

  // Pricing
  avg_price_cents       Int?
  source_store_id       String?
  source_store          StoreRegistry?      @relation(fields: [source_store_id], references: [id])
  source_url            String?
  last_seen_in_stock    DateTime?

  // Quality scoring
  freshness_score       Float?              // 0.0-1.0 (как давно scraped + how often in stock)

  // Relations
  master_bundles        MasterBundle[]      // bundles seeded from this product

  // Audit
  created_at            DateTime            @default(now())
  updated_at            DateTime            @updatedAt

  @@index([brand])
  @@index([generation_job_id])
  @@index([last_seen_in_stock])
}
```

### `BundleDraft` — bundle в процессе генерации

Промежуточная сущность для Stages 3-6 pipeline. После approval (Stage 6) преобразуется в `MasterBundle` + `ChannelSKU[]`.

```prisma
model BundleDraft {
  id                    String              @id @default(cuid())
  generation_job_id     String
  generation_job        GenerationJob       @relation(fields: [generation_job_id], references: [id], onDelete: Cascade)

  // Draft state
  draft_name            String              // "Jimmy Dean PB&J Mix, Pack of 12"
  brand                 String
  category              ProductCategory
  composition_type      CompositionType
  pack_count            Int

  // Composition (snapshot of selected components from ResearchPool)
  draft_components      Json                // [{product_name, qty, source_store_id, ...}, ...]

  // Generated content (Stage 4)
  draft_title           String?
  draft_bullets         Json?
  draft_description     String?
  draft_search_terms    String?

  // Generated images (Stage 5)
  draft_main_image_url  String?
  draft_secondary_images Json?

  // Cost estimate
  draft_cost_cents      Int?
  draft_suggested_price_cents Int?

  // Status
  status                LifecycleState      @default(VARIATION_SELECTED)
  approval_notes        String?

  // Selected channels for distribution
  target_channels       Json                // ["AMAZON_SALUTEM", "WALMART"]

  // After approval — link to created MasterBundle
  master_bundle_id      String?             @unique

  // Audit
  created_at            DateTime            @default(now())
  updated_at            DateTime            @updatedAt

  @@index([generation_job_id])
  @@index([status])
}
```

---

## 📦 SOURCING MODELS

### `StoreRegistry` — реестр всех магазинов

Pre-seeded из `BUNDLE_FACTORY_SOURCING_MAP.md`. 32 записи на старте.

```prisma
model StoreRegistry {
  id                    String              @id              // e.g. "walmart_supercenter_us19"
  name                  String              // "Walmart Supercenter US-19"
  chain                 String              // "Walmart" | "Target" | "BJ's" | "Publix" | ...
  store_type            StoreType
  tier                  StoreTier

  // Location
  address               String              // "23106 US Hwy 19 N, Clearwater, FL 33765"
  latitude              Float
  longitude             Float
  distance_mi           Float               // от 1162 Kapp Dr
  google_place_id       String?
  google_maps_url       String?

  // Operational
  phone                 String?
  hours_text            String?             // "6:00-23:00 daily"
  hours_json            Json?               // structured per day
  website_url           String?

  // Delivery
  delivery_program      String?             // "Walmart+", "Circle 360", etc.
  delivery_cost_cents   Int                 @default(0)
  delivery_notes        String?

  // Status
  is_active             Boolean             @default(true)
  is_membership_required Boolean            @default(false)
  membership_active     Boolean             @default(false)
  membership_renewal    DateTime?

  // Priority
  default_priority      Int                 // 1 = highest, used as default for new SKUStorePriority records

  // Operational metadata
  last_validated_at     DateTime?           // when stock-check API was last successful
  notes                 String?

  // Relations
  components_sourced    BundleComponent[]
  research_pool         ResearchPool[]
  fallback_from         ProductSourceFallback[] @relation("PrimarySource")
  fallback_to           ProductSourceFallback[] @relation("FallbackSource")
  stock_checks          StockCheckLog[]

  // Audit
  created_at            DateTime            @default(now())
  updated_at            DateTime            @updatedAt

  @@index([chain])
  @@index([tier])
  @@index([is_active])
  @@index([distance_mi])
}
```

### `ProductSourceFallback` — substitute graph

Когда primary source (например Walmart US-19) out-of-stock для конкретного UPC, система пытается fallback на secondary sources.

```prisma
model ProductSourceFallback {
  id                    String              @id @default(cuid())

  manufacturer_upc      String              // UPC оригинального продукта (например Jimmy Dean UPC)
  product_name          String

  primary_store_id      String
  primary_store         StoreRegistry       @relation("PrimarySource", fields: [primary_store_id], references: [id])

  fallback_store_id     String
  fallback_store        StoreRegistry       @relation("FallbackSource", fields: [fallback_store_id], references: [id])

  fallback_priority     Int                 // 1 = первый fallback, 2 = второй, и т.д.

  // Stats
  primary_oos_count     Int                 @default(0)  // сколько раз primary был OOS
  fallback_used_count   Int                 @default(0)  // сколько раз fallback успешно использован
  fallback_failed_count Int                 @default(0)  // сколько раз fallback тоже OOS

  notes                 String?

  created_at            DateTime            @default(now())
  updated_at            DateTime            @updatedAt

  @@unique([manufacturer_upc, primary_store_id, fallback_store_id])
  @@index([manufacturer_upc])
}
```

### `StockCheckLog` — лог проверок наличия

Используется для:
- Pre-publication re-check (Stage 6)
- Quarterly sourcing validation
- Аналитика frequency of OOS

```prisma
model StockCheckLog {
  id                    String              @id @default(cuid())

  store_id              String
  store                 StoreRegistry       @relation(fields: [store_id], references: [id])

  manufacturer_upc      String?
  product_name          String?

  in_stock              Boolean
  price_cents           Int?
  source_url            String?
  raw_response          Json?               // сохраняем raw scraping response для дебага

  checked_at            DateTime            @default(now())
  check_method          String              // "scraper" | "manual" | "api"

  @@index([store_id])
  @@index([manufacturer_upc])
  @@index([checked_at])
}
```

---

## 🆔 IDENTITY MODELS

### `UPCPool` — pool UPC кодов

Pre-seeded из существующих UPC Vladimir (~3 префикса: 742259xxx, 789232xxx, 617261xxx). После Phase 1 — может пополняться вручную через UI.

```prisma
model UPCPool {
  id                    String              @id @default(cuid())
  upc                   String              @unique
  upc_prefix            String              // "742259" / "789232" / "617261"
  gs1_validated         Boolean             @default(false)  // прошёл GEPIR check
  gs1_owner             String?             // если GEPIR вернул owner

  status                UPCStatus           @default(AVAILABLE)

  // Если ASSIGNED — на какой ChannelSKU
  assigned_to_id        String?             @unique
  assigned_to           ChannelSKU?

  // Если RESERVED — на какой BundleDraft
  reserved_for_id       String?
  reserved_at           DateTime?
  reserved_until        DateTime?           // авто-релиз через TTL

  // Metadata
  acquired_from         String?             // "SpeedyBarCode batch 2023-01" / "GS1 official"
  acquired_at           DateTime?
  notes                 String?

  created_at            DateTime            @default(now())
  updated_at            DateTime            @updatedAt

  @@index([status])
  @@index([upc_prefix])
  @@index([gs1_validated])
}
```

### `GTINExemption` — статус GTIN exemption по категориям

Vladimir подаёт exemption applications для Salutem Vita brand отдельно в каждой категории. Эта таблица трекает статус.

```prisma
model GTINExemption {
  id                    String              @id @default(cuid())
  brand                 String              // "Salutem Vita" | "Starfit"
  channel               SalesChannel        // exemption специфичен per-channel
  category              ProductCategory

  status                GTINExemptionStatus @default(NOT_REQUESTED)

  application_date      DateTime?
  approval_date         DateTime?
  denial_reason         String?

  application_pdf_url   String?             // ссылка на PDF в Google Drive
  reference_id          String?             // Amazon case ID

  notes                 String?

  created_at            DateTime            @default(now())
  updated_at            DateTime            @updatedAt

  @@unique([brand, channel, category])
  @@index([status])
}
```

### `BrandAccount` — mapping brand → account

```prisma
model BrandAccount {
  id                    String              @id @default(cuid())
  brand                 String              // "Salutem Vita" | "Starfit"
  channel               SalesChannel
  is_brand_owner        Boolean             // true если этот аккаунт = Brand Registry owner
  is_authorized_seller  Boolean             // true если authorized но не owner
  selling_partner_id    String?             // Amazon SP-API merchant ID, Walmart seller ID

  // Status
  is_active             Boolean             @default(true)
  notes                 String?

  // Relations
  channel_skus          ChannelSKU[]

  created_at            DateTime            @default(now())
  updated_at            DateTime            @updatedAt

  @@unique([brand, channel])
  @@index([brand])
  @@index([channel])
}
```

---

## ⚙️ GENERATION TRACKING

### `GenerationJob` — экземпляр запуска pipeline

```prisma
model GenerationJob {
  id                    String              @id @default(cuid())

  // Brief input (Stage 1)
  brief                 Json                // вся форма от пользователя

  // Status
  current_stage         PipelineStage       @default(BRIEF)
  status                StageStatus         @default(PENDING)

  // Stats
  bundles_target        Int                 // запрошено пользователем (например, 15)
  bundles_generated     Int                 @default(0)
  bundles_approved      Int                 @default(0)
  bundles_published     Int                 @default(0)
  bundles_error         Int                 @default(0)

  // Resources used
  openai_tokens_used    Int                 @default(0)
  perplexity_queries    Int                 @default(0)
  images_generated      Int                 @default(0)
  cost_cents            Int                 @default(0)         // total operational cost

  // User context
  user_id               String?
  notes                 String?

  // Relations
  stages                GenerationStage[]
  research_pool         ResearchPool[]
  bundle_drafts         BundleDraft[]
  master_bundles        MasterBundle[]

  // Audit
  created_at            DateTime            @default(now())
  updated_at            DateTime            @updatedAt
  completed_at          DateTime?

  @@index([status])
  @@index([current_stage])
}
```

### `GenerationStage` — лог исполнения каждой стадии

```prisma
model GenerationStage {
  id                    String              @id @default(cuid())
  generation_job_id     String
  generation_job        GenerationJob       @relation(fields: [generation_job_id], references: [id], onDelete: Cascade)

  stage                 PipelineStage
  status                StageStatus         @default(PENDING)

  started_at            DateTime?
  completed_at          DateTime?
  duration_ms           Int?

  input_snapshot        Json?
  output_snapshot       Json?
  error                 String?

  @@index([generation_job_id])
  @@index([stage])
}
```

---

## 📚 KB MODELS

### `MarketplaceRule` — кэш правил Marketplace Rules KB

Хотя основная KB живёт в `docs/marketplace-rules/`, частые правила кешируются в БД для быстрого доступа AI-агентам.

```prisma
model MarketplaceRule {
  id                    String              @id @default(cuid())

  channel               SalesChannel
  category              ProductCategory?
  rule_key              String              // "title.max_length" | "bullets.count" | "browse_node.gift_basket"
  rule_value            Json                // 200 | 5 | "16322521" | { ... complex object ... }

  // Provenance
  source_doc_path       String              // "docs/marketplace-rules/amazon/title-policy.md"
  source_url            String?             // original Amazon Help URL
  scraped_at            DateTime?
  validated_at          DateTime?
  is_current            Boolean             @default(true)

  notes                 String?

  // Audit
  created_at            DateTime            @default(now())
  updated_at            DateTime            @updatedAt

  @@unique([channel, category, rule_key])
  @@index([channel])
  @@index([rule_key])
  @@index([is_current])
}
```

### `ErrorPattern` — learning loop

Каждая встретившаяся ошибка от marketplace + её fix. Накапливается для проактивной валидации в Stage 6.

```prisma
model ErrorPattern {
  id                    String              @id @default(cuid())

  channel               SalesChannel
  error_category        ErrorCategory
  error_code            String              // например "8541" (Amazon error code)
  error_message_pattern String              // regex или substring для матчинга

  // Fix strategy
  fix_strategy          String              // "AUTO_FIX_TITLE_TRUNCATE" | "AUTO_FIX_ADD_ATTRIBUTE" | "ESCALATE"
  fix_handler_name      String?             // имя функции в коде

  // Stats
  occurrences           Int                 @default(0)
  auto_fix_success      Int                 @default(0)
  auto_fix_failure      Int                 @default(0)
  last_seen             DateTime?

  // Documentation
  description           String?
  example_input         Json?
  example_output        Json?

  // Audit
  created_at            DateTime            @default(now())
  updated_at            DateTime            @updatedAt

  @@index([channel])
  @@index([error_category])
  @@index([error_code])
}
```

---

## 📜 AUDIT MODEL

### `ListingLifecycleLog` — полный audit trail

Каждое изменение `MasterBundle.lifecycle_status` или `ChannelSKU.lifecycle_status` записывается.

```prisma
model ListingLifecycleLog {
  id                    String              @id @default(cuid())

  // Что меняется
  entity_type           String              // "MasterBundle" | "ChannelSKU"
  entity_id             String

  master_bundle_id      String?
  master_bundle         MasterBundle?       @relation(fields: [master_bundle_id], references: [id], onDelete: Cascade)

  channel_sku_id        String?
  channel_sku           ChannelSKU?         @relation(fields: [channel_sku_id], references: [id], onDelete: Cascade)

  // Transition
  from_status           LifecycleState?
  to_status             LifecycleState

  // Context
  trigger               String              // "user_approve" | "auto_publish" | "marketplace_error" | "sourcing_oos" | etc.
  details               Json?               // полный contextual snapshot
  user_id               String?

  // Audit
  created_at            DateTime            @default(now())

  @@index([entity_type, entity_id])
  @@index([master_bundle_id])
  @@index([channel_sku_id])
  @@index([created_at])
}
```

---

## 🌱 PRE-SEED DATA

При первой миграции в БД должны быть seed-ом загружены:

### 1. `StoreRegistry` — 32 магазина

Pre-seed файл: `prisma/seed/store-registry.ts`. Полные данные из `BUNDLE_FACTORY_SOURCING_MAP.md`.

```typescript
// Сокращённый пример первых 5 записей
export const STORE_REGISTRY_SEED = [
  {
    id: 'walmart_supercenter_us19',
    name: 'Walmart Supercenter US-19',
    chain: 'Walmart',
    store_type: 'SUPERCENTER',
    tier: 'TIER_1',
    address: '23106 US Hwy 19 N, Clearwater, FL 33765',
    latitude: 27.9827016,
    longitude: -82.7325222,
    distance_mi: 1.2,
    google_place_id: 'ChIJ29AO4SbuwogRkIbpV9gJTMY',
    phone: '+1 727-724-7777',
    hours_text: '6:00-23:00 daily',
    website_url: 'https://www.walmart.com/store/2081-clearwater-fl/',
    delivery_program: 'Walmart+',
    delivery_cost_cents: 0,
    is_active: true,
    is_membership_required: false,
    membership_active: true,
    default_priority: 1,
    notes: 'PRIMARY SOURCE. Full grocery + frozen + electronics.',
  },
  {
    id: 'walmart_nm_gulf_to_bay',
    name: 'Walmart Neighborhood Market Gulf-to-Bay',
    chain: 'Walmart',
    store_type: 'NEIGHBORHOOD_MARKET',
    tier: 'TIER_1',
    address: '2171 Gulf to Bay Blvd, Clearwater, FL 33765',
    latitude: 27.9592073,
    longitude: -82.748287,
    distance_mi: 1.3,
    google_place_id: 'ChIJ45SNWTDwwogRuNlu9TNS4_c',
    phone: '+1 727-431-4900',
    hours_text: '6:00-23:00 daily',
    website_url: 'https://www.walmart.com/store/5670-clearwater-fl/',
    delivery_program: 'Walmart+',
    delivery_cost_cents: 0,
    is_active: true,
    is_membership_required: false,
    membership_active: true,
    default_priority: 2,
    notes: 'Grocery only, no electronics.',
  },
  // ... остальные 30 записей с полными данными
];
```

Полный seed файл (32 записи) генерируется Claude Code в Phase 1.

### 2. `BrandAccount` — 9 записей mapping брендов

```typescript
export const BRAND_ACCOUNT_SEED = [
  // Salutem Vita
  { brand: 'Salutem Vita', channel: 'AMAZON_SALUTEM', is_brand_owner: true, is_authorized_seller: false },
  { brand: 'Salutem Vita', channel: 'AMAZON_PERSONAL', is_brand_owner: false, is_authorized_seller: true },
  { brand: 'Salutem Vita', channel: 'AMAZON_AMZCOM', is_brand_owner: false, is_authorized_seller: true },
  { brand: 'Salutem Vita', channel: 'AMAZON_RETAILER', is_brand_owner: false, is_authorized_seller: true },
  { brand: 'Salutem Vita', channel: 'WALMART', is_brand_owner: true, is_authorized_seller: false },

  // Starfit
  { brand: 'Starfit', channel: 'AMAZON_SIRIUS', is_brand_owner: true, is_authorized_seller: false },
  { brand: 'Starfit', channel: 'AMAZON_SALUTEM', is_brand_owner: false, is_authorized_seller: true },
  { brand: 'Starfit', channel: 'AMAZON_PERSONAL', is_brand_owner: false, is_authorized_seller: true },
  { brand: 'Starfit', channel: 'AMAZON_AMZCOM', is_brand_owner: false, is_authorized_seller: true },
];
```

### 3. `UPCPool` — импорт существующих UPC

Источник: парсинг `Active_Listings_Report_05-17-2026__1_.txt` → извлечение всех UPC начинающихся на 742259/789232/617261. **Все уже-использованные = `ASSIGNED`**, прочие = `AVAILABLE` (без gs1_validated пока).

Скрипт миграции: `prisma/seed/upc-pool-import.ts` читает .txt отчёт, парсит UPC + использование. Pre-seed добавляет ~1500+ записей.

После Phase 1 — Vladimir может загружать дополнительные batches UPC через UI (Phase 12).

### 4. `MarketplaceRule` — базовые правила

После Phase 0 KB research → seed top-30 rules для Amazon + Walmart. Пример:

```typescript
export const MARKETPLACE_RULE_SEED = [
  { channel: 'AMAZON_SALUTEM', category: null, rule_key: 'title.max_length', rule_value: 200, source_doc_path: 'docs/marketplace-rules/amazon/title-policy.md' },
  { channel: 'AMAZON_SALUTEM', category: null, rule_key: 'bullets.count', rule_value: 5, source_doc_path: 'docs/marketplace-rules/amazon/bullet-points-policy.md' },
  { channel: 'AMAZON_SALUTEM', category: 'FROZEN_GROCERY', rule_key: 'browse_node.gift_basket', rule_value: '16322521', source_doc_path: 'docs/marketplace-rules/amazon/browse-nodes-grocery.md' },
  { channel: 'WALMART', category: null, rule_key: 'title.max_length', rule_value: 75, source_doc_path: 'docs/marketplace-rules/walmart/title-policy.md' },
  // ... ~30 records
];
```

---

## 🚧 MIGRATION PLAN

### Phase 1 Migration (executable through Claude Code)

```bash
# Step 1: Create migration
npx prisma migrate dev --name bundle_factory_phase_1_initial

# Step 2: Run seed scripts
npx prisma db seed
```

`prisma/seed.ts` orchestrates:
1. Создание enums (auto через Prisma)
2. Создание 14 таблиц (auto через Prisma)
3. Import seed `StoreRegistry` (32 stores)
4. Import seed `BrandAccount` (9 records)
5. Import `UPCPool` из Active Listings Reports
6. Import seed `MarketplaceRule` (top-30, после Phase 0 KB)
7. Создание admin GTIN exemption records (для tracking — `NOT_REQUESTED` для каждой brand×channel×category комбинации)

### Phase 1 Scope (что входит)

- ✅ Создать все 14 таблиц
- ✅ Pre-seed `StoreRegistry` (32 stores)
- ✅ Pre-seed `BrandAccount` (9 mappings)
- ✅ Import `UPCPool` из существующих листингов
- ✅ Базовый CRUD-skeleton для всех 14 моделей через Prisma Studio
- ✅ Минимальная UI-страница `/bundle-factory` (placeholder с табами "Briefs", "Drafts", "Live")
- ✅ API endpoints: `/api/bundle-factory/briefs`, `/api/bundle-factory/research`, `/api/bundle-factory/drafts`, `/api/bundle-factory/master-bundles`, `/api/bundle-factory/stores`

### Что НЕ входит в Phase 1

- ❌ Actual Stage 2 (Research) пайплайн — это Phase 3
- ❌ AI content generation — Phase 5
- ❌ Image generation — Phase 6
- ❌ Distribution через SP-API/Walmart API — Phase 9-10
- ❌ Marketplace Rules KB seed — после Phase 0 (KB research)

---

## 🔗 СВЯЗИ

```
Bundle Factory Data Model
    ← BUNDLE_FACTORY_CONCEPT_v1_0.md (концепция)
    ← BUNDLE_FACTORY_SOURCING_MAP.md (источник StoreRegistry seed)
    ← Active_Listings_Report_05-17-2026__1_.txt (источник UPCPool seed)
    ⊂ database-schema.md (общая схема проекта)
    → CLAUDE_CODE_PROMPT_BUNDLE_FACTORY_PHASE_1.md (первый промпт Phase 1)
    → docs/marketplace-rules/ (Phase 0 KB → MarketplaceRule seed)
```

---

## 📝 OPERATIONAL NOTES

### Indexes priorities

Все foreign keys имеют indexes (Prisma defaults). Дополнительные indexes на полях, которые будут часто фильтроваться в UI:

- `MasterBundle.lifecycle_status` — для фильтра в Drafts/Live tabs
- `ChannelSKU.channel` — для multi-channel view
- `ChannelSKU.asin` — для lookup по Amazon ASIN
- `UPCPool.status` — для allocation UPC из AVAILABLE pool
- `StoreRegistry.distance_mi` — для priority sorting
- `ErrorPattern.error_code` — для quick lookup при processing errors

### Cascade deletes

- `MasterBundle.components` → CASCADE (компоненты бесполезны без bundle)
- `MasterBundle.channel_skus` → CASCADE (SKU не существуют без master)
- `MasterBundle.lifecycle_logs` → CASCADE
- `GenerationJob.bundle_drafts` → CASCADE
- `GenerationJob.research_pool` → ОСТАВИТЬ (research pool можно reuse в других jobs)

### Soft delete vs hard delete

В MVP — **hard delete**. Для historical analytics в будущем — добавим `deleted_at` поля + soft delete patterns. Не в Phase 1.

### JSON fields — почему так много

Prisma + SQLite (Turso) поддерживают JSON, но не позволяют index по JSON-полям. JSON используется там, где структура **гибкая** и не используется для частых WHERE clause: `attributes`, `payload`, `cost_breakdown`, `image_generation_meta`, etc.

Где нужны частые WHERE — поля типизированные (например, `brand`, `category`, `lifecycle_status`).

---

## 📚 РОДСТВЕННЫЕ ДОКУМЕНТЫ

- [`BUNDLE_FACTORY_CONCEPT_v1_0.md`](BUNDLE_FACTORY_CONCEPT_v1_0.md) — master concept (source of truth)
- [`BUNDLE_FACTORY_SOURCING_MAP.md`](BUNDLE_FACTORY_SOURCING_MAP.md) — source данных для `StoreRegistry` pre-seed
- [`docs/wiki/bundle-factory.md`](wiki/bundle-factory.md) — wiki overview
- [`docs/wiki/database-schema.md`](wiki/database-schema.md) — общая схема проекта (будет обновлена с Bundle Factory моделями)
- `CLAUDE_CODE_PROMPT_BUNDLE_FACTORY_PHASE_1.md` (TBD) — executable prompt для миграции

---

**End of Data Model v1.0** — 2026-05-17
