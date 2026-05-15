# 🌤️ Weather & Geocoding API

## Суть
- **Weather API** — температура и погода для frozen analytics (origin Tampa + destination)
- **Geocoding** — преобразование ZIP получателя в координаты (lat, lon)

С v2.0 Frozen Analytics эти API стали ключевыми — без них не работает проактивный прогноз.

## Используемые сервисы

### Open-Meteo ⭐ (основной, с 2026-05)
**Почему выбран:**
- Полностью бесплатный, лимит ~10000 req/день
- **Без API ключа** — никаких регистраций
- Forecast на 16 дней вперёд
- Historical archive (для пост-анализа)
- **Climate Normals** — среднее за 30 лет → ответ на "необычно жарко для этого места и времени?"
- Надёжный, используется в продакшене многими сервисами

**Endpoints:**

```
# Прогноз (для Today's Risk алертов)
GET https://api.open-meteo.com/v1/forecast
  ?latitude={lat}&longitude={lon}
  &daily=temperature_2m_max,temperature_2m_min,apparent_temperature_max,weathercode
  &temperature_unit=fahrenheit
  &timezone=auto
  &start_date={YYYY-MM-DD}&end_date={YYYY-MM-DD}

# Climate normals (для расчёта anomaly = current - 30y avg)
GET https://climate-api.open-meteo.com/v1/climate
  ?latitude={lat}&longitude={lon}
  &start_date={YYYY-MM-DD}&end_date={YYYY-MM-DD}
  &models=MRI_AGCM3_2_S
  &daily=temperature_2m_mean

# Historical (для пост-анализа инцидентов в Incidents Log)
GET https://archive-api.open-meteo.com/v1/archive
  ?latitude={lat}&longitude={lon}
  &start_date={YYYY-MM-DD}&end_date={YYYY-MM-DD}
  &daily=temperature_2m_max,temperature_2m_min
  &temperature_unit=fahrenheit
```

**Документация:** https://open-meteo.com/en/docs

### Geocoding ZIP → координаты

**Вариант A — npm `uszipcode` (рекомендуемый)**
- Оффлайн, мгновенный lookup
- Бесплатно, без API ключа
- База ~42000 ZIP-кодов (≈2 MB)
- Идеально для пакетных операций (50+ заказов в одном cron run)

**Вариант B — Open-Meteo Geocoding**
- Сетевой запрос: `https://geocoding-api.open-meteo.com/v1/search?name={zip}&country=US`
- Бесплатно, без ключа
- Использовать как fallback если uszipcode пакет не справился

## Origin location (Tampa, FL — откуда отправляем все заказы)
```
FROZEN_ORIGIN_LAT=27.9506
FROZEN_ORIGIN_LON=-82.4572
FROZEN_ORIGIN_CITY=Tampa
FROZEN_ORIGIN_STATE=FL
```

## Связанные файлы
- `src/lib/frozen-analytics/weather-open-meteo.ts` — Open-Meteo клиент
- `src/lib/frozen-analytics/geocoding-zip.ts` — uszipcode lookup
- Раньше (v1.0): `src/lib/weather.ts`, `src/lib/geocoding.ts` (планировались под WeatherAPI.com — теперь Open-Meteo заменяет)

## 🔗 Связи
- **Используется в:** [Frozen Analytics](frozen-analytics.md) — основной потребитель

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта (планировался WeatherAPI.com с ключом)
- 2026-05-15: Переход на **Open-Meteo** (бесплатный, без ключа, есть climate normals) для Frozen Analytics v2.0


---
