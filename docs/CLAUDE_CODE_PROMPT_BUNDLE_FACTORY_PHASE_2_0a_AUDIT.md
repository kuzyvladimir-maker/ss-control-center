# Claude Code Prompt: Bundle Factory Phase 2.0a — Listing Audit Tool

> **Created:** 2026-05-17
> **Target:** Claude Code в VS Code (autonomous execution)
> **Estimated time:** 8-10 hours
> **Branch:** `feat/bundle-factory-phase-2.0a-audit`
> **Priority:** P0 — критически срочно после блокировки Retailer Distributor

---

## 🚨 Контекст (читать обязательно)

2026-05-17 Amazon заблокировал **Retailer Distributor аккаунт** за Trademark Logo Misuse на 5 ASINs (Goya, El Monterey, Ore-Ida, Oh Snap!, Kraft под брендом Salutem Vita). 

**Vladimir обоснованно беспокоится** что другие 4 active Amazon accounts (SALUTEM, PERSONAL, AMZCOM, SIRIUS) могут содержать аналогично рискованные listings которые Amazon найдёт next.

**Твоя задача — создать инструмент для:**
1. Сканировать все active listings × 5 accounts через Amazon SP-API
2. Обнаруживать risky patterns (foreign brand в title под Salutem Vita / Starfit)
3. Ранжировать по risk score
4. Bulk regenerate в compliant версии через Bundle Factory pipeline
5. Update через SP-API patch

---

## 📚 КРИТИЧЕСКИ ВАЖНЫЕ источники (читать в этом порядке)

1. **`docs/BUNDLE_FACTORY_LISTING_AUDIT_TOOL_v1_0.md`** — полная спецификация (ПЕРВОЕ что читать)
2. **`docs/BUNDLE_FACTORY_COMPLIANCE_GATE_v1_0.md`** — compliance rules (re-используются в audit)
3. **`docs/marketplace-rules/amazon/title-policy.md`** — Section 6: HARD RULE no foreign brands
4. **`docs/marketplace-rules/amazon/prohibited-keywords.md`** — FOREIGN_BRAND_NAMES blocklist
5. **`docs/marketplace-rules/amazon/gift-set-policy.md`** — Gift Basket Exception strategy
6. **`docs/wiki/amazon-sp-api.md`** — SP-API integration patterns (existing infrastructure)
7. **`docs/BUNDLE_FACTORY_DATA_MODEL.md`** — existing Prisma models (для context)

---

## 🎯 ТВОЯ ЗАДАЧА

Реализовать **Phase 2.0a Listing Audit Tool** в существующем Bundle Factory модуле. После этой фазы Vladimir сможет:

1. Войти на `/bundle-factory/audit` → click "Run Full Audit"
2. Через ~5-10 минут видит результаты: ranked list всех active listings по risk score
3. Бэйджи в UI показывают сколько BLOCKED / WARNING / LOW_RISK / COMPLIANT
4. Click на конкретный листинг → видит full risk analysis + AI suggestion для compliant version
5. Batch select высокорисковых → click "Regenerate" → Bundle Factory pipeline создаёт новые compliant версии → SP-API patch обновляет listings в Amazon

**Не входит в Phase 2.0a:**
- Compliance Gate для НОВЫХ листингов (это Phase 2.0, отдельный prompt)
- Stage 1-7 AI generation pipeline (это Phase 2.1+)

---

## 📋 STEP-BY-STEP IMPLEMENTATION

### STEP 0 — Setup и preparation

- [ ] **0.1** Pull latest main branch:
  ```bash
  cd ss-control-center
  git checkout main
  git pull origin main
  ```

- [ ] **0.2** Verify Phase 1 base is in place:
  ```bash
  ls prisma/migrations/ | grep bundle_factory_phase_1
  # должна быть migration 20260517000000_bundle_factory_phase_1_initial
  ```

- [ ] **0.3** Create новую feature branch:
  ```bash
  git checkout -b feat/bundle-factory-phase-2.0a-audit
  ```

- [ ] **0.4** Verify Anthropic API key in env:
  ```bash
  grep ANTHROPIC_API_KEY .env
  # должна быть установлена (используется для Claude Vision)
  ```

### STEP 1 — Prisma models

Добавить 3 модели в `prisma/schema.prisma` (после existing Bundle Factory models):

```prisma
// ============================================================================
// PHASE 2.0a — Listing Audit Tool
// ============================================================================

model ListingAuditScan {
  id                String   @id @default(cuid())
  initiated_by      String   // 'vladimir' | 'system_cron'
  
  status            String   @default("pending") // 'pending' | 'running' | 'completed' | 'failed'
  
  started_at        DateTime @default(now())
  completed_at      DateTime?
  
  accounts_scanned  String   // JSON array
  
  total_listings    Int      @default(0)
  blocked_count     Int      @default(0)
  warning_count     Int      @default(0)
  low_risk_count    Int      @default(0)
  compliant_count   Int      @default(0)
  
  error_message     String?
  
  audit_results     ListingAuditResult[]
  
  @@index([initiated_by, started_at])
  @@index([status])
}

model ListingAuditResult {
  id                  String   @id @default(cuid())
  scan_id             String
  
  asin                String
  sku                 String?
  account             String   // 'SALUTEM' | 'PERSONAL' | 'AMZCOM' | 'SIRIUS' | 'RETAILER'
  
  title               String
  brand               String
  browse_node         String?
  main_image_url      String?
  original_bullets    String   // JSON array
  original_description String  @default("")
  
  risk_score          Int      @default(0)
  risk_category       String   @default("COMPLIANT")  // 'BLOCKED' | 'WARNING' | 'LOW_RISK' | 'COMPLIANT'
  risk_reasons        String   @default("[]")  // JSON array
  
  detected_brands     String?  // JSON array
  detected_logos      String?  // JSON array (from Vision check)
  vision_cost_cents   Int      @default(0)
  
  remediation_status  String   @default("PENDING")  // 'PENDING' | 'REGENERATING' | 'UPDATED' | 'SKIPPED' | 'FAILED' | 'MANUAL_REVIEW'
  remediation_id      String?
  
  created_at          DateTime @default(now())
  updated_at          DateTime @updatedAt
  
  scan                ListingAuditScan      @relation(fields: [scan_id], references: [id])
  remediation         ListingRemediation?   @relation(fields: [remediation_id], references: [id])
  
  @@index([scan_id, risk_category])
  @@index([asin])
  @@index([account, risk_category])
  @@index([remediation_status])
}

model ListingRemediation {
  id                  String   @id @default(cuid())
  audit_result_id     String   @unique
  
  status              String   @default("pending") // 'pending' | 'generating' | 'validated' | 'updating' | 'completed' | 'failed'
  
  original_title      String
  new_title           String?
  original_bullets    String   // JSON array
  new_bullets         String?  // JSON array
  original_description String
  new_description     String?
  original_image_url  String?
  new_image_url       String?
  
  ai_cost_cents       Int      @default(0)
  
  sp_api_response     String?  // JSON
  sp_api_error        String?
  
  started_at          DateTime @default(now())
  completed_at        DateTime?
  
  audit_result        ListingAuditResult @relation(fields: [audit_result_id], references: [id])
  
  @@index([status])
}

model BrandConflict {
  id                String    @id @default(cuid())
  asin              String?
  account           String?
  
  foreign_brand     String
  product_keywords  String    // JSON array
  
  incident_date     DateTime
  incident_type     String    // 'trademark_logo_misuse' | 'ip_complaint'
  amazon_action     String?   // 'asin_block' | 'account_suspension'
  
  notes             String?
  
  status            String    @default("active")
  resolved_at       DateTime?
  
  created_at        DateTime  @default(now())
  
  @@index([foreign_brand])
  @@index([asin])
  @@index([status])
}
```

Run migration:
```bash
npx prisma migrate dev --name bundle_factory_phase_2_0a_audit
```

### STEP 2 — Seed permanent blocklist

Создать `prisma/seed/brand-conflicts.ts`:

```typescript
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const INCIDENT_DATE = new Date('2026-05-17');

const PERMANENT_BLOCKLIST = [
  {
    asin: 'B0FRG1Y6SN',
    account: 'RETAILER',
    foreign_brand: 'Goya',
    product_keywords: ['plantains', 'baked plantains', 'sweet plantains', 'ripe plantains'],
    incident_type: 'trademark_logo_misuse',
    amazon_action: 'asin_block',
    notes: 'Original title: "Salutem Vita – Baked Ripe Plantains, Sweet and Ready-to-Eat, Gift Set, 11 oz – Pack of 5". Brand violation: Goya.',
  },
  {
    asin: 'B0FLWN3KZ9',
    account: 'RETAILER',
    foreign_brand: 'El Monterey',
    product_keywords: ['burritos', 'frozen burritos', 'mexican burritos'],
    incident_type: 'trademark_logo_misuse',
    amazon_action: 'asin_block',
    notes: 'Original title: "Salutem Vita – Burritos Variety Pack, Classic Mexican Flavors in Every Bite, 32 oz, 8 count (Frozen), Gift Set – Pack of 3".',
  },
  {
    asin: 'B0FNKR2P3Y',
    account: 'RETAILER',
    foreign_brand: 'Ore-Ida',
    product_keywords: ['tater tots', 'crispy tater tots', 'shredded potatoes'],
    incident_type: 'trademark_logo_misuse',
    amazon_action: 'asin_block',
    notes: 'Original title: "Salutem Vita – Gluten-Free Extra Crispy Tater Tots, Seasoned Shredded Potatoes, Gift Set, 28 oz – Pack of 6".',
  },
  {
    asin: 'B0FJQK4S45',
    account: 'RETAILER',
    foreign_brand: 'Oh Snap!',
    product_keywords: ['dill pickle', 'pickle cuts', 'pickle bites', 'snacking pickles'],
    incident_type: 'trademark_logo_misuse',
    amazon_action: 'asin_block',
    notes: 'Original title: "Salutem Vita – Dill Pickle Snacking Cuts, Spicy Pickle Bites, Sweet Pickle Bites, 3.25 oz Gift Set – Pack of 3".',
  },
  {
    asin: 'B0FBML98G3',
    account: 'RETAILER',
    foreign_brand: 'Kraft',
    product_keywords: ['spongebob mac & cheese', 'spongebob shapes', 'microwavable mac & cheese cups'],
    incident_type: 'trademark_logo_misuse',
    amazon_action: 'asin_block',
    notes: 'Original title: "Salutem Vita – Spongebob Shapes Mac & Cheese Microwavable Cups, 4ct Gift Set – Pack of 6".',
  },
];

async function seedBrandConflicts() {
  for (const entry of PERMANENT_BLOCKLIST) {
    await prisma.brandConflict.upsert({
      where: { asin: entry.asin } as any, // ASIN unique among incident records
      create: {
        ...entry,
        product_keywords: JSON.stringify(entry.product_keywords),
        incident_date: INCIDENT_DATE,
      },
      update: {}, // do not modify existing
    });
  }
  console.log(`Seeded ${PERMANENT_BLOCKLIST.length} brand conflicts (permanent blocklist).`);
}

seedBrandConflicts()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
```

Run:
```bash
npx tsx prisma/seed/brand-conflicts.ts
```

### STEP 3 — SP-API Listings scanner

Создать `src/lib/bundle-factory/audit/scanner.ts`:

```typescript
import { prisma } from '@/lib/prisma';
import { getSpApiClient } from '@/lib/amazon-sp-api/client'; // existing infrastructure

interface AmazonListing {
  asin: string;
  sku: string;
  title: string;
  brand: string;
  browse_node?: string;
  main_image_url?: string;
  bullets: string[];
  description: string;
}

export async function scanAccount(account: string, scanId: string): Promise<AmazonListing[]> {
  const spClient = await getSpApiClient(account);
  const listings: AmazonListing[] = [];
  
  let nextToken: string | undefined;
  let pageCount = 0;
  const MAX_PAGES = 50; // safety limit
  
  do {
    const response = await spClient.listingsItems.getListingsItems({
      sellerId: process.env[`AMAZON_${account}_SELLER_ID`]!,
      marketplaceIds: ['ATVPDKIKX0DER'],
      pageSize: 20,
      pageToken: nextToken,
    });
    
    for (const item of response.items) {
      const detail = await spClient.listingsItems.getListingsItem({
        sellerId: process.env[`AMAZON_${account}_SELLER_ID`]!,
        sku: item.sku,
        marketplaceIds: ['ATVPDKIKX0DER'],
        includedData: ['attributes', 'summaries'],
      });
      
      listings.push({
        asin: detail.summaries?.[0]?.asin ?? '',
        sku: item.sku,
        title: detail.attributes?.item_name?.[0]?.value ?? '',
        brand: detail.attributes?.brand?.[0]?.value ?? '',
        browse_node: detail.attributes?.recommended_browse_nodes?.[0]?.value,
        main_image_url: detail.attributes?.main_product_image_locator?.[0]?.media_location,
        bullets: (detail.attributes?.bullet_point ?? []).map(b => b.value),
        description: detail.attributes?.product_description?.[0]?.value ?? '',
      });
      
      // Rate limit: 5 req/sec → wait 200ms per item
      await new Promise(r => setTimeout(r, 200));
    }
    
    nextToken = response.pagination?.nextToken;
    pageCount++;
  } while (nextToken && pageCount < MAX_PAGES);
  
  return listings;
}

export async function scanAllAccounts(scanId: string): Promise<{
  total: number;
  byAccount: Record<string, number>;
}> {
  const ACCOUNTS = ['SALUTEM', 'PERSONAL', 'AMZCOM', 'SIRIUS', 'RETAILER'];
  const byAccount: Record<string, number> = {};
  let total = 0;
  
  // Update scan status
  await prisma.listingAuditScan.update({
    where: { id: scanId },
    data: { status: 'running' },
  });
  
  // Parallel across accounts
  const results = await Promise.allSettled(
    ACCOUNTS.map(async (account) => {
      try {
        const listings = await scanAccount(account, scanId);
        byAccount[account] = listings.length;
        total += listings.length;
        
        // Bulk insert raw data
        for (const l of listings) {
          await prisma.listingAuditResult.create({
            data: {
              scan_id: scanId,
              asin: l.asin,
              sku: l.sku,
              account,
              title: l.title,
              brand: l.brand,
              browse_node: l.browse_node,
              main_image_url: l.main_image_url,
              original_bullets: JSON.stringify(l.bullets),
              original_description: l.description,
              risk_score: 0, // will be computed in next step
              risk_category: 'COMPLIANT',
              risk_reasons: '[]',
            },
          });
        }
      } catch (e) {
        console.error(`Failed scanning ${account}:`, e);
      }
    })
  );
  
  return { total, byAccount };
}
```

### STEP 4 — Risk scoring engine

Создать `src/lib/bundle-factory/audit/risk-scorer.ts`:

```typescript
import { prisma } from '@/lib/prisma';
import { FOREIGN_BRAND_NAMES } from './forbidden-brands'; // constants module
import { detectForeignLogosInImage } from './vision-check';

const OWN_BRANDS = ['Salutem Vita', 'Starfit'];
const GIFT_BASKET_EXCEPTION_NODES = [
  '12011207011', '2255572011', '2255573011',
  '23900459011', '23700435011', '78380725011',
];

interface RiskResult {
  score: number;
  category: 'BLOCKED' | 'WARNING' | 'LOW_RISK' | 'COMPLIANT';
  reasons: string[];
  detected_brands: string[];
  detected_logos?: string[];
}

export async function scoreAuditResult(resultId: string): Promise<RiskResult> {
  const result = await prisma.listingAuditResult.findUniqueOrThrow({
    where: { id: resultId },
  });
  
  let score = 0;
  const reasons: string[] = [];
  const detected_brands: string[] = [];
  let detected_logos: string[] = [];
  
  // Rule 1: Permanent blocklist match
  const blocklistMatch = await prisma.brandConflict.findFirst({
    where: { asin: result.asin, status: 'active' },
  });
  if (blocklistMatch) {
    score += 80;
    reasons.push(`Matches permanent blocklist: ${blocklistMatch.foreign_brand}`);
  }
  
  // Rule 2: Foreign brand в title под own brand
  const isOwnBrand = OWN_BRANDS.some(b => result.brand.toLowerCase().includes(b.toLowerCase()));
  if (isOwnBrand) {
    for (const fb of FOREIGN_BRAND_NAMES) {
      const escaped = fb.replace(/[.*+?^${}()|[\]\\]/g, c => `\\${c}`);
      const regex = new RegExp(`\\b${escaped}\\b`, 'i');
      if (regex.test(result.title)) {
        score += 40;
        detected_brands.push(fb);
        reasons.push(`Foreign brand "${fb}" in title under "${result.brand}"`);
      }
    }
  }
  
  // Rule 3: Missing disclaimer
  const bullets = JSON.parse(result.original_bullets) as string[];
  const allText = bullets.join(' ') + ' ' + result.original_description;
  const hasDisclaimer = /salutem solutions llc.{0,200}(curates|assembles|assembled)/i.test(allText)
    || /curated.{0,100}by salutem/i.test(allText)
    || /assembled by salutem solutions/i.test(allText);
  
  if (!hasDisclaimer) {
    score += 15;
    reasons.push('Missing curator/assembler disclaimer');
  }
  
  // Rule 4: Wrong category for multi-brand (we cannot detect multi-brand without parsing — flag as warning)
  if (detected_brands.length > 0 && result.browse_node && !GIFT_BASKET_EXCEPTION_NODES.includes(result.browse_node)) {
    score += 30;
    reasons.push(`Foreign brands present but category "${result.browse_node}" is not Gift Basket Exception`);
  }
  
  // Rule 5: Image vision check (only if not already at BLOCKED level — save API costs)
  if (score < 80 && result.main_image_url) {
    const visionResult = await detectForeignLogosInImage(result.main_image_url, result.brand);
    if (visionResult.has_foreign_logos) {
      score += 35;
      detected_logos = visionResult.detected_logos;
      reasons.push(`Foreign logos detected in main image: ${visionResult.detected_logos.join(', ')}`);
    }
  }
  
  // Cap at 100
  score = Math.min(score, 100);
  
  // Categorize
  let category: RiskResult['category'];
  if (score >= 80) category = 'BLOCKED';
  else if (score >= 50) category = 'WARNING';
  else if (score >= 20) category = 'LOW_RISK';
  else category = 'COMPLIANT';
  
  // Update database
  await prisma.listingAuditResult.update({
    where: { id: resultId },
    data: {
      risk_score: score,
      risk_category: category,
      risk_reasons: JSON.stringify(reasons),
      detected_brands: JSON.stringify(detected_brands),
      detected_logos: detected_logos.length > 0 ? JSON.stringify(detected_logos) : null,
    },
  });
  
  return { score, category, reasons, detected_brands, detected_logos };
}
```

### STEP 5 — AI Vision check module

Создать `src/lib/bundle-factory/audit/vision-check.ts`:

```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function detectForeignLogosInImage(
  imageUrl: string,
  ownBrand: string
): Promise<{ has_foreign_logos: boolean; detected_logos: string[]; cost_cents: number }> {
  if (!imageUrl) {
    return { has_foreign_logos: false, detected_logos: [], cost_cents: 0 };
  }
  
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { 
            type: 'image' as const, 
            source: { type: 'url' as const, url: imageUrl } 
          },
          { 
            type: 'text' as const, 
            text: `You are a compliance reviewer for Amazon product listings. Identify ALL brand logos and packaging visible in this image.

Own brand: "${ownBrand}" — OK to appear.

Identify any OTHER brands clearly visible (logos, branded packaging, brand text). Common brands to watch for:
- Kraft, Goya, Ore-Ida, El Monterey, Oh Snap!
- Lunchables, Uncrustables, Jimmy Dean, Hormel, Tyson
- Hershey's, Ghirardelli, Coca-Cola, Pepsi, Starbucks, etc.

Respond ONLY with valid JSON, no preamble:
{"detected_logos": ["Brand1", "Brand2"], "has_foreign_logos": true_or_false}` 
          },
        ],
      }],
    });
    
    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return { has_foreign_logos: false, detected_logos: [], cost_cents: 0 };
    }
    
    const parsed = JSON.parse(textBlock.text);
    
    // Cost estimate: Sonnet 4.5 image input ~$0.01-0.02 per call
    const cost_cents = Math.ceil(
      (response.usage.input_tokens * 0.003 + response.usage.output_tokens * 0.015) / 1000 * 100
    );
    
    return {
      has_foreign_logos: parsed.has_foreign_logos === true,
      detected_logos: Array.isArray(parsed.detected_logos) ? parsed.detected_logos : [],
      cost_cents,
    };
  } catch (e) {
    console.error('Vision check failed:', e);
    return { has_foreign_logos: false, detected_logos: [], cost_cents: 0 };
  }
}
```

### STEP 6 — Forbidden brands constants

Создать `src/lib/bundle-factory/audit/forbidden-brands.ts`:

```typescript
// Synchronized with marketplace-rules/amazon/prohibited-keywords.md FOREIGN_BRAND_NAMES
// Used by: risk-scorer, compliance gate, title validation

export const FOREIGN_BRAND_NAMES = [
  // Brands which led to 2026-05-17 blocking (permanent blocklist)
  'Goya', 'Kraft', 'Ore-Ida', 'Ore Ida', 'El Monterey', 'Oh Snap', 'Oh Snap!',
  
  // High-risk consumable brands (Vladimir's typical sourcing pool)
  'Lunchables', 'Uncrustables', 'Jimmy Dean', "Smucker's", "Eggland's",
  'Hormel', 'Tyson', 'Stouffer', 'Healthy Choice', 'Marie Callender',
  'Hot Pockets', 'Lean Cuisine', 'Eggo', 'Bagel Bites', 'TGI Friday',
  'Pillsbury', 'Quaker', 'Kellogg', 'Cheerios', 'Pop-Tarts', 'Frito-Lay',
  'Doritos', "Lay's", 'Pringles', 'Cheez-It', 'Goldfish', 'Cheetos',
  
  // Common gift basket components
  'Ghirardelli', 'Hershey', "Hershey's", 'Lindt', 'Godiva', 'Ferrero',
  'Coca-Cola', 'Coke', 'Pepsi', 'Sprite', 'Dr Pepper', 'Mountain Dew',
  'Starbucks', 'Folgers', 'Maxwell House', 'Nescafe', 'Keurig',
];
```

### STEP 7 — API endpoints

Создать новые API routes:

**`src/app/api/bundle-factory/audit/scan/route.ts`** — start new scan:

```typescript
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { scanAllAccounts } from '@/lib/bundle-factory/audit/scanner';
import { scoreAuditResult } from '@/lib/bundle-factory/audit/risk-scorer';

export const maxDuration = 300; // 5 minutes
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const initiated_by = body.initiated_by ?? 'vladimir';
  
  // Create scan record
  const scan = await prisma.listingAuditScan.create({
    data: {
      initiated_by,
      status: 'pending',
      accounts_scanned: JSON.stringify(['SALUTEM', 'PERSONAL', 'AMZCOM', 'SIRIUS', 'RETAILER']),
    },
  });
  
  // Run scan (async, returns immediately)
  (async () => {
    try {
      const { total, byAccount } = await scanAllAccounts(scan.id);
      
      // Score all listings
      const results = await prisma.listingAuditResult.findMany({
        where: { scan_id: scan.id },
      });
      
      const counts = { BLOCKED: 0, WARNING: 0, LOW_RISK: 0, COMPLIANT: 0 };
      for (const r of results) {
        const score = await scoreAuditResult(r.id);
        counts[score.category]++;
      }
      
      await prisma.listingAuditScan.update({
        where: { id: scan.id },
        data: {
          status: 'completed',
          completed_at: new Date(),
          total_listings: total,
          blocked_count: counts.BLOCKED,
          warning_count: counts.WARNING,
          low_risk_count: counts.LOW_RISK,
          compliant_count: counts.COMPLIANT,
        },
      });
    } catch (e) {
      await prisma.listingAuditScan.update({
        where: { id: scan.id },
        data: { 
          status: 'failed', 
          completed_at: new Date(),
          error_message: String(e),
        },
      });
    }
  })();
  
  return NextResponse.json({ scan_id: scan.id, status: 'pending' });
}
```

**`src/app/api/bundle-factory/audit/scans/route.ts`** — list scans:
**`src/app/api/bundle-factory/audit/results/route.ts`** — list results с filters
**`src/app/api/bundle-factory/audit/results/[id]/route.ts`** — single result detail
**`src/app/api/bundle-factory/audit/remediate/route.ts`** — start remediation

(Use existing API patterns from Phase 1 — `withErrorHandler`, `badRequest`, `intParam` from `api-utils.ts`.)

### STEP 8 — UI pages

**`src/app/bundle-factory/audit/page.tsx`** — main audit dashboard

Components needed:
- `<AuditSummaryCards />` — 4 risk category cards
- `<AuditResultsTable />` — filterable, sortable
- `<RunAuditButton />` — triggers POST /api/.../scan
- `<ScanProgress />` — polls scan status

**`src/app/bundle-factory/audit/[scanId]/page.tsx`** — scan detail
**`src/app/bundle-factory/audit/listing/[resultId]/page.tsx`** — individual listing audit с remediation preview

Use Salutem Design System tokens (`bg-surface`, `border-rule`, `text-ink`, etc.).

### STEP 9 — Sidebar integration

Update `src/components/bundle-factory/BundleFactorySubNav.tsx`:
- Add link "Audit" → `/bundle-factory/audit`
- Show badge с count of BLOCKED listings из latest scan

### STEP 10 — Remediation pipeline (sketch — может быть Phase 2.0a Step 2 если time runs out)

Создать `src/lib/bundle-factory/audit/remediation.ts`. Implementation guidance в `BUNDLE_FACTORY_LISTING_AUDIT_TOOL_v1_0.md` Section "Bundle Factory pipeline integration для remediation".

If time runs short:
- Implement basic skeleton — create ListingRemediation record, mark as 'manual_review'
- Vladimir manually handles remediation via Phase 2.1+ pipeline когда оно будет готово
- Full automation в Phase 2.0a Step 2 (later)

### STEP 11 — Production deploy

- [ ] Apply migration к Turso:
  ```bash
  npx tsx scripts/turso-migrate-bundle-factory-phase-2-0a-audit.mjs
  ```
  (Create this script following pattern of existing turso-migrate-bundle-factory-phase-1.mjs.)

- [ ] Seed brand conflicts в production:
  ```bash
  SEED_TARGET=turso npx tsx prisma/seed/brand-conflicts.ts
  ```

- [ ] Commit & push:
  ```bash
  git add .
  git commit -m "feat(bundle-factory): Phase 2.0a — Listing Audit Tool"
  git push origin feat/bundle-factory-phase-2.0a-audit
  ```

- [ ] Verify Vercel build passes

### STEP 12 — Wiki updates (mandatory per Vladimir's workflow)

- [ ] Create `docs/wiki/listing-audit-tool.md` — wiki page
- [ ] Update `docs/wiki/index.md` — add link
- [ ] Update `docs/wiki/CONNECTIONS.md` — add dependency connections

---

## ✅ Success criteria

Phase 2.0a считается готовым когда:

1. ✅ Vladimir может click "Run Full Audit" в UI
2. ✅ Scanner проходит через 5 accounts за ~5-10 минут
3. ✅ Все active listings получают risk score
4. ✅ UI показывает ranked list с filters
5. ✅ AI Vision проверяет main images на foreign logos
6. ✅ Permanent blocklist (5 incident ASINs) seeded в database
7. ✅ Build passes на Vercel
8. ✅ Migration applied к Turso production
9. ✅ Wiki pages created

**Not required for v1 (можно отложить):**
- Full automated remediation pipeline (Step 10) — может быть basic skeleton
- Bulk SP-API patch operations — manual для first iteration

---

## 🚨 Edge cases & gotchas

1. **SP-API rate limits:** Listings API = 5 req/sec per store. Use 200ms delay между requests.

2. **Image URLs могут быть expired или 404:** Vision check должна gracefully handle missing images.

3. **Large catalog scans:** 1000+ listings × 5 accounts может занять >5 минут. Use Vercel maxDuration=300. Если scan не завершается — split на chunks (per-account scans).

4. **Cost monitoring:** Vision check = $0.01-0.02 per image × 1000 listings = $10-20 per scan. Track `vision_cost_cents` per result.

5. **Retailer Distributor account:** заблокирован — SP-API calls могут return 403. Gracefully skip с warning, NOT fail entire scan.

6. **Vladimir может закрыть browser во время scan:** scan running в background. UI polls status. Make sure scan completes даже если no active client.

---

## 📚 Reference files (читать перед coding)

- `docs/BUNDLE_FACTORY_LISTING_AUDIT_TOOL_v1_0.md` ← главная спецификация
- `docs/BUNDLE_FACTORY_COMPLIANCE_GATE_v1_0.md` ← shared rules
- `docs/marketplace-rules/amazon/title-policy.md` ← Section 6 hard rule
- `docs/marketplace-rules/amazon/prohibited-keywords.md` ← FOREIGN_BRAND_NAMES
- `docs/PHASE_1_COMPLETION_REPORT.md` ← existing Bundle Factory structure
- `src/lib/bundle-factory/api-utils.ts` ← API helpers
- `src/lib/bundle-factory/enums.ts` ← Sales channels, categories
- `src/components/bundle-factory/BundleFactorySubNav.tsx` ← sidebar pattern

---

## 🎬 Execution start

When ready to begin:

```bash
cd ss-control-center
git checkout main
git pull
git checkout -b feat/bundle-factory-phase-2.0a-audit

# Verify Phase 1 in place
ls prisma/migrations/ | grep bundle_factory

# Verify Anthropic API key
echo $ANTHROPIC_API_KEY | head -c 20

# Read spec files first
cat ../docs/BUNDLE_FACTORY_LISTING_AUDIT_TOOL_v1_0.md
cat ../docs/BUNDLE_FACTORY_COMPLIANCE_GATE_v1_0.md
```

Then proceed step by step from STEP 1 above. Commit after each step с meaningful message.

Good luck — это критически срочная работа. Vladimir's other 4 accounts могут содержать risky listings которые Amazon найдёт next.

---

**Created by:** Claude · **For:** Claude Code in VS Code · **Date:** 2026-05-17
