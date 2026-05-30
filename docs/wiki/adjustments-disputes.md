# 💰 Adjustments Disputes — Workflow & Status

## Суть
Большинство WeightAdjustment строк в модуле Adjustments — это carrier reweigh
recharges от FedEx/UPS/USPS которые **можно оспаривать** через Amazon Buy
Shipping support. Некоторые adjustment-ы абсурдные (например **$234 на $32
label = 714% overcharge**) — там почти гарантированный refund.

## Связано с
- [Adjustments Monitor](adjustments-monitor.md) — сам модуль
- `src/components/adjustments/AdjustmentsTable.tsx` — UI dispute helpers
- `src/app/api/adjustments/[id]/route.ts` — PATCH endpoint для записи Case ID

---

## 🚦 Текущий статус — pending первый dispute (2026-05-29 → 2026-05-30)

| Поле | Значение |
|---|---|
| **Case ID** | `20424098481` |
| Order | `112-9151636-5460222` |
| Product | Rayberns Philly Cheesesteak Sandwich (6 per case) |
| Adjustment | `-$234.54` (WeightAdjustment) |
| Original label | $32.85 (714% overcharge) |
| Declared package | 12 lbs · 12×12×10 in |
| Carrier | FedEx 2Day One Rate via Amazon Buy Shipping |
| Tracking | 380984268998 |
| Filed | 2026-05-29 23:10 UTC |
| Amazon promise | Ответ < 24ч |
| Amazon case URL | https://sellercentral.amazon.com/cu/case-dashboard/view-case?caseID=20424098481 |
| Стратегия | Тест на самом неоспоримом case. Если откажут — копать дальше не стоит (мелочь $0.50-$3 однозначно не вернут). Если одобрят — строим conveyor для остальных 158 charges. |

**Reminder для следующей сессии:** проверить status case → если won, начинать раскатку workflow на остальные строки; если denied, сначала эскалация (см. ниже), потом думать.

---

## ❌ НЕ работает программно

**Нет SP-API endpoint** для создания disputes/cases. Проверено через
Anthropic claude-code-guide + Amazon GitHub discussion #3589:
- Shipping API v2 — 9 endpoints, ни одного для disputes
- Messaging API — только buyer-seller, не support
- Finances API — read-only, нет dispute поля
- Reports API — только данные, не cases

Поэтому весь flow **manual через Seller Central UI**. В нашем модуле есть
**Copy dispute text** + **Open Amazon Buy Shipping support** + **Mark as
disputed** кнопки чтобы свести ручную работу к ~3-5 минут на dispute.

---

## 📋 Verified manual flow (Amazon Seller Central UI, 2026-05-29)

Это последовательность шагов которую нам пришлось discover-ить методом
проб — Amazon-овский UI не очевиден. Документируем чтобы при следующих
disputes не угадывать заново.

1. Открыть https://sellercentral.amazon.com/cu/contact-us
   → редирект на `/help/center?redirectSource=Hill`
2. Service dropdown — **только** "Selling on Amazon" / "Advertising on
   Amazon" (Shipping/Buy Shipping в списке НЕТ). Оставить "Selling on Amazon".
3. **"Create new issue"** tab — задизаблено пока не пройдёшь Hub.
4. Прокрутить вниз → нажать **"My issue is not listed"** (серая кнопка).
5. Открывается форма со 4 полями:
   - "What do you need help with?" → paste нашего dispute text (использовать
     **Copy dispute text** кнопку в нашем приложении — текст уже включает
     order/SKU/dims/cost math)
   - "What steps have you taken already?" → описать verify steps
   - "Reference numbers" → `Order: <id>, Tracking: <num>, ASIN: <asin>, SKU: <sku>`
   - Attach files — приложить **2 screenshots**: Seller Central order page
     (где видно $267.39 charge на 12 lb) + FedEx tracking (delivered успешно)
6. **Continue** → Amazon AI парсит entities (auto-detect Order/ASIN/SKU,
   рисует chips) + переписывает description в `Suggested description`.
   Можно оставить AI-версию или вернуть через "Use original text".
7. **Continue** ещё раз → секция 2 **Troubleshoot issue** с категорией
   `mfn_buy_shipping`. 6 опций — нажать **Refund**.
8. Sub-categories появляются: **How to Request Refund** / **How to View
   Refund Status**. Нажать **"How to Request Refund"** (deflection FAQ).
9. Откроется поле **Enter order ID** → вводишь → Continue.
10. Amazon скажет: *"After a review of order ID ..., we've determined the
    order status is Shipped. Please enter an order ID which has not been
    shipped yet."* — это deflection бот не понимает что мы disputing
    adjustment, а не cancelling. **Нажать "Contact an associate"** (НЕ
    "My issue is resolved" — закроет case с no-op).
11. Секция 3 **Contact associates** → **Enter ASIN** → Continue.
12. Выбор contact method: **Email** / Phone / Chat. **Chat иногда выдаёт
    error** — fallback на **Email**. Заполнить email + subject (auto-set
    как `Buy Shipping (Non-EasyShip; Prime and non-Prime)`).
13. **Send** → редирект на `/cu/case-dashboard/view-case?caseID=<id>`.
    Скопировать Case ID.
14. Вернуться в наш модуль → раскрыть ту строку → **Mark as disputed**
    → вставить Case ID → Save. Строка становится синей "Disputed #<id>".

**Время на полный flow** (после первого раза): ~3-5 минут на dispute.

---

## 🎯 План когда придёт ответ от Amazon

### ✅ Если refund одобрен
- Build conveyor для остальных charges (см. "Что строить дальше" ниже)
- Добавить `disputeStatus` enum (`pending`/`approved`/`denied`/`won`/`lost`)
- Добавить `disputeRefundAmount` Float
- Total recovered counter в KPI cards
- Trigger automatic Mark as Approved когда статус == won

### 🟡 Если попросят больше доказательств
Возможные запросы Amazon-а:
- Video unboxing/weigh package на калиброванных весах
- Фото с измерительной лентой
- FedEx tracking detail PDF с финальной стоимостью
- Invoice от карьера если применимо

### ❌ Если denied
**НЕ закрывать case**. Ответ на denial:
```
Please provide the carrier reweigh measurements that justify a $234.54
adjustment for a 12-lb package measuring 12×12×10 inches. According to
our records this declaration is accurate. I would like to escalate to
a Buy Shipping specialist for review.
```
Если эскалация тоже denied — копать дальше **не имеет смысла**, мелкие
($0.50-$3) точно не вернут.

---

## 🛠 Что строить дальше (если первый dispute won)

Приоритеты (от важного к nice-to-have):

1. **Smart filter "Disputable only"** — показать только charges > $5
   которые ещё не disputed. Из 158 WeightAdjustment останется ~30-50
   реально стоящих времени строк.

2. **Sort by amount** — сверху самые жирные (как тот $234), снизу копейки.
   Disputить в порядке убывания ROI.

3. **disputeStatus tracking** — после ответа Amazon обновляем status:
   `pending` → `approved` / `denied` / `escalated`. + `disputeRefundAmount`.

4. **Win rate dashboard** — на /adjustments показать "Disputed 23 · Won
   17 · Lost 4 · Pending 2 · Recovered $1,247" — мотивирует продолжать.

5. **Bulk dispute helper** — чекбоксы рядом со строками → выбрать 10 →
   "Generate batch" откроет 10 вкладок одновременно с уже скопированным
   текстом. Риск: Amazon может flag-нуть как spam. Не больше 10-15 за
   раз. Cooldown между batches 30+ мин.

6. **Auto-fill Veeqo evidence** — для каждой disputed строки автоматически
   подтянуть фото package из Veeqo (есть `productImageUrl`) + видео-link
   если будет добавлено.

---

## 📂 Файлы

```
src/components/adjustments/AdjustmentsTable.tsx
  → buildDisputeText(adj)        — generates dispute body
  → trackingUrl(carrier, num)    — carrier site link
  → caseDashboardUrl(caseId)     — Amazon case dashboard
  → copyDispute / saveDispute / clearDispute handlers

src/app/api/adjustments/[id]/route.ts
  → PATCH accepts { disputeCaseId, reviewed, notes, ... }
  → setting disputeCaseId stamps disputedAt=now + reviewed=true

src/app/api/dashboard/summary/route.ts
  → adjustmentsUnreviewed count excludes rows with disputeCaseId

prisma/schema.prisma → model ShippingAdjustment
  → disputeCaseId String?
  → disputedAt    DateTime?

Migrations:
  20260530030000_dispute_tracking/migration.sql (local)
  scripts/turso-migrate-dispute-tracking.mjs   (Turso runner)
```

---

## История

- **2026-05-29 23:10 UTC** — первый dispute filed (Case 20424098481, $234.54).
  Discovery всего UI flow методом проб (Vladimir + Claude по скриншотам).
- **2026-05-30** — dispute tracking infrastructure готова (commit `1c18f85`).
  Ждём ответа Amazon. Решение по conveyor — после.
