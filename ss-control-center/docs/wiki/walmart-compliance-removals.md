# 🛡️ Walmart Compliance / Trust & Safety снятия (read-инструмент)

## Суть
Машиночитаемый список листингов, которые Walmart снял за **Item-Compliance /
Trust & Safety** нарушение (Prohibited Products и т.п.) — то же, что в Seller
Center «Health & Compliance → Item compliance — Multiple items need attention»
и кнопка T&S «Download Reports», но через API. Не руками из UI.

Инструмент: `walmart_compliance_removals`.

## Как достаём (и почему именно так)
Рабочий путь — **обычный Items API на простом OAuth**:

```
GET /v3/items?publishedStatus=UNPUBLISHED&limit=200&offset=N   (offset-пагинация)
```

Причина снятия лежит в каждом item: `unpublishedReasons.reason[]`. T&S-снятие —
это конкретная формулировка:

> "Your item has been flagged by our internal team. To find out why, file a case in Case Management."

Она отличается от `…End Date has passed` (END_DATE) и `…violates Walmart
Marketplace's Pricing Rule` (PRICE_RULE). Классифицируем по тексту, отдаём
violation-подмножество (TRUST_SAFETY_FLAG + COMPLIANCE).

### Что НЕ подошло (проверено живьём 2026-06-24 на store 1 / seller 10001624309)
- Insights `GET /v3/insights/items/unpublished/counts` → 200, но для нас отдаёт
  только END_DATE + REASONABLE_PRICE… **T&S там не считается** (это отдельный hold).
- Insights `GET /v3/insights/items/unpublished/items` → **403** "Auth header
  required for this consumer" (нужен `WM_CONSUMER.CHANNEL.TYPE` зарегистрированного
  Solution Provider — у нас нет). POST → 404.
- Reports `reportType=ITEM` → есть `ComplianceAttributes`/`PublishedStatus`, но
  **нет колонки причины снятия** → T&S от price не отличить.
- Webhooks/Notifications события `ITEM_COMPLIANCE` Walmart не публикует.

⚠️ offset-пагинация `/v3/items` глючит и повторяет строки → дедуп по `sku+wpid`.
См. [walmart-catalog-cache.md](walmart-catalog-cache.md).

## Где в коде
- `src/lib/walmart/compliance-removals.ts` — пагинатор + классификатор (`getComplianceRemovals`)
- `src/app/api/walmart/compliance-removals/route.ts` — read-эндпоинт:
  - `GET /api/walmart/compliance-removals` → JSON (только нарушения)
  - `?format=csv` → CSV-выгрузка
  - `?includeAll=1` → все классы unpublished
  - `?storeIndex=1` (дефолт = STARFITSTORE / Sirius Trading)
- `scripts/diag-walmart-unpublished{,4}.ts` — пробы, задокументировавшие находку

## Замер на момент создания (2026-06-24)
572 unpublished всего → **42 уникальных T&S снятия**, 434 price-rule, 96 end-date.
Среди 42 — много старых промо-названий (Дима/ChatGPT: "Tasty Selection",
"Delicious", "Comfort Classics") = ровно паттерн, триггерящий compliance-флаги
(история 99300 в CLAUDE.md). Кандидаты на Smart Scrub.

## 🔗 Связи
- **См. также:** [Walmart Marketplace API](walmart-api.md),
  [Walmart ограничения](walmart-restrictions.md),
  [Listing Quality](walmart-growth-listing-quality.md)

## История
- 2026-06-24: статья создана; инструмент `walmart_compliance_removals` собран и
  запушен (commit f5c9019)
