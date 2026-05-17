# Bundle Factory — Compliance Gate v1.0

> **Created:** 2026-05-17 (после блокировки Retailer Distributor аккаунта)
> **Status:** P0 — критический модуль, реализация перед Phase 2.1
> **Strategy:** No-LOA (без писем-разрешений от брендов). Compliant gift sets через Amazon Gift Basket Exception.
> **Purpose:** Защитный механизм между AI-генерацией листингов и публикацией в Amazon. Гарантирует что мы не повторим pattern блокировки 2026-05-17.

---

## 🎯 Контекст и стратегия

### Что произошло 2026-05-17

Amazon заблокировал Retailer Distributor аккаунт за **Trademark Logo Misuse** на 5 ASINs:

| ASIN | Brand violation | Title pattern |
|---|---|---|
| B0FRG1Y6SN | Goya | Salutem Vita – Baked Ripe Plantains, Sweet and Ready-to-Eat, Gift Set, 11 oz – Pack of 5 |
| B0FLWN3KZ9 | El Monterey | Salutem Vita – Burritos Variety Pack, Classic Mexican Flavors, 32 oz, 8 count, Gift Set – Pack of 3 |
| B0FNKR2P3Y | Ore-Ida | Salutem Vita – Gluten-Free Extra Crispy Tater Tots, Seasoned Shredded Potatoes, Gift Set, 28 oz – Pack of 6 |
| B0FJQK4S45 | Oh Snap! | Salutem Vita – Dill Pickle Snacking Cuts, Spicy Pickle Bites, Sweet Pickle Bites, 3.25 oz Gift Set – Pack of 3 |
| B0FBML98G3 | Kraft | Salutem Vita – Spongebob Shapes Mac & Cheese Microwavable Cups, 4ct Gift Set – Pack of 6 |

**Каузальный паттерн:** `[Own Brand] – [Foreign Brand Product] Gift Set` — implies endorsement / co-branding без trademark authorization.

### Наша стратегия (без LOA)

Vladimir подтвердил 2026-05-17:
- ❌ У нас нет писем-разрешений (LOA) от каких-либо производителей
- ❌ И не будет в обозримом будущем (маленькому seller-у не дадут)
- ✅ Используем **Amazon Gift Basket Exception** (browse node 12011207011 — Food Assortments & Variety Gifts)
- ✅ Позиционируемся как **curator/assembler**, а не как producer
- ✅ Прецеденты: Hickory Farms, Harry & David, Wine.com, Mouth.com — все работают так

### Принципы

1. **Generic title** — ноль foreign brands в названии (см. `title-policy.md` 🚨 HARD RULE)
2. **No third-party logos in main image** — AI Vision проверяет перед публикацией
3. **Mandatory disclaimer** в bullets и description — мы собираем, не производим
4. **Only Gift Basket Exception category** для multi-brand bundles (node 12011207011 или sub-nodes)
5. **Permanent blocklist** — 5 ASINs из incident + их brand combinations не воспроизводятся

---

## 🛡️ Архитектура: 2-level decision

Compliance Gate выдаёт одно из двух решений:

| Decision | Meaning | Action |
|---|---|---|
| **CAN_PUBLISH** | Все hard rules passed | Bundle Factory pipeline продолжает к публикации |
| **BLOCKED** | Хотя бы одно hard rule failed | Pipeline останавливается, AI получает feedback, regenerates с corrections |

**Нет среднего уровня.** Либо compliant, либо нет. Это упрощение от GPT-spec где было 4 уровня (Low/Medium/High/Blocked) — упрощено потому что без LOA medium/high всё равно block-ятся.

---

## 📋 Hard rules (must ALL pass для CAN_PUBLISH)

### Rule 1: Title — ноль foreign brands

См. `title-policy.md` Section 6 (HARD BLOCK).

Implementation:
```typescript
const result = validateTitleForCompliance(draft.title, draft.brand);
if (result.blocked) return { decision: 'BLOCKED', reason: 'title_foreign_brand' };
```

### Rule 2: Brand field accuracy

- `brand` field в Amazon listing должен совпадать с одним из:
  - `Salutem Vita` (Brand Registry на Salutem Solutions аккаунте)
  - `Starfit` (Brand Registry на Sirius International аккаунте)
  - Generic (для select cases — но НЕ для bundles)
- Никогда не использовать foreign brand в brand field

Implementation:
```typescript
const ALLOWED_BRANDS = ['Salutem Vita', 'Starfit', 'Generic'];
if (!ALLOWED_BRANDS.includes(draft.brand)) return { decision: 'BLOCKED', reason: 'brand_not_allowed' };
```

### Rule 3: Mandatory disclaimer в bullets

Один из bullets обязан содержать **disclaimer phrase** который implements curator positioning:

```typescript
const REQUIRED_DISCLAIMER_PATTERNS = [
  /salutem solutions llc.{0,100}curates.{0,100}assembles/i,
  /curated.{0,100}assembled by salutem/i,
  /assembled by salutem solutions/i,
];

const hasDisclaimer = REQUIRED_DISCLAIMER_PATTERNS.some(p => p.test(draft.bullets.join(' ')));
if (!hasDisclaimer) return { decision: 'BLOCKED', reason: 'missing_disclaimer_bullet' };
```

**Auto-injection by Bundle Factory:** Если AI generates bullets без disclaimer — Bundle Factory автоматически вставит последним пунктом:

> "🛡️ Salutem Solutions LLC curates and assembles this gift set. Individual products are made by their respective manufacturers and sold here as authentic retail packaging."

### Rule 4: Mandatory disclaimer в description

В HTML description обязательный финальный параграф:

```html
<p><strong>About this gift set:</strong> Salutem Vita is a brand of Salutem Solutions LLC. We curate and assemble gift sets from authentic retail products. All third-party brand names and packaging shown are the property of their respective owners. We make no claim of manufacturing, partnership, or endorsement.</p>
```

Implementation:
```typescript
const REQUIRED_DESCRIPTION_TAILS = [
  'curate and assemble gift sets',
  'Salutem Solutions LLC',
  'no claim of manufacturing, partnership, or endorsement',
];

const allPresent = REQUIRED_DESCRIPTION_TAILS.every(s => draft.description.includes(s));
if (!allPresent) return { decision: 'BLOCKED', reason: 'missing_disclaimer_description' };
```

**Auto-injection by Bundle Factory:** Bundle Factory ALWAYS append этот disclaimer в description, regardless of AI output.

### Rule 5: Browse node — только Gift Basket Exception для multi-brand

Если bundle содержит products from >1 manufacturer, browse_node ДОЛЖЕН быть один из:

```typescript
const GIFT_BASKET_EXCEPTION_NODES = [
  '12011207011', // Food Assortments & Variety Gifts (главный)
  '2255572011',  // Candy & Chocolate Gifts
  '2255573011',  // Cheese & Charcuterie Gifts
  '23900459011', // Coffee Gifts
  '23700435011', // Gourmet Tea Gifts
  '78380725011', // Advent Calendars
];

const isMultiBrand = countDistinctManufacturers(draft.bundle_components) > 1;
if (isMultiBrand && !GIFT_BASKET_EXCEPTION_NODES.includes(draft.browse_node)) {
  return { decision: 'BLOCKED', reason: 'multi_brand_wrong_category' };
}
```

### Rule 6: Main image — no foreign logos detected by AI Vision

Перед публикацией главная картинка прогоняется через Claude Vision API:

```typescript
async function detectForeignLogos(imageUrl: string, ownBrand: string): Promise<{
  has_foreign_logos: boolean;
  detected_logos: string[];
}> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'url', url: imageUrl } },
        { type: 'text', text: `
You are a compliance reviewer. Identify ALL brand logos visible in this product image.
Own brand "${ownBrand}" is OK.
List any OTHER brand logos that are clearly visible (e.g. Kraft, Goya, Lunchables, etc).
Respond in JSON: {"detected_logos": ["Brand1", "Brand2"], "has_foreign_logos": true/false}
        ` },
      ],
    }],
  });
  return JSON.parse(response.content[0].text);
}

const visionCheck = await detectForeignLogos(draft.main_image_url, draft.brand);
if (visionCheck.has_foreign_logos) {
  return { 
    decision: 'BLOCKED', 
    reason: 'main_image_foreign_logos',
    detected_logos: visionCheck.detected_logos,
  };
}
```

**Implementation note:** AI-generated main image (Phase 2.3 OpenAI gpt-image-1) использует prompt который **excludes brand logos** explicitly. Vision check — second line of defense.

### Rule 7: Permanent ASIN/brand blocklist

Те 5 заблокированных ASINs запоминаются навсегда:

```typescript
const PERMANENT_BLOCKLIST = [
  { brand: 'Goya', product_keywords: ['plantains', 'baked plantains', 'sweet plantains', 'ripe plantains'] },
  { brand: 'El Monterey', product_keywords: ['burritos', 'frozen burritos', 'mexican burritos'] },
  { brand: 'Ore-Ida', product_keywords: ['tater tots', 'crispy tater tots'] },
  { brand: 'Oh Snap!', product_keywords: ['dill pickle', 'pickle cuts', 'pickle bites'] },
  { brand: 'Kraft', product_keywords: ['spongebob mac & cheese', 'spongebob shapes', 'microwavable mac & cheese cups'] },
];

const isPermanentlyBlocked = checkAgainstBlocklist(draft);
if (isPermanentlyBlocked) {
  return { 
    decision: 'BLOCKED', 
    reason: 'permanent_blocklist',
    matched_incident: matchedAsin,
  };
}
```

### Rule 8: No promotional/subjective language

Уже existing rule (см. `title-policy.md` section 3). Дублируется здесь для completeness.

---

## 🗄️ Database schema additions (Prisma)

### Model: ComplianceCheck

Каждый прогон Compliance Gate создаёт запись:

```prisma
model ComplianceCheck {
  id                 String   @id @default(cuid())
  bundle_draft_id    String
  channel_sku_id     String?  // null если check на BundleDraft уровне
  
  decision           String   // 'CAN_PUBLISH' | 'BLOCKED'
  hard_rules_passed  String   // JSON array of rule IDs that passed
  hard_rules_failed  String   // JSON array of {rule_id, reason}
  
  detected_brands    String?  // JSON array foreign brands detected
  detected_logos     String?  // JSON array logos detected on image
  
  ai_vision_response String?  // raw Claude Vision response
  cost_cents         Int      // API cost для tracking
  
  created_at         DateTime @default(now())
  
  bundle_draft       BundleDraft  @relation(fields: [bundle_draft_id], references: [id])
  channel_sku        ChannelSKU?  @relation(fields: [channel_sku_id], references: [id])
  
  @@index([bundle_draft_id, created_at])
  @@index([decision])
}
```

### Model: BrandConflict (permanent blocklist)

Зафиксированные incidents для prevention:

```prisma
model BrandConflict {
  id                String    @id @default(cuid())
  asin              String?   // если incident привязан к specific ASIN
  account           String?   // 'AMAZON_RETAILER' etc.
  
  foreign_brand     String    // 'Kraft', 'Goya', etc.
  product_keywords  String    // JSON array of product description keywords
  
  incident_date     DateTime
  incident_type     String    // 'trademark_logo_misuse', 'ip_complaint', etc.
  amazon_action     String?   // 'asin_block', 'account_suspension', etc.
  
  notes             String?   // free-form context
  
  status            String    // 'active' | 'resolved' | 'archived'
  resolved_at       DateTime?
  
  created_at        DateTime  @default(now())
  
  @@index([foreign_brand])
  @@index([asin])
  @@index([status])
}
```

**Seeded with 5 incident ASINs** при первой миграции.

### Model: ComplianceAuditLog

Audit trail для всех compliance decisions:

```prisma
model ComplianceAuditLog {
  id                  String   @id @default(cuid())
  bundle_draft_id     String
  channel_sku_id      String?
  
  event_type          String   // 'gate_check' | 'manual_override' | 'pattern_detected' | 'auto_fix'
  event_details       String   // JSON
  
  actor               String   // 'system' | 'vladimir' | 'claude_code'
  decision            String?  // если event resulted в decision
  
  created_at          DateTime @default(now())
  
  @@index([bundle_draft_id, created_at])
  @@index([event_type])
}
```

### Updates to existing models

**BundleDraft** — add field:
```prisma
compliance_status   String   @default("PENDING")  // 'PENDING' | 'CAN_PUBLISH' | 'BLOCKED'
compliance_check_id String?  // последний ComplianceCheck
```

**ChannelSKU** — add field:
```prisma
compliance_status   String   @default("PENDING")
compliance_check_id String?
```

---

## 🔄 Integration с Bundle Factory pipeline

### Where Compliance Gate runs

```
Stage 1: Brief Input
    ↓
Stage 2: Research (Perplexity)
    ↓
Stage 2.5: Image Mirror (R2)
    ↓
Stage 3: Variation Matrix
    ↓
Stage 4: Content Generation (AI)
    ↓
═══════════════════════════════════════
    🛡️ COMPLIANCE GATE CHECK
═══════════════════════════════════════
    ↓
If BLOCKED → return to Stage 4 with feedback
    ↓ (loop max 3 times, then escalate to Vladimir manual review)
    ↓
Stage 5: Main Image Generation
    ↓
═══════════════════════════════════════
    🛡️ COMPLIANCE GATE CHECK (image vision)
═══════════════════════════════════════
    ↓
If BLOCKED → re-generate image with stronger constraints
    ↓ (loop max 2 times)
    ↓
Stage 6: Validation (existing — extends compliance check)
    ↓
Stage 7: Distribution
    ↓
═══════════════════════════════════════
    🛡️ FINAL COMPLIANCE GATE CHECK (defense-in-depth)
═══════════════════════════════════════
    ↓
If BLOCKED at this stage → log critical alert, block submission
    ↓
SP-API / Walmart API publish
```

### What happens when BLOCKED

1. `BundleDraft.compliance_status` = 'BLOCKED'
2. `ComplianceCheck` record created с reason
3. `ComplianceAuditLog` entry для audit trail
4. If at Stage 4 (content): re-prompt AI с specific feedback ("Title contains 'Kraft' — generate without brand reference")
5. If at Stage 5 (image): re-generate image с stronger constraints
6. If after 3 retries — escalate to Vladimir manual review queue
7. Notification к Telegram alerts

### Auto-fix attempts (before BLOCKED escalation)

**Title fix:** If foreign brand detected → AI receives feedback prompt and regenerates title using generic product description.

**Bullets fix:** If disclaimer missing → Bundle Factory auto-appends required disclaimer as last bullet (без AI re-generation).

**Description fix:** If disclaimer missing → Bundle Factory auto-appends disclaimer paragraph (без AI re-generation).

**Image fix:** If foreign logo detected → re-generate с prompt include "do not include any third-party brand logos, branded packaging, or text overlays from brands other than Salutem Vita".

**Category fix:** If multi-brand bundle в wrong category → suggest move к 12011207011 (Food Assortments & Variety Gifts).

---

## 🖥️ UI components (Phase 2.0 implementation)

### Compliance Dashboard

Route: `/bundle-factory/compliance`

Tabs:
1. **Recent Decisions** — last 50 ComplianceCheck records
2. **Blocked Drafts** — drafts с compliance_status='BLOCKED' awaiting manual review
3. **Brand Conflicts** — permanent blocklist + ability to add new incidents
4. **Audit Log** — full ComplianceAuditLog с filters

### Pre-submit Checklist Modal

Перед export к Amazon — модал с финальной checklist:

```
✓ Title contains no foreign brand names
✓ Brand field = Salutem Vita / Starfit
✓ Disclaimer present in bullets (auto-injected)
✓ Disclaimer present in description (auto-injected)
✓ Main image AI Vision check passed (no foreign logos detected)
✓ Browse node = Gift Basket Exception category
✓ ASIN/brand combination not in permanent blocklist

[All checks must be green to enable "Submit to Amazon" button]
```

---

## 🔌 Module structure (TypeScript)

```
src/lib/bundle-factory/compliance/
├── gate.ts                      ← main entry point: runComplianceGate(draft)
├── rules/
│   ├── title-foreign-brands.ts  ← Rule 1
│   ├── brand-field.ts           ← Rule 2
│   ├── disclaimer-bullets.ts    ← Rule 3 (with auto-injection)
│   ├── disclaimer-description.ts ← Rule 4 (with auto-injection)
│   ├── browse-node.ts           ← Rule 5
│   ├── image-vision-check.ts    ← Rule 6 (Claude Vision API)
│   ├── permanent-blocklist.ts   ← Rule 7
│   └── promotional-language.ts  ← Rule 8
├── auto-fix.ts                  ← attempt fixes before BLOCKED escalation
├── audit-log.ts                 ← logging helper
└── types.ts                     ← ComplianceDecision, RuleResult types
```

---

## 💰 Cost estimate

Per Bundle compliance check:
- Title/brand/disclaimer/category checks: $0 (local code)
- Image Vision check (Claude Sonnet 4.5): ~$0.01-0.02 per image (one call)
- Total per bundle: **~$0.01-0.02**

At 5000 bundles/mo: **$50-100/mo**. Включено в overall Bundle Factory budget.

---

## 🎯 Success criteria

Phase 2.0 (Compliance Gate) считается готовым когда:

1. ✅ Невозможно создать BundleDraft с foreign brand в title под Salutem Vita / Starfit
2. ✅ Disclaimer автоматически inject-ится в bullets и description (без manual intervention)
3. ✅ AI Vision проверяет main image и блокирует foreign logos detected
4. ✅ Multi-brand bundle вне Gift Basket Exception category — заблокирован
5. ✅ 5 permanent blocklisted ASINs не могут быть воссозданы даже под другим angle
6. ✅ Audit log записывает все decisions с reasons
7. ✅ Stage 7 (Distribution) физически не может публиковать BundleDraft с compliance_status != 'CAN_PUBLISH'
8. ✅ Telegram alerts on BLOCKED events with reason

---

## 📚 Связанные документы

- `BUNDLE_FACTORY_LISTING_AUDIT_TOOL_v1_0.md` — Phase 2.0a Audit Tool (для existing listings)
- `CLAUDE_CODE_PROMPT_BUNDLE_FACTORY_PHASE_2_0a_AUDIT.md` — implementation prompt for Audit Tool
- `marketplace-rules/amazon/title-policy.md` — Rule 1 reference (foreign brands hard block)
- `marketplace-rules/amazon/gift-set-policy.md` — Gift Basket Exception strategy
- `marketplace-rules/amazon/prohibited-keywords.md` — consolidated foreign brand blocklist
- `marketplace-rules/amazon/image-requirements.md` — Rule 6 reference (image compliance)
- `BUNDLE_FACTORY_PHASE_2_MASTER_PLAN.md` — overall phase structure

---

## 📅 Implementation timeline

| Phase | Time | Description |
|---|---|---|
| **Phase 2.0a Audit Tool** | 6-8h Claude Code | Сканер существующих листингов + bulk remediation |
| **Phase 2.0 Compliance Gate** | 6-8h Claude Code | Защитный механизм для новых листингов |
| Phase 2.1 → 2.5 | как раньше | Полный pipeline |

**Rationale: Phase 2.0a first.** Existing 1028+ Salutem Vita листингов могут содержать ещё опасные patterns. Превентивная чистка важнее чем создание новых compliant листингов.

---

**Maintained by:** Vladimir + Claude · **Created:** 2026-05-17 · **Last reviewed:** 2026-05-17
