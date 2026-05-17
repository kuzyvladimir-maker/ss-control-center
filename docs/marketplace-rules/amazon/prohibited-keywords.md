# Amazon Prohibited Keywords & Phrases (Consolidated)

> **Last verified:** 2026-05-17
> **Priority:** P0 — нарушение = listing suppression, иногда account warning

---

## TL;DR

Consolidated list всех запрещённых/restricted keywords для Amazon listings (title, bullets, description, brand fields). Bundle Factory Stage 6 (Validation) использует это как hard blocklist перед publication.

---

## 🚫 HARD-BLOCK keywords (suppression triggers)

### Promotional / sales language

```typescript
const PROMOTIONAL_BLOCKLIST = [
  // Discount language
  '% off', 'percent off', 'save $', 'save up to',
  'discount', 'sale', 'on sale', 'special offer',
  'limited time', 'today only', 'flash sale', 'deal of the day',
  
  // Shipping promotions
  'free shipping', 'free delivery', 'fast shipping', '2-day shipping',
  'overnight delivery', 'ships free', 'no shipping cost',
  
  // Urgency
  'while supplies last', 'limited stock', 'hurry', 'act now',
  'last chance', 'ending soon', 'don\'t miss out',
  
  // Bestseller / authority claims (без proof)
  '#1', 'number one', 'best seller', 'bestseller', 'top seller',
  'amazon\'s choice', 'amazon choice', 'editors\' pick',
  'most popular', 'top rated', 'award winning',
  
  // Buy commands
  'buy now', 'order today', 'add to cart', 'click here',
];
```

### Subjective superlatives без proof

```typescript
const SUPERLATIVES_BLOCKLIST = [
  'best', 'greatest', 'world\'s best', 'world\'s greatest',
  'ultimate', 'supreme', 'unbeatable', 'unmatched',
  'most amazing', 'extraordinary', 'incredible',
  'revolutionary', 'breakthrough', 'game-changing',
];
```

Все эти слова OK только если есть **specific proof** (e.g. "Best Picnic Magazine 2024 Award Winner" — приложить cert).

### Anti-competitor

```typescript
const COMPETITOR_BLOCKLIST = [
  'better than',
  'unlike (other brand)',
  'beats',
  'competitor',
  'alternative to (brand name)',
];
```

Цитировать Walmart/Costco/etc как **источник sourcing** OK (в description), но не как target comparison.

### Health / medical claims (FDA territory)

```typescript
const HEALTH_CLAIMS_BLOCKLIST = [
  // Disease claims
  'cures', 'treats', 'prevents disease', 'heals',
  'fda approved' (если не actually approved),
  
  // Weight loss
  'lose weight fast', 'fat burner', 'metabolism booster',
  
  // Performance claims
  'doctor recommended', 'doctor approved',
  'clinically proven', 'medically proven',
  
  // Anti-aging
  'reverses aging', 'youth restoring',
];
```

Для grocery — это редко применимо, но для health & beauty (Phase 2) — critical.

### Contact info / external links

```typescript
const CONTACT_BLOCKLIST = [
  /https?:\/\/\S+/,       // any URL
  /www\.\S+/,             // www domains
  /\b\d{3}[-\s]\d{3}[-\s]\d{4}\b/,  // phone numbers (US format)
  /@[A-Za-z0-9_]+/,       // social media handles
  /\bemail\b.*\bcontact\b/i,  // "email us at..."
];
```

### Special characters (in title)

```typescript
const FORBIDDEN_TITLE_CHARS = [
  '<', '>', '*', '?', '!',  // promotional symbols
  '™', '®', '©',            // trademark/copyright (Amazon adds these automatically где нужно)
  '★', '☆', '⭐',           // stars (clutter)
  // Bullets OK; em-dash OK; hyphens OK
];
```

---

## ⚠️ Brand IP — Non-manufacturer brands

**Critical для Vladimir's bundle strategy.**

Эти brand names **НЕ ДОЛЖНЫ** появляться как Vladimir's own brand в title position:

```typescript
const FOREIGN_BRAND_NAMES = [
  // Common bundle components
  'Lunchables', 'Uncrustables', 'Jimmy Dean', 'Eggland\'s',
  'Smucker\'s', 'Hormel', 'Tyson', 'Kraft',
  'Oscar Mayer', 'Hillshire Farm', 'Boar\'s Head',
  
  // Candy/snacks
  'M&Ms', 'Hershey\'s', 'Lindt', 'Ghirardelli', 'Russell Stover',
  'Reese\'s', 'Kit Kat', 'Snickers', 'Twix', 'Skittles',
  'Cheez-Its', 'Pringles', 'Doritos', 'Cheetos',
  
  // Coffee / tea
  'Folgers', 'Maxwell House', 'Starbucks', 'Dunkin', 'Nescafé',
  'Bigelow', 'Twinings', 'Celestial Seasonings', 'Lipton',
  
  // Cheese
  'Sargento', 'Tillamook', 'Cabot', 'Polly-O',
  
  // Frozen
  'Stouffer\'s', 'Lean Cuisine', 'Marie Callender\'s', 'Healthy Choice',
  
  // Cereals
  'Cheerios', 'Frosted Flakes', 'Lucky Charms',
];
```

### Where these names CAN appear

✅ **Bullets** (descriptive):
> "Includes Lunchables Pizza with Pepperoni — 12 fun, ready-to-assemble meals"

✅ **Description** (full details):
> "This gift set features Smucker's Uncrustables sandwiches in 4 flavors..."

❌ **Title** (brand position):
> ~~"Salutem Vita Lunchables Pizza Gift Set"~~ — VIOLATION

✅ **Title** (descriptive after brand):
> "Salutem Vita – Pizza Lunch Kit Gift Set, Pack of 12" — OK (no specific brand IP в position)

---

## ⚠️ Trademarked phrases

Не использовать без license:
- "Got Milk?" (California Milk Processor Board)
- "I'm Lovin' It" (McDonald's)
- "Just Do It" (Nike)
- "Think Different" (Apple)

Generic phrases (e.g. "Have it your way", "Snap, crackle, pop") могут быть trademarked — проверять перед использованием.

---

## 🔧 Bundle Factory Stage 6 implementation

```typescript
import {
  PROMOTIONAL_BLOCKLIST,
  SUPERLATIVES_BLOCKLIST,
  COMPETITOR_BLOCKLIST,
  HEALTH_CLAIMS_BLOCKLIST,
  CONTACT_BLOCKLIST,
  FORBIDDEN_TITLE_CHARS,
  FOREIGN_BRAND_NAMES,
} from './prohibited-keywords-constants';

function validateProhibitedKeywords(
  text: string,
  field: 'title' | 'bullet' | 'description',
  brandOwn: string
): { passed: boolean; issues: string[] } {
  const issues: string[] = [];
  const lower = text.toLowerCase();

  // Promotional check (all fields)
  for (const phrase of PROMOTIONAL_BLOCKLIST) {
    if (lower.includes(phrase)) {
      issues.push(`Promotional phrase detected: "${phrase}"`);
    }
  }

  // Superlatives (all fields)
  for (const word of SUPERLATIVES_BLOCKLIST) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text)) {
      issues.push(`Subjective superlative: "${word}"`);
    }
  }

  // Health claims (description особенно)
  for (const claim of HEALTH_CLAIMS_BLOCKLIST) {
    if (lower.includes(claim)) {
      issues.push(`Health/medical claim: "${claim}"`);
    }
  }

  // Contact info
  for (const pattern of CONTACT_BLOCKLIST) {
    if (pattern.test(text)) {
      issues.push(`Contact info detected: ${pattern}`);
    }
  }

  // Title-specific
  if (field === 'title') {
    // Forbidden chars
    for (const char of FORBIDDEN_TITLE_CHARS) {
      if (text.includes(char)) {
        issues.push(`Title forbidden char: "${char}"`);
      }
    }

    // Foreign brand в позиции own brand (первые 30 chars)
    const firstChars = text.substring(0, 30);
    for (const foreignBrand of FOREIGN_BRAND_NAMES) {
      if (firstChars.includes(foreignBrand) && !firstChars.startsWith(brandOwn)) {
        issues.push(`Foreign brand "${foreignBrand}" в title без brand position`);
      }
    }
  }

  return { passed: issues.length === 0, issues };
}
```

---

## Per-channel deviations

| Channel | Differences |
|---|---|
| Walmart | Stricter on promotional language; auto-rejected at title submission |
| eBay | Allows promotional language ("FAST SHIPPING") — но Bundle Factory unifies политику для consistency |
| TikTok | Allows emoji, branded mentions if creator; но для Vladimir's own listings — same restrictions |

---

## References

- Amazon Style Guide: https://sellercentral.amazon.com/help/hub/reference/external/G50R34A8WJ58JAYK
- Restricted Products: https://sellercentral.amazon.com/help/hub/reference/external/G200164330
- Internal: [`title-policy.md`](title-policy.md), [`bullet-points-policy.md`](bullet-points-policy.md), [`description-policy.md`](description-policy.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
