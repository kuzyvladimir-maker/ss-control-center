# MARKETPLACE RULES KB

> **Purpose:** Knowledge base правил каждого marketplace для Bundle Factory pipeline
> **Used by:** Stage 4 (Content Generation) и Stage 6 (Validation)
> **Status:** Phase 0 in progress
> **Last reviewed:** 2026-05-17

---

## 🎯 Зачем эта KB существует

В Bundle Factory pipeline AI-агент генерирует листинги под правила каждого marketplace. Если правила не знать — AI генерит контент, который marketplace отклонит на этапе processing report. Чтобы избежать reactive fix-loop, мы **front-load** все правила в KB и передаём их AI в system prompt при каждой генерации.

KB — single source of truth. Если правило где-то в коде / прошёлся в Slack-чате / запомнил Дима — это не считается. Только то, что записано здесь.

---

## 📁 Структура

```
docs/marketplace-rules/
├── README.md                          (этот файл)
├── amazon/
│   ├── gift-set-policy.md             ⭐ Фундамент: Oct 2024 update + Gift Basket Exception
│   ├── bundle-policy.md               Общая Product Bundling Policy
│   ├── title-policy.md                Long-form title rules
│   ├── bullet-points-policy.md        5 bullets pattern + restrictions
│   ├── description-policy.md          HTML, A+ Content access, length limits
│   ├── image-requirements.md          1000x1000, white bg, copyright
│   ├── browse-nodes-grocery.md        ⭐ Numeric IDs для Food Assortments & Variety Gifts
│   ├── category-frozen-grocery.md     (TBD) storage_temp attribute, allergen
│   ├── category-refrigerated.md       (TBD)
│   ├── category-shelf-stable.md       (TBD)
│   ├── category-pet-food.md           (TBD)
│   ├── gtin-exemption-process.md      ⭐ Как Vladimir подаёт application
│   ├── restricted-products.md         (TBD) ASIN-level restrictions
│   ├── compliance-grocery.md          (TBD) FDA, allergen handling
│   ├── brand-registry-benefits.md     (TBD) A+, Brand Story, Sponsored Brand
│   └── fee-schedule.md                (TBD) Referral + variable fees per category
├── walmart/
│   ├── title-policy.md                (TBD)
│   ├── multipack-policy.md            (TBD)
│   ├── images.md                      (TBD)
│   ├── category-grocery.md            (TBD)
│   ├── prohibited-items.md            (TBD)
│   ├── frozen-restrictions.md         (TBD) ⭐ Почему у Vladimir нет доступа
│   └── fee-schedule.md                (TBD)
├── ebay/
│   ├── basics.md                      (TBD)
│   └── fee-schedule.md                (TBD)
└── tiktok-shop/
    ├── basics.md                      (TBD)
    └── approval-process.md            (TBD) ~2-3 месяца на approval
```

⭐ = критически важно для MVP.

---

## 📐 Формат каждого файла KB

Чтобы быть consumable AI-агентом, каждый файл следует строгой структуре:

```markdown
# {Заголовок}

> **Source:** {URL официальной документации Amazon/Walmart/...}
> **Last verified:** YYYY-MM-DD
> **Applies to:** {channel} / {category if specific}
> **Priority:** P0 / P1 / P2 (P0 = hard requirement, нарушение = listing rejection)

## TL;DR
{Краткое summary правила в 2-3 предложениях. Это то, что AI-агент видит первым.}

## Hard rules (must)
- {Конкретное правило с примером}
- {ещё правило}

## Soft rules (should)
- {Best practice}

## Examples
### ✅ Correct
{Пример правильного контента}

### ❌ Incorrect
{Пример неправильного контента и почему}

## Edge cases
{Известные edge cases и как их обрабатывать}

## References
- Official: {URL}
- Community: {URL}
```

---

## 🔄 Quarterly re-validation

Правила marketplaces меняются. Каждый квартал (Mar, Jun, Sep, Dec) — re-check всех файлов KB:

1. Запустить Claude Code research-агент с командой "verify {file} against current Amazon/Walmart documentation"
2. Update `Last verified` дату
3. Если изменения — обновить content + commit

---

## 🤖 Как KB используется в pipeline

В Stage 4 (Content Generation) Bundle Factory собирает context для AI:

```typescript
function buildKBContext(channel: SalesChannel, category: ProductCategory): string {
  const files = [
    `marketplace-rules/${channelKey(channel)}/title-policy.md`,
    `marketplace-rules/${channelKey(channel)}/bullet-points-policy.md`,
    `marketplace-rules/${channelKey(channel)}/description-policy.md`,
    `marketplace-rules/${channelKey(channel)}/image-requirements.md`,
    `marketplace-rules/${channelKey(channel)}/category-${categoryKey(category)}.md`,
  ];
  if (channel.startsWith('AMAZON')) {
    files.push('marketplace-rules/amazon/gift-set-policy.md');
    files.push('marketplace-rules/amazon/bundle-policy.md');
    files.push('marketplace-rules/amazon/browse-nodes-grocery.md');
  }
  return files.map(f => readFileSync(f, 'utf-8')).join('\n\n---\n\n');
}
```

AI получает это как system prompt + Brief как user message → возвращает структурированный JSON с title/bullets/description/attributes.

В Stage 6 (Validation) — те же файлы используются для compliance checks **до** отправки на marketplace.

---

## 🔗 Связи

- ⊃ Bundle Factory pipeline (Stage 4 + Stage 6 читают KB)
- ⊃ `MarketplaceRule` table (БД-кэш top-30 critical rules)
- ← Official documentation: Amazon Seller Central Help, Walmart Marketplace Seller Help, eBay Seller Center, TikTok Shop Seller University
- → AI generation prompts

---

**Maintained by:** Vladimir + Claude
**Started:** 2026-05-17
