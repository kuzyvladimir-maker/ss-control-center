# 🌡️ Frozen Analytics — Модуль

## Суть
Анализ инцидентов с frozen-товарами (растаявшие при доставке). Автоматический сбор данных: transit time, carrier/service, погода отправления и доставки, SKU. Накопление паттернов для операционных решений.

## Путь в приложении
`/frozen-analytics` — **начат**

## Данные по каждому инциденту
- **Заказ:** Order ID, tracking, carrier, service, ship date, EDD, actual delivery, days in transit/late, Claims Protected badge, label cost
- **Товар:** SKU, product name, box size (XS/S/M/L/XL), weight
- **Погода:** температура origin (Tampa, FL) + destination в день доставки
- **Результат:** outcome (thawed/unclear/ok), resolution (a2z/replacement/refund)

## SKU Risk Profiles
Агрегация инцидентов по SKU → risk score 0-100 → risk level (low/medium/high/critical).

## Связанные файлы
- `src/app/frozen-analytics/page.tsx` — UI
- `src/app/api/frozen/` — API routes
- `src/components/frozen-analytics/` — компоненты
- `src/lib/frozen-analytics.ts` — логика
- `src/lib/weather.ts` — Weather API
- `src/lib/geocoding.ts` — Geocoding
- `docs/FROZEN_ANALYTICS_v1.0.md` — полный алгоритм

## DB модели
- `FrozenIncident` — инциденты
- `SkuRiskProfile` — риск-профили по SKU

## 🔗 Связи
- **Зависит от:** [Veeqo API](veeqo-api.md), [Weather/Geocoding API](weather-geocoding.md), [Shipping Labels](shipping-labels.md)
- **Используется в:** [Customer Hub](customer-hub.md) (frozen жалобы создают инциденты)
- **Связанные модули:** [Shipping Labels](shipping-labels.md) (carrier/service данные), [Frozen/Dry классификация](frozen-dry-classification.md)
- **Бизнес-правила:** [Frozen shipping rules](frozen-shipping-rules.md)
- **См. также:** [Database Schema](database-schema.md)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
