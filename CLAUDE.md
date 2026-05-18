# CLAUDE.md — Salutem Solutions Control Center

## 🎯 О ПРОЕКТЕ

**SS Control Center** — веб-платформа для управления e-commerce бизнесом на маркетплейсах (Amazon, Walmart). Единый интерфейс для управления заказами, доставкой, клиентским сервисом, аналитикой и здоровьем аккаунтов.

**Владелец:** Владимир (не разработчик). Объясняй простыми словами. Код с комментариями.

---

## 🏗️ ТЕХНИЧЕСКИЙ СТЕК

```
Frontend:  Next.js 14+ (App Router) + React 18 + TypeScript
Styling:   Tailwind CSS + shadcn/ui components
Backend:   Next.js API Routes (app/api/)
Database:  SQLite (Prisma ORM)
AI:        Anthropic Claude API + OpenAI (fallback)
Auth:      Пока нет
```

---

## 🏪 АККАУНТЫ AMAZON (5 штук)

| # | Аккаунт | Email | Store Index | US Merchant Token | SP-API | Gmail API |
|---|---------|-------|-------------|-------------------|--------|-----------|
| 1 | Salutem Solutions | amazon@salutem.solutions | store1 | `A3A7A0RDFUSGBS` | ✅ | ❌ (нужен OAuth) |
| 2 | Vladimir Personal | kuzy.vladimir@gmail.com | store2 | TBD (no SP-API SELLER_ID yet) | ✅ | ✅ |
| 3 | AMZ Commerce | TBD | store3 | `A2ON382ZMCWPCT` | ✅ | ❌ |
| 4 | Sirius International | TBD | store4 | TBD (no SP-API app yet) | ❌ | ❌ |
| 5 | Retailer Distributor | TBD | store5 | `A1LCOF57VUVMI4` | ⚠️ US suspended 2026-05-17 | ❌ |

**US sellerIds (different from Brazilian/Mexican/etc).** Each marketplace has its own
sellerId per account — the values above are specifically for the US Amazon.com
marketplace (`ATVPDKIKX0DER`). Auto-discovered from the "Invoicing Shadow Marketplace"
entry returned by `/sellers/v1/marketplaceParticipations` — see
`scripts/diag-sellers-api.ts` for the probe and `src/lib/amazon-sp-api/sellers.ts`
(`getMerchantToken` + `NoUSMarketplaceError`) for the runtime resolution. Earlier
env values (`AAULAB33TILT6` for STORE1, `AHJ7LR056ZFXI` for STORE3) were sellerIds
for OTHER marketplaces these accounts also participate in (e.g. Brazilian); using
them with `marketplaceIds=ATVPDKIKX0DER` made every Listings API call return
400/404, which is why the first audit run produced zero results.

Walmart — 1 аккаунт (API ключ пока отсутствует).

## 📚 СПРАВОЧНЫЕ ДОКУМЕНТЫ

| Файл | Содержание | Статус |
|------|-----------|--------|
| `docs/CUSTOMER_HUB_ALGORITHM_v2.2.md` | Customer Hub: Messages, A-to-Z, CB, Feedback, Decision Engine, Guardrails, Walmart | **Актуальный** |
| `docs/AMAZON_NOTIFICATIONS_MAP.md` | Маппинг уведомлений Amazon → модули CC + Gmail queries | **Актуальный** |
| `docs/MASTER_PROMPT_v3.1.md` | Shipping Labels | **Актуальный** |
| `docs/FROZEN_ANALYTICS_v1.0.md` | Frozen delivery analytics | **Актуальный** |

## 📝 ПРАВИЛА ДОКУМЕНТИРОВАНИЯ

1. Каждый модуль имеет свой документ-алгоритм в папке docs/
2. При критических изменениях — новая версия файла (vX.Y.md)
3. Старые версии НЕ удалять
4. Документы сохраняются в /docs/ проекта И на iMac через filesystem MCP

## ✍️ СТИЛЬ КОНТЕНТА (BRAND VOICE — STRICT)

Это правило установлено владельцем 2026-05-19 и применяется ко **ВСЕМУ** контенту листингов на всех каналах (Amazon, Walmart), а также к любому AI-generated content в рамках проекта (Phase 2.x Bundle Factory, Customer Hub responses, marketing copy, и т.д.).

**ЗАПРЕЩЕНО в product listings (titles, bullets, descriptions, A+ content):**

- **Emojis** — никаких ✅ 🍽 🎁 💚 🧊 ⭐ 🔥 ⚡ и пр. Vladimir не фанат emoji, считает их непрофессиональными и не приносящими value. Они также триггерят Amazon PDP code 99300 ("false/promotional claims").
- **Promotional adjectives** — `ultimate`, `perfect`, `delightful`, `delicious`, `ideal`, `amazing`, `incredible`, `premium`, `exclusive`, `must-have`, `best`, `finest`, `exceptional`, `outstanding`, `magnificent`, `wonderful`, `fantastic`, `superior`, `top-quality`, `world-class`, `awesome`. Amazon explicitly forbids subjective claims, и Vladimir-овский brand voice — factual, не маркетинговый.
- **Manual bullet characters** (`•`, `●`, `►`, `▪`, `○`) — Amazon рендерит bullets автоматически, ручные маркеры избыточны.
- **HTML в product_description** для grocery/food — Amazon strict валидирует HTML для этих категорий. Plain text с paragraph breaks (`\n\n`) предпочтительнее.
- **Health/medical claims** без FDA approval — `cure`, `treat`, `prevent`, `boost`, `weight loss`, `detox`, `heal`. Все Salutem Vita / Starfit gift sets — это food bundles, не supplements.

**ОБЯЗАТЕЛЬНО в product listings:**

- Curator/assembler disclaimer в bullets + description (Option C defensive — см. `docs/CLAUDE_CODE_PROMPT_PHASE_2_6_1_DISCLAIMER_INJECTION.md`). Это explicit non-affiliation statement, требуется для Amazon Gift Basket Exception positioning.
- Plain factual text. Что внутри, сколько штук, какие размеры, как хранить, для чего использовать.
- Brand names mentioned только factually (e.g. "Includes 8 Oscar Mayer Bun Length Franks") — никогда в title под Salutem Vita / Starfit (см. `docs/marketplace-rules/amazon/title-policy.md`).

**ИСТОРИЯ:** Предыдущие AI tools (Dima + ChatGPT) генерировали emoji-heavy promotional content. Это причина 99300 violations на AMZCOM cohort. Phase 2.6.1 Smart Scrub удаляет этот legacy pattern programmatically. Phase 2.6.2 Claude rewrite (будущая) генерирует **новый** content уже в правильном стиле.

---

## ❌ ЧЕГО НИКОГДА НЕ ДЕЛАТЬ

- Не хардкодить API ключи
- Не угадывать тип товара (Frozen/Dry) — только по тегам Veeqo
- Не использовать SAFE-T для carrier delay
- Не спорить о безопасности еды с клиентом
- Не просить вернуть frozen товары (food safety)
- Не предлагать cancel для shipped orders
- **Не использовать emojis в product listings** (см. секцию выше)
- **Не использовать promo-adjectives в product listings** (см. секцию выше)
