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
- [ ] 2D.1 — Shipping main grid → mobile-cards
- [ ] 2D.2 — Shipping skuModal grid-cols-4 → grid-cols-2 sm:grid-cols-4
- [ ] 2D.3 — Shipping tagModal & skuModal — рефикс blue palette → Salutem
- [ ] 2D.4 — Shipping error block bg-red-50 → bg-danger-tint
- [ ] 2D.5 — Settings SKU Database (9 колонок) → mobile-cards
- [ ] 2D.6 — Settings GmailAccountsPanel rows → flex-col sm:flex-row
- [ ] 2D.7 — Settings SpApiStoresPanel rows → flex-col sm:flex-row
- [ ] 2D.8 — Settings AiProvidersPanel selects → w-52 → w-full sm:w-52
- [ ] 2D — git commit

## Bonus / опциональные
- [ ] B.1 — Procurement badge: добавить ordersToBuy в /api/dashboard/summary

## Финал
- [ ] § 9 — Универсальная grep-проверка
- [ ] § 10 — Wiki update (mobile-adaptation.md, CONNECTIONS.md, index.md)
- [ ] Финальный git push

## ⚠️ Questions for Vladimir
(пока пусто)
