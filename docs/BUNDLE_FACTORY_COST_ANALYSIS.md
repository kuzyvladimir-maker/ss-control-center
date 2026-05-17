# Bundle Factory — Cost Analysis & Budget Planning

> **Created:** 2026-05-17
> **Last updated:** 2026-05-17 (revised под realistic Vladimir scope)
> **Purpose:** Decision framework для AI API budget at different volume tiers
> **Status:** Pre-production analysis (revisit after first 90 days с real data)

---

## 🎯 Scope (revised 2026-05-17)

Bundle Factory Phase 2 цель: **создавать новые listings на Amazon + Walmart** автоматически через AI.

### Что внутри scope (Phase 2.1-2.5)

- ✅ **Stage 1 (Brief):** UI для ввода идеи bundle
- ✅ **Stage 2 (Research):** Perplexity API ищет retail products + secondary image URLs
- ✅ **Stage 2.5 (Image Mirror):** Download secondary images из retail/manufacturer sites → re-host в Cloudflare R2
- ✅ **Stage 3 (Variation Matrix):** AI генерирует bundle composition variants
- ✅ **Stage 4 (Content Generation):** AI генерит title + bullets + description для Amazon + Walmart
- ✅ **Stage 5 (Image Generation):** AI генерит **1 главную картинку** (1500×1500, high quality), хранит в R2
- ✅ **Stage 6 (Validation):** Compliance check против KB rules
- ✅ **Stage 7 (Distribution):** Push на Amazon SP-API (× 5 accounts) + Walmart Items API

### Что НЕ входит в Phase 2 (отложено)

- ❌ **eBay listings** — Phase 3
- ❌ **TikTok Shop listings** — Phase 3
- ❌ **TikTok video generation** (Higgsfield) — Phase 4
- ❌ **AI generation для secondary images** — берём готовые из manufacturer/retail sites
- ❌ **Auto-generated nutritional panel images** — Phase 3

### Channel scope: 6 channel SKUs per MasterBundle

- AMAZON_SALUTEM (Brand owner)
- AMAZON_PERSONAL
- AMAZON_AMZCOM
- AMAZON_SIRIUS (если Starfit bundle)
- AMAZON_RETAILER
- WALMART (только shelf-stable категории — Vladimir не имеет access к frozen на Walmart)

---

## 📐 Definition: "1 listing" vs "1 bundle"

В Bundle Factory architecture:
- **1 MasterBundle** = AI-generated recipe (research + content + image)
- **1 ChannelSKU** = публикация bundle на конкретном channel

**1 MasterBundle → до 6 ChannelSKUs** (5 Amazon + Walmart). AI generation costs incurred **ОДИН раз на MasterBundle** — distribution to channels это free API calls.

Vladimir's targets: **1000 / 3000 / 5000 unique bundles per month**.

Это значит:
- 1000 bundles/mo → up to 6000 channel listings
- 3000 bundles/mo → up to 18,000 channel listings  
- 5000 bundles/mo → up to 30,000 channel listings

---

## 💰 Per-bundle cost breakdown (final)

| Pipeline stage | API | Per-bundle cost | Notes |
|---|---|---|---|
| Stage 2 — Research | Perplexity Sonar Pro | $0.015-0.05 | 1 call, structured JSON output |
| Stage 2.5 — Image Mirror | Cloudflare R2 (download bandwidth: free, storage + writes) | <$0.002 | 3-5 secondary images, ~1.5 MB each |
| Stage 4 — Content Generation | Claude Sonnet 4.5 с prompt caching | $0.05-0.10 | Generates content для 2 channels (Amazon + Walmart), mostly shared template |
| Stage 5 — Main Image | OpenAI gpt-image-1 (1500×1500, high quality) | $0.08-0.17 | One AI-generated branded gift box image |
| Stage 5 — R2 storage (main) | Cloudflare R2 | <$0.001 | ~1 MB per bundle |
| Stage 6 — Validation | Local code (compiled validators) | $0 | No external API calls |
| Stage 7 — Distribution | Amazon SP-API + Walmart Items API | $0 | Free, just rate-limited |

**Total per bundle: $0.15 - $0.32**

### Cost split: where the money goes

При $0.25 average per bundle:
- 35% — OpenAI image generation
- 30% — Claude content generation
- 20% — Perplexity research
- 14% — Cloudflare R2 (storage + ops)
- 1% — overhead

---

## 📊 Monthly cost projections

### Variable AI costs by volume

| Volume | Per-bundle | AI cost |
|---|---|---|
| 500 bundles | $0.25 | **$125/mo** |
| **1000 bundles** | $0.25 | **$250/mo** |
| 2000 bundles | $0.25 | **$500/mo** |
| **3000 bundles** | $0.25 | **$750/mo** |
| **5000 bundles** | $0.25 | **$1,250/mo** |

### Fixed infrastructure costs

| Item | Cost | When needed |
|---|---|---|
| Vercel Pro plan | $20/mo | Now (need maxDuration > 60s for Perplexity calls) |
| Turso Scale tier | $29/mo | When out of free 9GB (~Year 1.5+) |
| Cloudflare R2 storage | $0.50-3/mo | Linear with volume — already в per-bundle costs above |
| n8n VPS | $0 incremental | Existing Vladimir's server |
| **Total fixed** | **$20-50/mo** | Stable across volumes |

### Total monthly budget

| Volume | AI cost | Fixed | **Total/mo** |
|---|---|---|---|
| 1000 bundles | $250 | $50 | **$300** |
| 3000 bundles | $750 | $50 | **$800** |
| 5000 bundles | $1,250 | $50 | **$1,300** |

### Annual budget (steady state)

| Volume | Monthly | Annual | Per bundle |
|---|---|---|---|
| 1000/mo | $300 | $3,600 | $0.30 |
| 3000/mo | $800 | $9,600 | $0.27 |
| 5000/mo | $1,300 | $15,600 | $0.26 |

---

## 🎯 ROI analysis

### Assumptions
- Average gift set sells **$50 retail**
- Net margin after Amazon fees / shipping / COGS: **30%** = $15 net profit per sale
- Conversion rate **listings → monthly sales**: 1-10% (depends on bundle quality + channel)
- Generation cost = **one-time investment per bundle** (listing lives months/years)

### Breakeven scenarios

| Volume | Total gen cost / mo | Sales needed for breakeven | Sales at 2% conversion | Monthly net profit (after gen recouped) |
|---|---|---|---|---|
| 1000 bundles | $300 | 20 sales | 20 sales/mo | $300/mo |
| 3000 bundles | $800 | 54 sales | 60 sales/mo | $900/mo |
| 5000 bundles | $1,300 | 87 sales | 100 sales/mo | $1,500/mo |

**At realistic 2% conversion, generation costs recoup in 1 month.**

### Higher conversion rates (3-5% typical для well-positioned bundles)

| Volume | Sales at 4% conversion | Monthly profit |
|---|---|---|
| 1000 | 40 sales | $600 |
| 3000 | 120 sales | $1,800 |
| 5000 | 200 sales | $3,000 |

### Cost as % of revenue (validation metric)

Healthy e-commerce business: tech costs <5% of revenue.

| Volume | AI cost | Revenue at 2% conv × $15 | AI % of revenue |
|---|---|---|---|
| 1000 bundles | $300/mo | $300/mo | 100% ❌ first month only |
| 1000 bundles (mature) | $300 | $750/mo (5% conv) | 40% ⚠️ |
| 3000 bundles (mature) | $800 | $2,250/mo | 36% ⚠️ |
| 5000 bundles (mature) | $1,300 | $3,750/mo | 35% ⚠️ |
| 5000 bundles + optimization | $700 | $3,750/mo | 19% ✅ |

**Insight:** При 2% conversion первый месяц unprofitable, но **generation cost = one-time**. Уже к месяцу 2-3 — pure profit. Cumulative ROI становится дико хорошим к месяцу 6+.

---

## 💡 Cost optimizations (если нужно cut budget)

### Tier 1: Free wins (no quality loss)

| # | Optimization | Savings | Notes |
|---|---|---|---|
| 1 | **Claude prompt caching** для KB context | -60% Claude cost | KB context same across bundles, cache hit free after first call |
| 2 | **Shared content base** для Amazon + Walmart | -30% Claude cost | Generate base content once, derive per-channel via template transforms |

### Tier 2: Quality trade-offs

| # | Optimization | Savings | Quality impact |
|---|---|---|---|
| 3 | **Perplexity Sonar** (cheap) instead of Sonar Pro | -$0.04/bundle | Less structured output, parse через Claude |
| 4 | **Lower image resolution** (1024×1024 vs 1500×1500) | -50% image cost | Не соответствует Walmart 1500+ requirement, breaks компат |
| 5 | **Template-based main image** (Photoshop merge с branded box) | -100% image cost | Lower quality, less unique branding |

### Tier 3: Architectural changes

| # | Optimization | Savings | Quality impact |
|---|---|---|---|
| 6 | **Gemini Flash** вместо Claude Sonnet | -80% content cost | Slightly lower quality, OK для most listings |
| 7 | **Custom research module** instead of Perplexity API | -30% research cost | Higher maintenance burden |
| 8 | **Self-hosted Llama 3 70B** на GPU VPS ($300/mo fixed) | Unlimited inference after fixed cost | Lower quality vs Claude, viable only at >3000 bundles/mo |

### Aggressive optimization scenario

Apply #1 + #2 (free wins) →
- Per-bundle: **$0.15-0.20** (vs $0.25 baseline)
- 5000 bundles/mo: **$750-1000/mo** total AI costs
- Quality identical to baseline

---

## ⚠️ Realistic ramp-up plan (не нужно сразу 5000)

### Phase A: Proof of concept (Months 1-3)

- Generate **300-500 bundles total** across 3 months
- Cost: **$75-150** total
- Goals:
  - Validate Bundle Factory pipeline works
  - Identify which bundle types convert best
  - Refine AI prompts based on real listing performance
- After Phase A: data-driven decision о scaling

### Phase B: Initial scaling (Months 4-6)

- Steady at **500-1500 bundles/mo**
- Cost: **$170-430/mo**
- Apply optimization #1 (prompt caching) — automatic
- Goal: validate sales velocity / conversion at scale

### Phase C: Mature operations (Months 7-12)

- Scale to **2000-5000 bundles/mo** if business case proven
- Apply optimizations #1, #2 → per-bundle ~$0.15
- Cost: **$350-800/mo**
- Goal: maximize ROI, prepare for Year 2

### Phase D: Steady state (Year 2+)

- Stable at **3000-5000 bundles/mo**
- Per-bundle cost ~$0.15 после full optimization
- **Total AI spend: $500-800/mo**
- Revenue from active inventory: estimated $15-30K/mo
- AI cost = 3-5% of revenue → **highly accretive**

---

## 🚧 Risk factors

### What could blow up the budget

1. **Inefficient prompts** — too many tokens per request → 2-3x estimated cost
   - Mitigation: prompt caching, prompt engineering review
   
2. **Multiple regenerations** — bad first output → re-run pipeline → 2x per bundle
   - Mitigation: Stage 6 validation catches issues before re-run

3. **Image regenerations** — Stage 5 output не соответствует brand guidelines → retry
   - Mitigation: detailed prompt + few-shot examples, set max retries=2

4. **Conversion rate worse than 2%** — generation cost exceeds sales income первые months
   - Mitigation: portfolio approach, A/B test bundle types, kill bottom 50% performers

### What protects against budget blowup

1. **Stage 6 validation** — blocks bad bundles before Stage 7 distribution
2. **Cost tracking** — `GenerationJob.cost_cents` field accumulates per-bundle
3. **Budget cap** — Bundle Factory может enforce monthly budget threshold (Phase 3+ feature)
4. **A/B testing** — generate 100 bundles, measure conversion, kill bottom 50%
5. **Phased rollout** — не start с 5000/mo, postupennoе scaling

---

## 📊 Monitoring metrics (post-launch)

Track these в Bundle Factory dashboard (Phase 3+ feature):

- `cost_per_bundle` (avg + p50/p95)
- `cost_per_sale` (lagging indicator)
- `total_monthly_ai_spend`
- `revenue_attributable` (sales of AI-generated listings)
- `roi_ratio` (revenue / generation cost)
- `bundles_by_conversion_decile` (top vs bottom performers)
- Image storage growth (Cloudflare R2 dashboard)

---

## 🆚 Alternative architectures (если default подход слишком expensive)

### Option A — Default Phase 2 (recommended)
- Perplexity + Claude + OpenAI Image + Cloudflare R2
- Per-bundle: $0.15-0.32
- Best quality, easy to start
- 5000 bundles/mo = $1,300/mo

### Option B — Hybrid AI + Templates
- AI title + bullets (Claude)
- Template description (Vladimir's master prompt structure)
- Template image (Photoshop merge product photos + branded box template)
- No TikTok video
- Per-bundle: **~$0.08-0.12**
- 5000 bundles/mo: **$400-600/mo**
- Quality trade-off на image uniqueness

### Option C — Self-hosted LLM (Year 2 при scale >3000/mo)
- VPS с GPU instance (~$300-500/mo fixed)
- Llama 3 70B или Mistral Large running locally
- Unlimited inference after fixed cost
- Break-even with Option A: ~3000 bundles/mo
- Quality lower but workable с good prompts

### Option D — Outsource humans (NOT recommended)
- Offshore content writers: $500-1000/mo per person
- Output: 50-100 listings/mo per person
- 5000 listings = 5-10 writers = $2,500-10,000/mo
- Worse economics than AI at scale

---

## 🎯 Final recommendation

### Start с **Default (Option A)** at **Phase A volume** (300-500 bundles total over Months 1-3)

**Reasoning:**
1. **Risk-limited:** $75-150 total investment to validate concept
2. **Speed:** Setup сегодня, first results через 1-2 weeks
3. **Quality:** Premium AI tools give best chance for high conversion
4. **Reversible:** если ROI bad, switch to Option B без big sunk cost

### After Month 3, decide based on data:

- ROI positive (cost-per-bundle < net profit-per-bundle): **scale up + apply optimizations #1, #2**
- ROI marginal: **switch to Option B (Hybrid AI + Templates)**
- ROI negative: **revisit listing quality, не scale**

### Capacity planning

Don't plan 5000/mo for Month 1. Realistic ramp:
- Months 1-3: 300-500 total bundles
- Months 4-6: 500-1500/mo
- Months 7-12: 2000-3000/mo
- Year 2: 3000-5000/mo steady state

---

## 📚 References

- Perplexity pricing: https://docs.perplexity.ai/docs/getting-started/pricing
- Anthropic Claude API pricing: https://www.anthropic.com/pricing#api
- OpenAI gpt-image-1 pricing: https://openai.com/api/pricing/
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/

---

## 🗓 Review schedule

- **After Phase 2.1 launch** (~1 week): validate Perplexity cost estimate against actual usage
- **After Phase 2.5 launch** (~1-2 months): full pipeline cost validation
- **After 100 bundles generated** (~Month 2): real cost-per-bundle baseline
- **After first 90 days** (~Month 3): ROI validation + optimization decisions
- **Quarterly thereafter**: revisit costs as API prices change + as scale grows

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
