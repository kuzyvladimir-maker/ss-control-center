# Bundle Factory — массовое создание gift sets

> **Source of truth:** [`docs/BUNDLE_FACTORY_CONCEPT_v1_0.md`](../BUNDLE_FACTORY_CONCEPT_v1_0.md)
> **Status:** Concept finalized 2026-05-17, ready for Phase 0 (KB research)
> **Replaces:** Phase 2 placeholder "Product Listings"

---

## ⚡ Кратко

Bundle Factory — фабрика по массовому созданию gift set / multipack листингов для всех 9 marketplace-каналов Salutem Solutions (5 Amazon + Walmart + eBay + 2 TikTok). Заменяет ручной workflow Димы с Excel flat files на AI-конвейер: research → variation matrix → AI content + AI images → validation → distribution через API + flat file.

Цель: 1000+ новых ASIN в месяц без ручной работы, под двумя зарегистрированными брендами (Salutem Vita / Starfit).

## 🧠 Семь стадий pipeline

1. **Brief** — пользователь вводит brand, # listings, price range, bundle types
2. **Research** — Perplexity + scraping (walmart.com, target.com, brand-sites) → product database
3. **Variation Matrix** — генератор bundle конфигураций (flavors × pack sizes × use cases)
4. **AI Content** — title, bullets, description, search terms по правилам Marketplace KB
5. **Image Generation** — main image AI-generated (с фирменной коробкой "GIFT SET N COUNT" + Salutem Solutions logo), 3-5 secondary из donor sources
6. **Validation & Approval** — compliance checks по правилам каналов, user approve
7. **Distribution** — Flat File export + API push на выбранные каналы

## 💎 Юридический фундамент

**Amazon Gift Basket Exception** (Product Bundling Policy от 14 октября 2024). Категория `Food Assortments & Variety Gifts` разрешает physical bundles with products from multiple brands если physically packaged for gifting. Vladimir восстановил аккаунты в ноябре 2024 → попал в правильный момент политики.

**Brand Registry:** Salutem Vita (Brand Registry на Salutem Solutions), Starfit (на Sirius International). Все 5 Amazon accounts — authorized sellers друг для друга. Заблокирует чужих продавцов на наших ASIN.

## 📦 Sourcing Foundation

- **Warehouse:** 1162 Kapp Dr, Clearwater, FL 33765 (27.9775°N, -82.7512°W)
- **Sourcing radius:** 10 миль → 28 магазинов
- **Priority order:** Walmart (5: 3 Supercenter + 2 Neighborhood Market) → BJ's (1) → Target (3) → Publix (9) → Sam's Club (1) → Costco (1) → ALDI (2) → specialty (Whole Foods, Trader Joe's, Fresh Market, Winn-Dixie)
- В радиусе **2 миль** от склада: Walmart Supercenter US-19 (1.2 mi), два Walmart NM, два ALDI, Sam's Club, Costco, Target, Publix — все основные source’ы в одном кластере
- **Sticky Products** thesis: топовые brand-products в стоке месяцами → one-shot research + pre-publication re-check
- **JIT inventory** — не держим склад; order → 2 days handling → sourcing → packing → shipping

## 🏷️ Brand strategy

| Бренд | Brand Registry | Account | Категории |
|---|---|---|---|
| **Salutem Vita** | ✅ | Salutem Solutions | Frozen, Refrigerated, Shelf-stable, Pet Food |
| **Starfit** | ✅ | Sirius International | TBD (видимо grocery) |

Текущий каталог Salutem Solutions: ~1255 Salutem Vita listings, ~1028 помечены "Gift Set".

## 📊 Master Bundle ↔ Channel SKU

```
MasterBundle (рецепт + cost + master images)
   ├── ChannelSKU [amazon_salutem]  (свой SKU/UPC, adapted title)
   ├── ChannelSKU [amazon_personal] (свой SKU/UPC, adapted title)
   ├── ChannelSKU [amazon_amzcom]   (свой SKU/UPC, adapted title)
   ├── ChannelSKU [amazon_sirius]   (свой SKU/UPC, adapted title)  ← Starfit brand
   ├── ChannelSKU [walmart_1]       (свой SKU/UPC, adapted title)
   └── (eBay, TikTok — Phase 2+)
```

Pricing: per-marketplace (Amazon одна цена на все 5 аккаунтов; Walmart может отличаться).

## 🔌 Tech stack

**Уже есть:** Amazon SP-API (4/5), Walmart Marketplace API (1), Anthropic API, Veeqo, Higgsfield, Telegram, Brand Registry

**Добавить:** OpenAI API ($100/мес), Perplexity API ($30), Cloudflare R2 ($10), web scraping ($75)

Total OpEx: ~$215/мес → ~$0.22 per bundle на 1000/мес.

## 🚧 Фазирование

- **Phase 0** — Marketplace Rules KB (research через Claude Code, 30-50 markdown файлов)
- **Phase 1** — Data model + Prisma migrations + UI скелет
- **Phase 2-7** — реализация 7 стадий pipeline по одной
- **Phase 8-11** — distribution channels + error feedback loop
- **Phase 12+** — eBay, TikTok, video generation

MVP boundary = Phase 0-7: рабочий builder с flat file export.

## 🔗 Связи

- ⊂ [Marketplace Rules KB](../marketplace-rules/README.md) — knowledge base правил каждого канала
- → [Procurement Module](procurement-module.md) — новый bundle создаёт default SKUStorePriority
- → [Dashboard](dashboard.md) — Bundle Factory analytics card (Phase 2)
- ⇔ [Customer Hub](customer-hub.md) — Order ID coupling после первого ордера
- ⇔ [Frozen Analytics](frozen-analytics.md) — новый Frozen bundle входит в risk profiling
- ← [Amazon SP-API](amazon-sp-api.md), [Walmart API](walmart-api.md), [Claude AI](claude-ai.md), [Telegram](telegram-notifications.md)

## 📚 Связанные документы

- [`BUNDLE_FACTORY_CONCEPT_v1_0.md`](../BUNDLE_FACTORY_CONCEPT_v1_0.md) — полный концепт (source of truth)
- [`BUNDLE_FACTORY_SOURCING_MAP.md`](../BUNDLE_FACTORY_SOURCING_MAP.md) — карта 32 магазинов с distances/часами/координатами (28 в radius 10 миль) — 2026-05-17
- [`BUNDLE_FACTORY_DATA_MODEL.md`](../BUNDLE_FACTORY_DATA_MODEL.md) — Prisma schema, 14 моделей, pre-seed data — 2026-05-17
- `CLAUDE_CODE_PROMPT_BUNDLE_FACTORY_KB_PHASE_0.md` — промпт для сборки KB (TBD)
- `CLAUDE_CODE_PROMPT_BUNDLE_FACTORY_PHASE_1.md` — первый executable промпт (TBD)

---
**Последнее обновление:** 2026-05-17 — концепт финализирован + Sourcing Map (28 магазинов) + Data Model (14 Prisma моделей).
