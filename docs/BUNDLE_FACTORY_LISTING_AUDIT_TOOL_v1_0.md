# Bundle Factory — Listing Audit Tool v1.0 (Phase 2.0a)

> **Created:** 2026-05-17
> **Status:** P0 — критически срочно (превентивная чистка существующих листингов)
> **Purpose:** Сканировать все active listings × 5 Amazon accounts, обнаруживать risky patterns, переделывать в compliant версии bulk через SP-API
> **Why first:** Существующие 1028+ Salutem Vita listings могут содержать ещё рискованные patterns. Amazon может найти и заблокировать другие аккаунты в любой момент. Превентивная чистка важнее новых листингов.

---

## 🎯 Контекст

После блокировки Retailer Distributor аккаунта 2026-05-17 (5 ASINs за Trademark Logo Misuse) Vladimir обоснованно беспокоится что **другие 4 Amazon accounts** могут содержать аналогично рискованные листинги:

- AMAZON_SALUTEM (Salutem Solutions — Brand Registry owner)
- AMAZON_PERSONAL (Vladimir Personal)
- AMAZON_AMZCOM (AMZ Commerce)
- AMAZON_SIRIUS (Sirius International)
- AMAZON_RETAILER (Retailer Distributor — currently blocked)

**Цель Audit Tool:** найти такие листинги ДО того как Amazon их найдёт, и переделать в compliant версии.

---

## 🔄 Workflow audit инструмента

```
1. Vladimir click "Run Audit" в UI
   ↓
2. SP-API: GET active listings × 5 accounts через GetListingsItems / ListingsItems API
   ↓
3. Для каждого листинга: download title, bullets, description, browse_node, main_image_url, brand
   ↓
4. Run compliance rules (те же что Phase 2.0 Compliance Gate):
   ├─ Title: foreign brand detection
   ├─ Brand field: matches accepted brand?
   ├─ Bullets/description: disclaimer present?
   ├─ Browse node: Gift Basket Exception?
   ├─ Main image: Claude Vision logo detection
   └─ Permanent blocklist: match against 5 incident patterns?
   ↓
5. Compute risk score (0-100) per listing
   ↓
6. UI shows ranked list по risk:
   - 🚨 BLOCKED (score 80-100) — соответствуют incident pattern, ждут немедленного действия
   - ⚠️ WARNING (score 50-79) — partial match, recommended remediation
   - 🟡 LOW_RISK (score 20-49) — minor issues (missing disclaimer)
   - ✅ COMPLIANT (score 0-19) — no action needed
   ↓
7. Vladimir batch-select risky listings → click "Regenerate Compliant Versions"
   ↓
8. Bundle Factory pipeline:
   - For each selected: extract product description (без foreign brand)
   - Generate compliant title через AI
   - Auto-inject disclaimers в bullets и description
   - Re-generate main image without foreign logos
   - Validate через Compliance Gate
   ↓
9. SP-API: PATCH listing — update title, bullets, description, image на compliant версии
   ↓
10. Audit log per listing: original vs new + reasons + timestamp
```

---

## 📊 Risk scoring algorithm

```typescript
function calculateRiskScore(listing: AmazonListing): {
  score: number;       // 0-100
  category: 'BLOCKED' | 'WARNING' | 'LOW_RISK' | 'COMPLIANT';
  reasons: string[];
} {
  let score = 0;
  const reasons: string[] = [];

  // Permanent blocklist match (highest weight)
  if (matchesPermanentBlocklist(listing)) {
    score += 80;
    reasons.push('Matches permanent ASIN/brand blocklist pattern');
  }

  // Foreign brand в title под own brand
  const foreignBrandsInTitle = detectForeignBrandsInTitle(listing.title, listing.brand);
  if (foreignBrandsInTitle.length > 0) {
    score += 40 + (foreignBrandsInTitle.length * 10);
    reasons.push(`Foreign brands in title: ${foreignBrandsInTitle.join(', ')}`);
  }

  // Multi-brand bundle in wrong category
  if (isMultiBrandBundle(listing) && !isGiftBasketExceptionCategory(listing.browse_node)) {
    score += 30;
    reasons.push('Multi-brand bundle outside Gift Basket Exception category');
  }

  // Missing disclaimer
  if (!hasDisclaimer(listing.bullets, listing.description)) {
    score += 15;
    reasons.push('Missing curator/assembler disclaimer');
  }

  // Image has foreign logos (Claude Vision check)
  if (listing.vision_check?.has_foreign_logos) {
    score += 35;
    reasons.push(`Foreign logos in main image: ${listing.vision_check.detected_logos.join(', ')}`);
  }

  // Cap at 100
  score = Math.min(score, 100);

  // Categorize
  let category: RiskCategory;
  if (score >= 80) category = 'BLOCKED';
  else if (score >= 50) category = 'WARNING';
  else if (score >= 20) category = 'LOW_RISK';
  else category = 'COMPLIANT';

  return { score, category, reasons };
}
```

---

## 🗄️ Database schema

### Model: ListingAuditScan

Каждый запуск audit — отдельный scan:

```prisma
model ListingAuditScan {
  id              String   @id @default(cuid())
  initiated_by    String   // 'vladimir' | 'system_cron'
  
  status          String   // 'pending' | 'running' | 'completed' | 'failed'
  
  started_at      DateTime @default(now())
  completed_at    DateTime?
  
  accounts_scanned String   // JSON array: ['SALUTEM', 'PERSONAL', 'AMZCOM', 'SIRIUS', 'RETAILER']
  
  total_listings  Int      @default(0)
  blocked_count   Int      @default(0)
  warning_count   Int      @default(0)
  low_risk_count  Int      @default(0)
  compliant_count Int      @default(0)
  
  error_message   String?
  
  audit_results   ListingAuditResult[]
  
  @@index([initiated_by, started_at])
  @@index([status])
}
```

### Model: ListingAuditResult

Per-listing audit result:

```prisma
model ListingAuditResult {
  id              String   @id @default(cuid())
  scan_id         String
  
  asin            String
  sku             String?
  account         String   // 'SALUTEM' | 'PERSONAL' | etc.
  
  title           String   // snapshot
  brand           String
  browse_node     String?
  main_image_url  String?
  
  risk_score      Int      // 0-100
  risk_category   String   // 'BLOCKED' | 'WARNING' | 'LOW_RISK' | 'COMPLIANT'
  risk_reasons    String   // JSON array of strings
  
  detected_brands String?  // JSON array
  detected_logos  String?  // JSON array (from Vision check)
  
  remediation_status String  @default("PENDING")  // 'PENDING' | 'REGENERATING' | 'UPDATED' | 'SKIPPED' | 'FAILED'
  remediation_id  String?  // links to remediation task
  
  created_at      DateTime @default(now())
  
  scan            ListingAuditScan      @relation(fields: [scan_id], references: [id])
  remediation     ListingRemediation?   @relation(fields: [remediation_id], references: [id])
  
  @@index([scan_id, risk_category])
  @@index([asin])
  @@index([account, risk_category])
}
```

### Model: ListingRemediation

Tracking remediation работы:

```prisma
model ListingRemediation {
  id                 String   @id @default(cuid())
  audit_result_id    String   @unique
  
  status             String   // 'pending' | 'generating' | 'validated' | 'updating' | 'completed' | 'failed'
  
  original_title     String
  new_title          String?
  original_bullets   String   // JSON array
  new_bullets        String?  // JSON array
  original_description String
  new_description    String?
  original_image_url String?
  new_image_url      String?  // в R2 if regenerated
  
  ai_cost_cents      Int      @default(0)
  
  sp_api_response    String?  // JSON, SP-API patchListingsItem response
  sp_api_error       String?
  
  started_at         DateTime @default(now())
  completed_at       DateTime?
  
  audit_result       ListingAuditResult @relation(fields: [audit_result_id], references: [id])
  
  @@index([status])
}
```

---

## 🔌 SP-API integration

### Endpoints used

| Endpoint | Purpose |
|---|---|
| `GET /listings/2021-08-01/items/{sellerId}` | List all SKUs per account |
| `GET /listings/2021-08-01/items/{sellerId}/{sku}` | Get full listing data (title, bullets, etc.) |
| `PATCH /listings/2021-08-01/items/{sellerId}/{sku}` | Update listing с compliant version |

**Per-store credentials** (existing pattern):
```
AMAZON_SP_CLIENT_ID_STORE1 (Salutem)
AMAZON_SP_CLIENT_SECRET_STORE1
AMAZON_SP_REFRESH_TOKEN_STORE1
...same для STORE2-5
```

### Rate limits

SP-API Listings API rate limit: **5 req/sec** per store.

Strategy:
- Audit scan: parallel across 5 stores, sequential within store
- 1028 listings × 5 stores ≈ 5140 total reads
- At 5 req/sec × 5 stores = 25 req/sec aggregate → ~3.5 minutes для full scan
- Add 30-50% buffer для image downloads + Vision calls → **~5-7 minutes for full audit scan**

### Patch payload structure

Когда обновляем листинг — patch operation:

```json
PATCH /listings/2021-08-01/items/{sellerId}/{sku}
{
  "productType": "GROCERY",
  "patches": [
    {
      "op": "replace",
      "path": "/attributes/item_name",
      "value": [{"value": "Salutem Vita – Microwavable Mac & Cheese Cups Gift Set, Pack of 6", "marketplace_id": "ATVPDKIKX0DER"}]
    },
    {
      "op": "replace",
      "path": "/attributes/bullet_point",
      "value": [
        {"value": "🛡 ...", "marketplace_id": "ATVPDKIKX0DER"},
        ...
      ]
    },
    {
      "op": "replace",
      "path": "/attributes/product_description",
      "value": [{"value": "...with disclaimer...", "marketplace_id": "ATVPDKIKX0DER"}]
    },
    {
      "op": "replace",
      "path": "/attributes/main_product_image_locator",
      "value": [{"media_location": "https://images.salutemsolutions.info/main/new-image.jpg", "marketplace_id": "ATVPDKIKX0DER"}]
    }
  ]
}
```

---

## 🤖 Bundle Factory pipeline integration для remediation

Когда Vladimir clicks "Regenerate Compliant Version" для ASIN B0FRG1Y6SN (заблокированный Goya plantains):

```typescript
async function remediateListing(auditResult: ListingAuditResult): Promise<ListingRemediation> {
  // 1. Create remediation record
  const remediation = await prisma.listingRemediation.create({
    data: {
      audit_result_id: auditResult.id,
      status: 'generating',
      original_title: auditResult.title,
      original_bullets: auditResult.original_bullets,
      original_description: auditResult.original_description,
      original_image_url: auditResult.main_image_url,
    },
  });
  
  // 2. Extract product essence (без foreign brand)
  const productEssence = await extractProductEssence(auditResult); 
  // -> { core_product: "ripe plantains", size: "11 oz", count: 5, category: "frozen_grocery" }
  
  // 3. Re-generate compliant title via Claude
  const newTitle = await generateCompliantTitle({
    brand: 'Salutem Vita',
    productEssence,
    constraints: ['no_foreign_brands', 'gift_set_pattern', 'pack_count'],
  });
  
  // 4. Re-generate compliant bullets (auto-inject disclaimer)
  const newBullets = await generateCompliantBullets({...});
  
  // 5. Re-generate compliant description (auto-append disclaimer)
  const newDescription = await generateCompliantDescription({...});
  
  // 6. Re-generate main image (OpenAI gpt-image-1, no foreign logos)
  const newImageUrl = await regenerateMainImage({
    productEssence,
    constraints: ['no_third_party_logos', 'salutem_branded_box', 'white_background_1500x1500'],
  });
  
  // 7. Run Compliance Gate validation
  const gateCheck = await runComplianceGate({
    title: newTitle,
    bullets: newBullets,
    description: newDescription,
    main_image_url: newImageUrl,
    brand: 'Salutem Vita',
    browse_node: '12011207011', // Gift Basket Exception
  });
  
  if (gateCheck.decision !== 'CAN_PUBLISH') {
    // Compliance gate rejected даже remediated version — escalate to manual
    await markRemediationFailed(remediation.id, gateCheck);
    return remediation;
  }
  
  // 8. SP-API PATCH к Amazon
  const patchResponse = await spApiPatchListing({
    seller_id: getAccountSellerId(auditResult.account),
    sku: auditResult.sku,
    title: newTitle,
    bullets: newBullets,
    description: newDescription,
    main_image_url: newImageUrl,
  });
  
  // 9. Update remediation record
  await prisma.listingRemediation.update({
    where: { id: remediation.id },
    data: {
      status: 'completed',
      new_title: newTitle,
      new_bullets: JSON.stringify(newBullets),
      new_description: newDescription,
      new_image_url: newImageUrl,
      sp_api_response: JSON.stringify(patchResponse),
      completed_at: new Date(),
    },
  });
  
  // 10. Mark audit result as updated
  await prisma.listingAuditResult.update({
    where: { id: auditResult.id },
    data: { remediation_status: 'UPDATED' },
  });
  
  return remediation;
}
```

---

## 🖥️ UI design

### Main page: `/bundle-factory/audit`

**Header:**
- Button "Run Full Audit" (triggers scan across all 5 accounts)
- Last scan info: "Last audit: 2 hours ago — 1247 listings scanned, 23 BLOCKED, 67 WARNING"

**Risk summary cards (top of page):**
```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ 🚨 BLOCKED   │  │ ⚠️ WARNING   │  │ 🟡 LOW_RISK  │  │ ✅ COMPLIANT │
│      23      │  │      67      │  │     156      │  │     1001     │
│ Take action  │  │ Review soon  │  │ Minor issues │  │ All good     │
└──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
```

**Filterable listing table:**

| ✓ | ASIN | Account | Title | Risk | Reasons | Action |
|---|---|---|---|---|---|---|
| ☐ | B0FXXX | SALUTEM | Salutem Vita – Lunchables Pizza Lunch Kit... | 🚨 95 | Foreign brand "Lunchables" in title | [Regenerate] |
| ☐ | B0FYYY | AMZCOM | Salutem Vita – Hot Pockets Variety Pack... | 🚨 88 | Foreign brand "Hot Pockets" + multi-brand | [Regenerate] |
| ☐ | B0FZZZ | PERSONAL | Salutem Vita – Frozen Pizza Gift Set Pack of 12 | ✅ 5 | None | — |

**Bulk actions:**
- "Select all BLOCKED" / "Select all WARNING"
- "Regenerate selected" — triggers remediation pipeline
- "Skip selected" — mark as reviewed, no action
- "Delete selected from Amazon" — для cases when remediation impossible

### Listing detail modal

Click on listing → modal с:
- Original vs. proposed new version side-by-side
- Diff highlighting
- AI Vision result для original image (detected logos)
- Risk score breakdown
- "Approve & Update" / "Edit Proposal" / "Skip" buttons

---

## 💰 Cost estimate

**Audit scan (one full run):**
- SP-API calls: $0 (rate limited but free)
- Claude Vision на каждой картинке: ~$0.01-0.02 × 1028 = **$10-20** per scan

**Remediation (per listing):**
- AI content regeneration: ~$0.05-0.10
- AI image regeneration: ~$0.08-0.17
- SP-API patch: $0
- Total: **~$0.13-0.27 per listing**

**Realistic Phase 2.0a первый запуск:**
- 1 full audit scan: $10-20
- Assume 50-100 listings need remediation: $7-27
- **Total: ~$20-50 для первой очистки**

После first run — monthly audits ~$10-20/mo.

---

## 🚀 Implementation phases (sub-stages для Claude Code)

### Phase 2.0a Step 1: Foundation (2h)
- Prisma models: ListingAuditScan, ListingAuditResult, ListingRemediation
- Migration
- Seed initial BrandConflict entries для 5 incident ASINs

### Phase 2.0a Step 2: SP-API listings scanner (2h)
- Module `src/lib/bundle-factory/audit/scanner.ts`
- Implements GET /listings/2021-08-01/items/{sellerId} pagination
- Stores raw data в ListingAuditResult

### Phase 2.0a Step 3: Risk scoring engine (2h)
- Module `src/lib/bundle-factory/audit/risk-scorer.ts`
- Implements algorithm above
- Integrates с Claude Vision API для image checks (reuses code из Compliance Gate Rule 6)

### Phase 2.0a Step 4: Remediation pipeline (2h)
- Module `src/lib/bundle-factory/audit/remediation.ts`
- Re-uses Bundle Factory Stage 4 (content) + Stage 5 (image) pipelines
- SP-API patch implementation

### Phase 2.0a Step 5: UI pages (1-2h)
- `/bundle-factory/audit` main page
- Listing detail modal
- Run audit button + progress tracker

**Total: ~9-10h Claude Code work** (немного больше чем estimated 6-8h в master plan).

---

## ⚠️ Operational considerations

### Order of audits

Recommend audit order:
1. **AMAZON_RETAILER first** — blocked account, fix listings перед reactivation attempt
2. **AMAZON_SALUTEM second** — Brand Registry holder, highest priority для compliance
3. **AMAZON_AMZCOM, AMAZON_PERSONAL, AMAZON_SIRIUS** — все одновременно (lower risk)

### Backup before patching

**Critical:** Перед PATCH к Amazon — обязательно сохранить **полный snapshot** оригинального листинга в ListingAuditResult.original_*. Это позволяет rollback если что-то пойдёт wrong.

### Rate limiting

SP-API patch operations: **2 req/sec** per store. Если remediating 100 listings — это ~50 секунд на один account, или ~50 минут sequential для 5 accounts если каждый имеет 100 patches.

### Manual review escalation

Some listings могут быть legitimately complex (например, sourcing проблемы где невозможно generate compliant version). Audit Tool должен have escalation path:
- "Mark for manual review" — Vladimir gets Telegram notification
- "Schedule deletion" — listing будет deleted через SP-API delete operation

---

## 📚 Связанные документы

- `BUNDLE_FACTORY_COMPLIANCE_GATE_v1_0.md` — Phase 2.0 master document (compliance gate для new listings)
- `BUNDLE_FACTORY_PHASE_2_MASTER_PLAN.md` — overall phase structure
- `marketplace-rules/amazon/title-policy.md` — Rule 1 reference
- `marketplace-rules/amazon/gift-set-policy.md` — strategy reference
- `wiki/amazon-sp-api.md` — SP-API integration details

---

**Maintained by:** Vladimir + Claude · **Created:** 2026-05-17 · **Last reviewed:** 2026-05-17
