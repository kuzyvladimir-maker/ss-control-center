# 💲 Pricing module (ценовые рамки)

Новый модуль `/pricing` в Command Center (добавлен 2026-06-15). Следит за
ценообразованием листингов и держит их в коридоре между «критически дёшево» и
«критически дорого». Первый канал — Uncrustables (cost-модель готова и
валидирована, см. [uncrustables-pricing-model.md](uncrustables-pricing-model.md)).

## Идея
Для каждого листинга считается целевая item-цена по cost-модели и две границы:
- **Ceiling = target × 1.02** — выше = 🔴 «too high» (теряем продажи).
- **Floor = landed × 1.3** — ниже = 🟠 «too low» (маржа слишком тонкая).
- Между ними — 🟢 «in range».

Кнопки: подтянуть один листинг к target (`.99` чуть ниже цели) или «Fix all
too-high» пачкой. Cron раз в день пересчитывает снапшот → ловит дрейф (например,
когда внешний репрайсер уводит цену за рамки).

## Архитектура
- `src/lib/pricing/cost-model.ts` — чистое ядро: константы (PACKAGING, LABEL,
  UNIT_COST, TARGET_MULT=1.5), `coolerFor`, `parseTotal`, `priceFor`, `classify`,
  `round99`. Переиспользуется страницей, cron и скриптами.
- `src/lib/pricing/uncrustables.ts` — data-слой: `syncUncrustables` (Merchant
  Listings отчёт → перечень SKU+title → **живая цена из getListing** (отчёт
  отстаёт на часы после переоценки) → классификация → снапшот в `Setting`
  key `pricing_uncrustables_snapshot`), `readSnapshot`, `applyReprice`.
- `src/app/api/pricing/uncrustables/route.ts` — GET (снапшот, `?refresh=1` пере-sync),
  POST (`{items:[{store,sku,price}]}` → переоценка).
- `src/app/api/cron/pricing-sync/route.ts` — ежедневный монитор (cron-auth).
- `src/app/pricing/page.tsx` + `src/components/pricing/PricingDashboard.tsx` — UI.
- Навигация: пункт «Pricing» в `SidebarContent.tsx`.

## Важные нюансы
- **Текущая цена берётся из `getListing`** (purchasable_offer → audience ALL →
  our_price), НЕ из Merchant-отчёта — отчёт лагает несколько часов после reprice.
- Снапшот хранится в `Setting` (key/value) — **без миграции** Turso.
- Только store1 (store2=403, store3=0 Uncrustable, store4/5 без API).
- **Наблюдение:** часть листингов после нашей переоценки снова уползла вверх
  (40шт показал $159 вместо $124) — вероятно работает внешний репрайсер
  (ChannelMax?), который двигает цены обратно. Это надо отдельно разобрать —
  модуль такой дрейф как раз и подсвечивает.

## Дальше
- Обобщить за пределы Uncrustables, когда подъедет COGS по другим товарам
  ([[project_cogs_pricing_parallel]]).
- Алерты при выходе за рамки (в существующую систему critical-alerts).
- Зарегистрировать cron `pricing-sync` в расписании Vercel.

## История
- 2026-06-15: модуль создан; ядро + sync + API + cron + страница + навигация; tsc 0 ошибок.
