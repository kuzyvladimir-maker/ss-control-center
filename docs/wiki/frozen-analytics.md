# 🌡️ Frozen Analytics — Модуль

## Суть
Анализ рисков и инцидентов с frozen-товарами (растаявшие при доставке). С v2.0 — **проактивный прогноз**: ночной cron смотрит на 1-3 дня вперёд, проверяет погоду по маршруту каждого frozen-заказа, и утром выдаёт список заказов с риском и рекомендациями (больше льда / другой carrier / отложить). Реактивный слой v1.0 остаётся для замыкания цикла обучения (сравнение прогнозов с фактическими жалобами).

**Бизнес-цель:** свести к минимуму жалобы на растаявшие товары через предотвращение, а не реакцию. Критично летом (июнь–сентябрь).

## Путь в приложении
`/frozen-analytics` — **Phase 1+2 v2.0 реализованы 2026-05-15.** Активен таб "Today's Risk" с проактивными алертами. Остальные три таба (Incidents log / SKU risk / Patterns) сохранены из v1.0. n8n workflow JSON для ночного cron и утреннего summary лежат в `docs/n8n-workflows/`.

## Архитектура v2.0

### Ночной cron (03:00 EST)
1. Veeqo: заказы на ship date в окне `today..today+3`, status `awaiting_fulfillment`
2. Фильтр по тегам Veeqo `GET /products/{id}` → только frozen
3. ZIP получателя → координаты (uszipcode, оффлайн)
4. Open-Meteo Forecast: погода в Tampa на ship_date + у получателя на EDD
5. Open-Meteo Climate Normals: норма за 30 лет → флаг "необычная жара" если anomaly >5°F
6. Rules Engine (R1-R6 + модификаторы M1-M4) → risk level + рекомендации
7. Сохранить в `FrozenRiskAlert`
8. В 07:00 EST — Telegram-summary Владимиру

### Источники данных
- **Заказы:** Veeqo API (`GET /orders`)
- **Frozen-классификация:** Veeqo product tags (существующая логика)
- **Погода:** **Open-Meteo API** (бесплатный, без ключа, forecast + historical + climate normals)
- **Геокодинг:** npm пакет `uszipcode` (оффлайн, ~2MB база)

## Rules Engine
Конфигурируемые правила, хранятся в БД (модель `FrozenRule`), редактируются без передеплоя.

Базовые правила: R1 ≤80°F = OK / R2 80-85°F = LOW / R3 85-90°F = MEDIUM / R4 90-95°F = HIGH / R5 >95°F = CRITICAL / R6 transit≥3 дня + dest>85°F = CRITICAL.

Модификаторы повышают risk на 1 уровень: M1 origin аномалия >5°F / M2 dest аномалия >5°F / M3 SKU в high-risk profile / M4 USPS GA + transit >2 дня.

Через Claude API раз в месяц генерируются предложения по корректировке порогов на основе статистики detection rate / false positive / missed cases.

## UI — 4 таба
1. **🔮 Today's Risk** — карточки заказов с прогнозом риска, кнопки `Apply` / `Ignore` / `Notes`
2. **📋 Incidents Log** — история фактических инцидентов после жалоб (как в v1.0)
3. **📦 SKU Risk Analysis** — профили SKU, риск-скоры (как в v1.0)
4. **📊 Patterns & Learning** — метрики эффективности системы, suggest rule adjustments

## Интеграция с Shipping Labels
При покупке этикетки для frozen-заказа — если есть `FrozenRiskAlert`, показывается баннер с рекомендацией (например "Tampa 89°F, dest 102°F — выберите 2-Day вместо Ground"). Выбор пользователя записывается в `shippingChoiceFollowed` — для последующего обучения.

## Цикл обучения
После доставки — кросс-проверка с CS Hub:
- Алерт был + жалоба пришла → правило подтвердилось
- Алерт был + жалобы нет → превентивный успех или ложная тревога
- Алерта не было + жалоба пришла → пробел в модели (понизить пороги)
- Ни алерта, ни жалобы → норма

## Связанные файлы (план реализации)
- `src/app/frozen-analytics/page.tsx` — 4 таба
- `src/app/api/frozen/alerts/route.ts` — список алертов
- `src/app/api/frozen/alerts/[id]/route.ts` — apply/ignore
- `src/app/api/frozen/rules/route.ts` — управление правилами
- `src/app/api/frozen/patterns/route.ts` — метрики эффективности
- `src/components/frozen-analytics/TodaysRiskTab.tsx`
- `src/components/frozen-analytics/RiskAlertCard.tsx`
- `src/components/frozen-analytics/PatternsDashboard.tsx`
- `src/lib/frozen-analytics/pipeline.ts` — orchestrator
- `src/lib/frozen-analytics/weather-open-meteo.ts`
- `src/lib/frozen-analytics/geocoding-zip.ts`
- `src/lib/frozen-analytics/rules-engine.ts`
- `docs/FROZEN_ANALYTICS_v2_0.md` — полный алгоритм v2.0
- `docs/FROZEN_ANALYTICS_v1.0.md` — старая концепция (только реактивная)

## DB модели
- `FrozenRiskAlert` (новая) — прогнозируемые риски с рекомендациями
- `FrozenRule` (новая) — конфигурируемые правила
- `FrozenIncident` (существующая) — фактические инциденты, + поле `linkedAlertId`
- `SkuRiskProfile` (существующая) — риск-профили по SKU

## План реализации
- **Phase 1** (3-4 дня): MVP — модели БД, pipeline без climate normals, UI tab "Today's Risk", n8n cron
- **Phase 2** (2-3 дня): Climate normals, learning loop с CS Hub, tab "Patterns"
- **Phase 3** (1-2 дня): Баннер в Shipping Labels с записью choiceFollowed
- **Phase 4** (1-2 дня): UI редактирования правил, Claude suggestions для tuning

## 🔗 Связи
- **Зависит от:** [Veeqo API](veeqo-api.md), [Weather/Geocoding (Open-Meteo)](weather-geocoding.md), [Shipping Labels](shipping-labels.md), [Frozen/Dry классификация](frozen-dry-classification.md)
- **Используется в:** [Shipping Labels](shipping-labels.md) (баннер с рекомендациями при покупке этикетки), [Dashboard](dashboard.md) (счётчик заказов с риском)
- **Связано с:** [Customer Hub](customer-hub.md) (цикл обучения — frozen жалобы), [n8n Автоматизация](n8n-automation.md) (cron workflow), [Telegram](telegram-notifications.md) (утренний summary)
- **Бизнес-правила:** [Frozen shipping rules](frozen-shipping-rules.md)
- **См. также:** [Database Schema](database-schema.md)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта (v1.0 — только реактивная аналитика)
- 2026-05-15: **v2.0 spec написан** — переориентация на проактивный прогноз с Open-Meteo, ночной cron, rules engine, цикл обучения, интеграция с Shipping Labels
- 2026-05-15: **v2.0 Phase 1+2 реализованы** — модели `FrozenRiskAlert`/`FrozenRule` + миграция; pipeline на Open-Meteo (forecast + climate normals); rules engine с конфигурируемыми правилами в БД; UI таб "Today's Risk" с карточками; learning loop из `collectFrozenIncidentData`; n8n workflow для cron 03:00 ET + summary 07:00 ET


---
