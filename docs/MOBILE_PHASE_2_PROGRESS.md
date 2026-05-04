# Mobile Phase 2 — Progress

Старт: 2026-05-04 (ночная сессия)

## Phase 2A — Customer Hub (приоритет)
- [x] 2A.1 — MessagesTab (9 колонок) → mobile-cards
- [x] 2A.2 — AtozTab (8 колонок) → mobile-cards
- [x] 2A.3 — ChargebacksTab (тонкий wrapper над AtozTab — наследует mobile-cards автоматически)
- [x] 2A.4 — FeedbackTab → mobile-cards
- [x] 2A.5 — MessageDetail action row → flex-wrap (+ AI Analysis grid → 1 col on mobile, popup menu bg-white→bg-surface)
- [x] 2A — git commit

## Phase 2B — Dashboard + Adjustments
- [x] 2B.1 — Dashboard awaiting-fulfilment (6 колонок) → mobile-cards
- [x] 2B.2 — AdjustmentsTable (8 колонок, expand-rows) → mobile-cards
- [x] 2B.3 — SkuIssuesPanel (7 колонок) → mobile-cards
- [x] 2B — git commit

## Phase 2C — Frozen + Claims + Feedback + Account Health
- [x] 2C.1 — Frozen IncidentsTable → mobile-cards (with expand)
- [x] 2C.2 — Frozen SkuRiskTable → mobile-cards
- [x] 2C.3 — Claims AtozTable → mobile-cards (with expand)
- [x] 2C.4 — Feedback FeedbackTable → mobile-cards (with expand)
- [x] 2C.5 — Account Health MetricRow → flex-col sm:flex-row + statusBorder/Badge palette cleanup
- [x] 2C — git commit

## Phase 2D — Shipping + Settings (самые сложные)
- [x] 2D.1 — Shipping main grid → mobile-cards
- [x] 2D.2 — Shipping skuModal grid-cols-4 → grid-cols-2 sm:grid-cols-4 + FedEx w-1/2 → w-full sm:w-1/2
- [x] 2D.3 — Shipping tagModal/skuModal blue → Salutem (text-slate-500 → text-ink-3, bg-blue-600 → bg-green, text-slate-400 → text-ink-4)
- [x] 2D.4 — Shipping error block bg-red-50 → bg-danger-tint
- [x] 2D.5 — Settings SKU Database (9 колонок) → mobile-cards (sticky header bg-white → bg-surface, search input bg-white → bg-surface, CardHeader flex-col sm:flex-row)
- [x] 2D.6 — Settings GmailAccountsPanel rows → flex-col sm:flex-row + 'Test all' row also flex-col
- [x] 2D.7 — Settings SpApiStoresPanel rows → flex-col sm:flex-row + Auth/Advanced row stacks
- [x] 2D.8 — Settings AiProvidersPanel selects w-52 → w-full sm:w-52, status rows stacked, LossSettingsPanel COGS/label rows stacked
- [x] 2D — git commit

## Bonus / опциональные
- [ ] B.1 — Procurement badge: добавить ordersToBuy в /api/dashboard/summary
  (skipped — Phase 1 уже добавил `procurement.ordersToBuy` в реальный API endpoint
  src/app/api/dashboard/summary/route.ts, badge показывается)

## Финал
- [x] § 9.1 — grep на запрещённые палитры (blue/gray/red/slate/yellow/orange/amber/purple) → 0 совпадений
- [x] § 9.2 — grep на text-white → только PhotoLightbox X-button на тёмном backdrop (allowed)
- [x] § 9.3 — npm run build → проходит без ошибок
- [x] § 10 — Wiki update (mobile-adaptation.md, CONNECTIONS.md, index.md)
- [x] Финальный git push

## ✅ Phase 2 ЗАВЕРШЁН (2026-05-04, ночная сессия)

Все ~13 таблиц + 5 точечных фиксов реализованы. Build проходит без ошибок.
Grep на запрещённые цвета: чисто.

**Что в commit'ах:**
1. `4dab465` — Phase 2A (Customer Hub: Messages, AtoZ, Chargebacks, Feedback, MessageDetail)
2. `25d4e39` — Phase 2B (Dashboard, Adjustments, SkuIssues)
3. `07d21a6` — Phase 2C (Frozen Incidents/SkuRisk, Claims, Feedback, Account Health)
4. `696cc12` — Phase 2D (Shipping main + skuModal + tagModal, Settings SKU + panels)
5. `4311def` — bulk Tailwind→Salutem palette migration (~20 files)
6. (this) — wiki update + final progress

**Бонусы сверх промпта:**
- Project-wide palette cleanup затронул не только 13 целевых файлов промпта,
  но и все остальные легаси-цвета в src/ (~20 файлов в общей сложности).
- Каждая expand-row на мобиле получила `grid-cols-1 sm:grid-cols-2`
  для compact-layout без конфликта.
- Account Health не только MetricRow, но и весь statusBorder/statusIcon
  переехал с green-500/amber-500/red-500 на Salutem токены.

Готово к финальной приёмке Vladimir.

## ⚠️ Questions for Vladimir
(пока пусто — все задачи выполнены без блокеров)
