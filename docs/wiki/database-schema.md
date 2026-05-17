# 🗄️ Database Schema (Prisma)

## Суть
SQLite через Prisma ORM. **33+ моделей** (базовые модули + 14 Bundle Factory). Файл: `prisma/schema.prisma`. Generated client: `src/generated/prisma/`. Production = Turso (libsql); локально = `dev.db`. Bundle Factory Phase 1 миграция применена в ветке `feat/bundle-factory-phase-1` 2026-05-17.

## Модели по модулям

### Customer Hub
| Модель | Назначение |
|--------|-----------|
| `BuyerMessage` | Сообщения покупателей (Gmail + скриншоты) |
| `AtozzClaim` | A-to-Z claims + Chargebacks |
| `SellerFeedback` | Отзывы продавца |
| `ProductReview` | Отзывы на товар |
| `CsCase` | Legacy CS кейсы |

### Shipping
| Модель | Назначение |
|--------|-----------|
| `ShippingPlan` | Планы доставки |
| `ShippingPlanItem` | Позиции в плане |
| `ProductTypeOverride` | Frozen/Dry переопределения |

### Analytics
| Модель | Назначение |
|--------|-----------|
| `FrozenIncident` | Инциденты frozen |
| `SkuRiskProfile` | Риск-профили SKU |
| `ShippingAdjustment` | Корректировки |
| `SkuAdjustmentProfile` | Профили корректировок |

### Account Health
| Модель | Назначение |
|--------|-----------|
| `AccountHealthSnapshot` | Снимки метрик |
| `AccountAlert` | Алерты |

### System
| Модель | Назначение |
|--------|-----------|
| `Store` | Магазины |
| `Setting` | Настройки |
| `AmazonOrder` | Синхронизированные заказы |
| `ReportSyncJob` | Задачи синхронизации |
| `SyncLog` | Логи синхронизации |

### Bundle Factory (Phase 1 — реализована в `feat/bundle-factory-phase-1`, миграция `20260517000000_bundle_factory_phase_1_initial`)
| Модель | Назначение |
|--------|-----------|
| `MasterBundle` | Рецепт продукта (концептуальная единица). Один → несколько ChannelSKU |
| `BundleComponent` | Состав bundle (1-5 продуктов внутри) |
| `ChannelSKU` | Listing на конкретном канале (Amazon/Walmart/eBay/TikTok). У одного MasterBundle обычно 5-9 |
| `ResearchPool` | Продукты, найденные AI на Stage 2 pipeline |
| `BundleDraft` | Bundle в процессе генерации (Stages 3-6) |
| `StoreRegistry` | Реестр магазинов (37 pre-seeded: 14 Walmart + 1 BJ's + 3 Target + 9 Publix + 1 Sam's + 1 Costco + 2 ALDI + 1 Whole Foods + 1 Trader Joe's + 1 Fresh Market + 3 Winn-Dixie) |
| `ProductSourceFallback` | Substitute graph: primary store OOS → fallback chain |
| `StockCheckLog` | Лог проверок наличия (pre-publication recheck, quarterly validation) |
| `UPCPool` | Pool UPC кодов (Vladimir's pre-seed: 742259/789232/617261 prefixes) |
| `GTINExemption` | Статус GTIN exemption (per brand × channel × category) |
| `BrandAccount` | Mapping brand → account (9 records: Salutem Vita × 5 + Starfit × 4) |
| `GenerationJob` | Экземпляр запуска AI pipeline |
| `GenerationStage` | Лог исполнения каждой из 7 стадий pipeline |
| `MarketplaceRule` | Кэш правил Marketplace Rules KB (для AI prompts) |
| `ErrorPattern` | Learning loop: накапливающиеся marketplace errors + fixes |
| `ListingLifecycleLog` | Audit trail для MasterBundle + ChannelSKU lifecycle transitions |

**Полная схема:** [`BUNDLE_FACTORY_DATA_MODEL.md`](../BUNDLE_FACTORY_DATA_MODEL.md). Enum-эквиваленты хранятся как TEXT (SQLite + Prisma 7 не поддерживают native enum), список разрешённых значений — в `src/lib/bundle-factory/enums.ts` (LIFECYCLE_STATES, PRODUCT_CATEGORIES, SALES_CHANNELS, COMPOSITION_TYPES, PIPELINE_STAGES, STAGE_STATUSES, ERROR_CATEGORIES, UPC_STATUSES, STORE_TYPES, STORE_TIERS, GTIN_EXEMPTION_STATUSES). Pre-seed: 37 stores + 9 brand accounts + 30 marketplace rules + 63 GTIN exemption tracker rows; UPC pool импортируется опционально из `data/imports/Active_Listings_Report_*.txt`. Turso миграция: `ss-control-center/scripts/turso-migrate-bundle-factory-phase-1.mjs` (запускается вручную).

## Связанные файлы
- `prisma/schema.prisma` — определение схемы
- `src/lib/prisma.ts` — клиент
- `src/generated/prisma/` — generated client
- `dev.db` — файл базы данных

## 🔗 Связи
- **Используется в:** все модули
- **См. также:** [Customer Hub](customer-hub.md), [Shipping Labels](shipping-labels.md), [Account Health](account-health.md), [Frozen Analytics](frozen-analytics.md), [Adjustments Monitor](adjustments-monitor.md)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
- 2026-05-17: Bundle Factory Phase 0 завершён — добавлено 14 новых моделей в спеку.
- 2026-05-17: Bundle Factory Phase 1 реализован в ветке `feat/bundle-factory-phase-1` — миграция применена (sqlite + Turso script), 5 seed-скриптов, 10 API endpoints, 7 UI pages, sidebar entry.
