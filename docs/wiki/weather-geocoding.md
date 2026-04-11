# 🌤️ Weather & Geocoding API

## Суть
Weather API для температуры при доставке (frozen analytics). Geocoding для координат по zip code.

## Использование
- Origin (Tampa, FL): температура в день отправки
- Destination: температура в день доставки
- Данные записываются в `FrozenIncident`

## Связанные файлы
- `src/lib/weather.ts` — Weather API клиент
- `src/lib/geocoding.ts` — Geocoding клиент

## 🔗 Связи
- **Используется в:** [Frozen Analytics](frozen-analytics.md)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
