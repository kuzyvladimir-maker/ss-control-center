# 🌡️ Frozen Delivery Analytics v2.0 — Proactive Risk Prediction

**Версия:** 2.0
**Дата:** 2026-05-15
**Заменяет:** `FROZEN_ANALYTICS_v1.0.md` (2026-04-07, концепция была только реактивной)

---

## 🎯 ГЛАВНОЕ ИЗМЕНЕНИЕ vs v1.0

**v1.0:** Реактивная аналитика — клиент пожаловался → собрали данные про инцидент → ищем паттерны.

**v2.0:** **Проактивный прогноз** — каждую ночь система смотрит вперёд на 1-3 дня, проверяет погоду по маршруту каждого Frozen-заказа, и утром выдаёт список заказов с риском и рекомендациями (больше льда / другой carrier / отложить).

Реактивный слой v1.0 остаётся — теперь он замыкает цикл обучения (сравнение прогнозов с реальными инцидентами).

---

## 🎯 КЛЮЧЕВАЯ БИЗНЕС-ЦЕЛЬ

**Свести к минимуму жалобы на доставленные растаявшие товары** через предотвращение, а не реакцию. Особенно критично летом (июнь–сентябрь во Флориде).

---

## 📡 ИСТОЧНИКИ ДАННЫХ

### 1. Заказы — Veeqo API (уже подключено)
- `GET /orders?status=awaiting_fulfillment` + фильтр по дате отгрузки
- Берём заказы, у которых ship date = today, +1 день, +2 дня, +3 дня

### 2. Классификация Frozen — Veeqo tags (уже работает)
- `GET /products/{product_id}` → проверка массива `tags`
- Используем существующую функцию из `src/lib/frozen-dry-classification.ts`

### 3. **Погода — Open-Meteo API** ⭐
**Почему Open-Meteo:**
- Полностью **бесплатный**, лимит ~10000 req/день
- **Без API ключа** — никаких регистраций и token'ов
- Forecast на 16 дней вперёд
- Historical archive (для пост-анализа)
- **Climate Normals** (среднее за 30 лет для конкретной даты и места) — это даёт ответ на вопрос "необычно жарко?"
- Документация: https://open-meteo.com/en/docs

**Используемые endpoints:**

```
GET https://api.open-meteo.com/v1/forecast
  ?latitude={lat}
  &longitude={lon}
  &daily=temperature_2m_max,temperature_2m_min,apparent_temperature_max,weathercode
  &temperature_unit=fahrenheit
  &timezone=auto
  &start_date={YYYY-MM-DD}
  &end_date={YYYY-MM-DD}
```

Для climate normals (сравнение с нормой):
```
GET https://climate-api.open-meteo.com/v1/climate
  ?latitude={lat}
  &longitude={lon}
  &start_date={YYYY-MM-DD}
  &end_date={YYYY-MM-DD}
  &models=MRI_AGCM3_2_S
  &daily=temperature_2m_mean
```

### 4. Геокодинг ZIP → координаты
**Вариант A (рекомендуемый):** Open-Meteo Geocoding (бесплатный)
```
GET https://geocoding-api.open-meteo.com/v1/search?name={zip}&country=US
```

**Вариант B (быстрее, оффлайн):** npm пакет `uszipcode` или встроенный JSON ZIP → lat/lon (~42000 записей, ~2 MB). Этот вариант предпочтительнее — без сетевых вызовов на ~50 заказов за раз.

---

## ⏰ NIGHTLY CRON PIPELINE

**Расписание:** ежедневно в 03:00 EST (минимальная нагрузка)

**Реализация:** либо `node-cron` внутри Next.js app, либо отдельный workflow в n8n (предпочтительно — n8n уже работает на VPS).

### Шаги pipeline (per cron run):

```
[01] Запрос в Veeqo: GET /orders с фильтром
     ship_date IN (today, today+1, today+2, today+3)
     status = "awaiting_fulfillment" OR "ready_to_ship"
     
[02] Для каждого заказа:
     - GET /products/{product_id} → проверка тегов
     - Если НЕ frozen → skip
     
[03] Для frozen-заказов:
     - Извлечь destination ZIP, ship date, carrier, service, EDD
     - Геокодинг ZIP → (lat, lon)
     
[04] Запрос погоды (батчем — все маршруты в одном цикле):
     - Origin (Tampa, FL: 27.9506, -82.4572) на ship_date
     - Destination (lat, lon) на EDD
     - Climate normals для обеих точек на эти даты
     
[05] Вычислить отклонение от нормы:
     origin_anomaly = origin_temp - origin_normal
     dest_anomaly = dest_temp - dest_normal
     
[06] Применить Rules Engine → risk level + рекомендации
     
[07] Найти SkuRiskProfile для этого SKU
     - Если risk_level >= "high" → повысить общий risk на 1 уровень
     
[08] Сохранить в FrozenRiskAlert:
     - order_id, sku, ship_date, edd
     - origin_temp, dest_temp, anomalies
     - risk_level, risk_score
     - recommendations (array of strings)
     - status = "pending"
     
[09] Если risk_level IN ("high", "critical"):
     - Добавить в очередь утреннего Telegram-уведомления
     
[10] В 07:00 EST: Telegram message
     "🌡️ Сегодня 5 frozen-заказов с риском
      🔴 2 critical
      🟠 3 high
      Открыть: /frozen-analytics"
```

---

## 📐 RULES ENGINE — таблица правил

Конфигурируемые пороги (можно менять без передеплоя — хранить в БД, таблица `FrozenRule`).

### Базовые правила (стартовые значения):

| # | Условие | Risk Level | Рекомендация |
|---|---------|------------|--------------|
| R1 | origin ≤80°F И dest ≤80°F | OK | Без изменений |
| R2 | origin или dest 80–85°F | LOW | Стандартная упаковка, можно Ground |
| R3 | origin или dest 85–90°F | MEDIUM | +1 ice pack, **рекомендуется 2-Day** |
| R4 | origin или dest 90–95°F | HIGH | +2 ice packs, **только 2-Day или быстрее** |
| R5 | origin или dest >95°F | CRITICAL | **Заменить на Overnight**, +2 ice packs |
| R6 | EDD-ship_date ≥3 дня И dest >85°F | CRITICAL | Изменить service или отложить |

### Модификаторы (повышают risk на 1 уровень):

| # | Условие | Модификатор |
|---|---------|-------------|
| M1 | origin_anomaly >5°F | "Жара аномальная для этой даты" → +1 |
| M2 | dest_anomaly >5°F | "Жара аномальная для этой даты" → +1 |
| M3 | SKU в SkuRiskProfile с risk_level ≥ high | "Этот SKU уже таял ранее" → +1 |
| M4 | Carrier = USPS Ground Advantage И транзит >2 дня | "USPS медленнее обещанного" → +1 |

### Текст рекомендаций (генерируется динамически):

```typescript
function buildRecommendations(alert: FrozenRiskAlert): string[] {
  const recs: string[] = [];
  
  if (alert.riskLevel === 'critical') {
    recs.push('🔴 Замените service на Overnight (если есть)');
  }
  if (alert.dest >= 85 && alert.transitDays >= 3) {
    recs.push('🚛 Сократите время в пути — выберите 2-Day или быстрее');
  }
  if (alert.origin >= 85 || alert.dest >= 85) {
    const packs = alert.dest >= 90 ? 2 : 1;
    recs.push(`🧊 Добавьте ${packs} дополнительный ice pack`);
  }
  if (alert.originAnomaly > 5) {
    recs.push(`☀️ В Тампе сегодня ${alert.origin}°F — на ${alert.originAnomaly}°F выше нормы`);
  }
  if (alert.skuHistory) {
    recs.push(`⚠️ SKU ${alert.sku} ранее имел ${alert.skuHistory.thawedCount} инцидентов с растаявшим товаром`);
  }
  
  return recs;
}
```

---

## 🖥️ UI — обновлённая страница `/frozen-analytics`

**Четыре таба:**

### Tab 1: 🔮 Today's Risk (новый, главный)

Список карточек на 1-3 дня вперёд, отсортированы по risk level (critical → high → medium → low):

```
┌───────────────────────────────────────────────────────────────┐
│ 🔴 CRITICAL  Order #113-4567890  Ships: tomorrow              │
│                                                                │
│ SKU: JD-SEBC-12 (Jimmy Dean 12ct)                             │
│ Destination: Phoenix, AZ 85001                                 │
│                                                                │
│ ☀️ Tampa today: 89°F (+6°F above normal)                      │
│ 🌵 Phoenix on delivery: 102°F (+4°F above normal)             │
│ 🚛 Carrier: UPS Ground (3 days transit)                       │
│                                                                │
│ Recommendations:                                               │
│ 🔴 Замените service на UPS 2-Day Air                          │
│ 🧊 Добавьте 2 дополнительных ice pack                         │
│ ⚠️ SKU JD-SEBC-12 ранее таял 4 раза                           │
│                                                                │
│ [✅ Apply] [🚫 Ignore] [✏️ Notes] [🔍 Order details]          │
└───────────────────────────────────────────────────────────────┘
```

**Действия:**
- `Apply` → обновить shipping notes в Veeqo + пометить alert как `applied`
- `Ignore` → пометить `ignored` (для последующего обучения системы)
- `Notes` → добавить комментарий (например "уже добавил лёд вручную")

### Tab 2: 📋 Incidents Log (как было в v1.0)

История фактических инцидентов после жалоб клиентов (реактивный слой).

### Tab 3: 📦 SKU Risk Analysis (как было в v1.0)

Профили SKU: общее число инцидентов, средние дни в пути, risk score, ранг.

### Tab 4: 📊 Patterns & Learning (новый)

Метрики эффективности системы:

```
┌────────────────────────────────────────────────────┐
│ За последние 30 дней:                              │
│                                                     │
│ 📨 Алертов: 47                                     │
│ ✅ Применено рекомендаций: 38 (81%)                │
│ ❌ Жалоб от клиентов: 6                            │
│                                                     │
│ Detection rate (поймали до жалобы): 67%            │
│ False positive (алерт был, жалобы нет): 84%        │
│ Missed cases (жалоба без алерта): 2                │
│                                                     │
│ Top SKU с алертами: JD-SEBC-12 (12 алертов)        │
│ Top штаты с риском: AZ, NV, TX, CA                 │
│                                                     │
│ [Suggest rule adjustments via Claude API]          │
└────────────────────────────────────────────────────┘
```

Кнопка `Suggest rule adjustments` отправляет в Claude API статистику + текущие правила и просит предложить корректировки порогов.

---

## 🚚 ИНТЕГРАЦИЯ С SHIPPING LABELS

В модуле Shipping Labels (при покупке этикетки для frozen-заказа):

1. Поиск `FrozenRiskAlert` по `order_id`
2. Если есть — показать баннер над выбором rate:

```
┌─────────────────────────────────────────────────────┐
│ 🌡️ Frozen Analytics Recommendation                  │
│                                                      │
│ Tampa сегодня 89°F. Phoenix на дату доставки 102°F. │
│                                                      │
│ Рекомендуется: UPS 2-Day Air вместо Ground.         │
│                                                      │
│ [✅ Follow] [Show why]                              │
└─────────────────────────────────────────────────────┘
```

3. Если пользователь следовал → отметить в `FrozenRiskAlert.shippingChoiceFollowed = true`
4. После завершения отгрузки → отслеживаем actual delivery + наличие/отсутствие жалобы (через CS Hub)

---

## 🔄 ЦИКЛ ОБУЧЕНИЯ

После доставки и (опционально) жалобы:

| Был алерт? | Жалоба пришла? | Вывод |
|------------|----------------|-------|
| ✅ Да | ✅ Да | Правило сработало (true positive) |
| ✅ Да | ❌ Нет | Превентивный успех или ложная тревога (зависит от того, следовали ли рекомендации) |
| ❌ Нет | ✅ Да | **Пробел в модели** — нужно понизить пороги или добавить правило |
| ❌ Нет | ❌ Нет | Норма |

Если категория "Missed cases" >5 за месяц → автоматическое предложение от Claude API: какие правила нужно изменить.

---

## 🗄️ СХЕМА БД — новые модели

```prisma
model FrozenRiskAlert {
  id                   String   @id @default(cuid())
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt
  
  // Order
  orderId              String
  veeqoOrderId         String?
  sku                  String
  productName          String?
  
  // Shipping plan
  shipDate             String   // YYYY-MM-DD
  edd                  String?  // YYYY-MM-DD
  transitDays          Int?
  plannedCarrier       String?
  plannedService       String?
  
  // Destination
  destZip              String
  destCity             String?
  destState            String
  destLat              Float?
  destLon              Float?
  
  // Weather forecast
  originTempF          Float?
  originNormalF        Float?
  originAnomalyF       Float?  // origin - normal
  originWeatherDesc    String?
  
  destTempF            Float?
  destNormalF          Float?
  destAnomalyF         Float?
  destWeatherDesc      String?
  
  // Risk
  riskLevel            String   // ok | low | medium | high | critical
  riskScore            Int      // 0-100
  triggeredRules       String   // JSON array: ["R3", "M1"]
  recommendations      String   // JSON array of strings
  
  // User action
  status               String   @default("pending") // pending | applied | ignored | resolved
  appliedAt            DateTime?
  appliedBy            String?
  userNotes            String?
  shippingChoiceFollowed Boolean?
  
  // Learning loop
  resultedInComplaint  Boolean? // updated after delivery + CS check
  linkedIncidentId     String?  // FrozenIncident.id если жалоба пришла
  
  @@unique([orderId, shipDate])
  @@index([riskLevel, status])
  @@index([shipDate])
}

model FrozenRule {
  id           String   @id @default(cuid())
  ruleCode     String   @unique // R1, R2, M1, etc.
  description  String
  conditions   String   // JSON: { originMin: 85, originMax: 90, destMin: null, destMax: null }
  riskLevel    String?  // если правило основное
  modifier     Int?     // +1, +2 если модификатор
  recommendation String?
  enabled      Boolean  @default(true)
  updatedAt    DateTime @updatedAt
}
```

Существующая `FrozenIncident` — без изменений. Добавляем поле:
```prisma
model FrozenIncident {
  // ... существующие поля
  linkedAlertId  String? // FrozenRiskAlert.id если был alert до жалобы
}
```

---

## ⚙️ ENV-переменные

```env
# Origin location (Tampa, FL)
FROZEN_ORIGIN_LAT=27.9506
FROZEN_ORIGIN_LON=-82.4572
FROZEN_ORIGIN_CITY=Tampa
FROZEN_ORIGIN_STATE=FL

# Open-Meteo не требует ключа!
# OPEN_METEO_BASE_URL опционально, по умолчанию api.open-meteo.com

# Cron
FROZEN_CRON_SCHEDULE="0 3 * * *"  # 03:00 EST ежедневно
FROZEN_CRON_TIMEZONE="America/New_York"

# Анализ
FROZEN_LOOKAHEAD_DAYS=3  # на сколько дней вперёд смотрим
FROZEN_TELEGRAM_TIME="07:00"  # время утреннего уведомления
```

---

## 📁 СТРУКТУРА ФАЙЛОВ

```
src/
├── app/
│   ├── frozen-analytics/
│   │   └── page.tsx                        # 4 таба
│   └── api/
│       └── frozen/
│           ├── alerts/route.ts             # GET список alerts (today's risk)
│           ├── alerts/[id]/route.ts        # PATCH (apply/ignore/notes)
│           ├── incidents/route.ts          # GET/POST инциденты (как в v1.0)
│           ├── sku-risk/route.ts           # GET риск-профили SKU
│           ├── patterns/route.ts           # GET метрики эффективности
│           ├── rules/route.ts              # GET/PUT правила
│           └── run-analysis/route.ts       # POST триггер ручного запуска cron
├── components/
│   └── frozen-analytics/
│       ├── TodaysRiskTab.tsx               # новый
│       ├── RiskAlertCard.tsx               # карточка алерта с действиями
│       ├── IncidentsTable.tsx              # из v1.0
│       ├── IncidentDetail.tsx
│       ├── SkuRiskTable.tsx                # из v1.0
│       ├── PatternsDashboard.tsx           # новый
│       └── WeatherBlock.tsx
└── lib/
    ├── frozen-analytics/
    │   ├── pipeline.ts                     # главный orchestrator cron-job
    │   ├── veeqo-orders-fetcher.ts         # шаг [01]-[02]
    │   ├── weather-open-meteo.ts           # запросы к Open-Meteo
    │   ├── geocoding-zip.ts                # uszipcode lookup
    │   ├── rules-engine.ts                 # применение правил
    │   ├── recommendations.ts              # генерация текстов
    │   └── telegram-morning.ts             # утренний summary
```

---

## 🚀 ПЛАН РЕАЛИЗАЦИИ ПО ФАЗАМ

### Phase 1 — MVP без climate normals (3-4 дня)
- БД: новые модели `FrozenRiskAlert`, `FrozenRule`
- Pipeline: получение заказов → погода (forecast only) → правила → save
- UI: Tab "Today's Risk" с карточками и базовыми действиями
- Cron через n8n workflow + Telegram-уведомление утром

### Phase 2 — Climate normals + learning loop (2-3 дня)
- Добавить запросы к Climate API
- Связка с CS Hub: при создании frozen-кейса искать FrozenRiskAlert по order_id
- Tab "Patterns & Learning"

### Phase 3 — Shipping Labels integration (1-2 дня)
- Баннер в Shipping модуле при наличии alert
- Запись choiceFollowed
- Apply кнопка обновляет Veeqo notes

### Phase 4 — Rules tuning UI + Claude suggestions (1-2 дня)
- Страница редактирования правил
- Кнопка "Suggest adjustments" → Claude API анализирует stats и предлагает изменения

---

## 🔗 СВЯЗАННЫЕ ДОКУМЕНТЫ

- `docs/wiki/frozen-analytics.md` — wiki-страница модуля
- `docs/wiki/weather-geocoding.md` — wiki-страница погоды/геокодинга
- `docs/FROZEN_ANALYTICS_v1.0.md` — старая концепция (только реактивная)
- `docs/CUSTOMER_HUB_ALGORITHM_v3.0.md` — для связки с CS жалобами
- `docs/MASTER_PROMPT_v3.3.md` — для связки с Shipping Labels

---

*Версия: v2.0 — 2026-05-15*
*Автор концепции: Vladimir*
*Документ: Salutem Solutions Control Center*
*Модуль: Frozen Delivery Analytics (proactive)*
