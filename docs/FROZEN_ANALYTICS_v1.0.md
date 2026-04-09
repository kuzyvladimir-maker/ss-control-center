# 🌡️ Frozen Delivery Analytics — Salutem Solutions Control Center
## Version 1.0 — 2026-04-07
## Концепция модуля (черновик для разработки)

---

## 🎯 ЗАДАЧА МОДУЛЯ

Когда клиент жалуется на растаявший Frozen товар — система автоматически собирает полную картину по этой доставке:
- Сколько дней реально ехал заказ
- Какой сервис был выбран и почему
- Какая была температура во Флориде в день отправки
- Какая погода была у получателя в день доставки
- Что за товар (SKU, как упакован)

Вся эта информация накапливается в базе. Со временем появляются паттерны: при каком сочетании "жара + сервис + товар" чаще всего тает. Это позволяет принимать операционные решения — класть больше льда, выбирать другой сервис в жаркие дни, не отправлять определённые SKU при экстремальной жаре.

---

## 📋 КАКИЕ ДАННЫЕ СОБИРАЕМ ПО КАЖДОМУ ИНЦИДЕНТУ

### Данные о заказе (из Veeqo / Control Center DB)
| Поле | Источник | Пример |
|------|---------|--------|
| Order ID | Veeqo | 113-4567890 |
| Tracking number | Veeqo (employee notes) | 1Z999AA10123456784 |
| Carrier | Veeqo / shipping_labels table | UPS |
| Service | Veeqo / shipping_labels table | 2nd Day Air |
| Ship Date | shipping_labels.ship_date | 2026-04-04 |
| Promised EDD | shipping_labels.promised_edd | 2026-04-06 |
| Actual Delivery | carrier tracking API | 2026-04-07 |
| Days in transit | calc: actual - ship_date | 3 дня |
| Days late | calc: actual - promised_edd | 1 день |
| Claims Protected badge | shipping_labels.carrier_badge | Claims Protected |
| Label cost | shipping_labels.label_cost | $18.50 |

### Данные о товаре (из Veeqo / SKU DB)
| Поле | Источник | Пример |
|------|---------|--------|
| SKU | Veeqo order | JD-SEBC-12CT |
| Product name | Veeqo / SKU DB | Jimmy Dean Sausage Egg Biscuit 12ct |
| Box size | SKU DB | M (13×13×15) |
| Weight with ice | SKU DB col H | 8.5 lbs |
| Category | SKU DB | Frozen |

### Погода в точке отправки (Флорида, Tampa)
| Поле | Источник | Пример |
|------|---------|--------|
| Ship date | наши данные | 2026-04-04 |
| Temperature at ship time | Weather API (historical) | 87°F / 31°C |
| Heat index | Weather API | 94°F (feels like) |
| Weather condition | Weather API | Sunny, clear |
| High/Low that day | Weather API | 91°F / 74°F |

### Погода у получателя
| Поле | Источник | Пример |
|------|---------|--------|
| Delivery ZIP code | Veeqo order | 90210 |
| Delivery city/state | Veeqo order | Beverly Hills, CA |
| Temperature at delivery | Weather API (historical) | 78°F / 26°C |
| Weather condition | Weather API | Partly cloudy |
| High/Low that day | Weather API | 82°F / 65°F |

### Данные инцидента (из CS модуля)
| Поле | Источник | Пример |
|------|---------|--------|
| CS Case ID | cs_cases table | 47 |
| Customer complaint | cs_cases.categoryName | Frozen thawed |
| Complaint date | cs_cases.createdAt | 2026-04-07 |
| Days after delivery | calc | 0 (в день доставки) |
| Resolution | cs_cases.action | A2Z_GUARANTEE |

---

## 🔌 ИСТОЧНИКИ ДАННЫХ

### 1. Weather API для исторических данных

**Рекомендуемый сервис: Open-Meteo (бесплатно, без ключа)**

```
https://api.open-meteo.com/v1/history
?latitude=27.9506   (Tampa, FL)
&longitude=-82.4572
&start_date=2026-04-04
&end_date=2026-04-04
&hourly=temperature_2m,weathercode,apparent_temperature
&temperature_unit=fahrenheit
&timezone=America/New_York
```

**Для адреса получателя:** сначала нужно ZIP → coordinates через geocoding API.

**Альтернатива: WeatherAPI.com** (бесплатный план: 1M запросов/мес, historical data)
```
http://api.weatherapi.com/v1/history.json
?key=YOUR_KEY
&q=90210
&dt=2026-04-04
```

### 2. Carrier Tracking API
- UPS Tracking API
- FedEx Track API  
- USPS Web Tools API

### 3. Geocoding для ZIP → координаты
**Zippopotam.us (бесплатно, без ключа):**
```
https://api.zippopotam.us/us/90210
→ { "post code": "90210", "places": [{ "latitude": "34.088", "longitude": "-118.406" }] }
```

---

## 🧠 АЛГОРИТМ СБОРА ДАННЫХ

### Триггер: автоматически при C3 кейсе в CS модуле

Когда CS модуль создаёт кейс с `category = "C3"` (Frozen thawed) — автоматически запускается сбор данных для аналитики:

```
1. Из CS кейса взять: orderId
2. Найти заказ в Veeqo → tracking_number, carrier, service, ship_date, 
   destination ZIP
3. Вызвать carrier tracking API → actual_delivery_date, pickup_scan_date
4. Вычислить: days_in_transit, days_late
5. Найти SKU в shipping_labels / SKU DB → product info, box size, weight
6. Геокодировать ZIP получателя → lat/lon
7. Запросить исторические данные погоды:
   a) Tampa, FL на ship_date
   b) Destination на actual_delivery_date
8. Сохранить всё в таблицу frozen_incidents
9. Обновить агрегированную аналитику по SKU
```

### Ручной режим

Владимир может вручную добавить инцидент — ввести Order ID, система сама всё соберёт.

---

## 🖥️ ИНТЕРФЕЙС МОДУЛЯ

**Путь:** `/frozen-analytics`

**Три раздела:**

### Раздел 1: Incidents Log — лог всех инцидентов

```
┌─────────────────────────────────────────────────────────────────┐
│  🌡️ Frozen Delivery Analytics                    [+ Add Manual] │
│                                                                  │
│  Фильтры: [All Carriers ▼]  [All Services ▼]  [Last 30 days ▼] │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │ Date   │ SKU        │ Carrier │ Days │ Tampa°F │ Dest°F │ ❄️ ││
│  │ Apr 07 │ JD-SEBC-12 │ UPS 2DA │  3  │  87°F   │  78°F  │ 🔴 ││
│  │ Apr 05 │ TY-WINGS-5 │ FedEx G │  5  │  84°F   │  91°F  │ 🔴 ││
│  │ Mar 28 │ JD-SEBC-12 │ UPS GND │  4  │  79°F   │  73°F  │ 🟡 ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│  [кликнуть строку → детальная карточка инцидента]               │
└─────────────────────────────────────────────────────────────────┘
```

### Раздел 2: SKU Risk Analysis — по каждому товару

```
┌─────────────────────────────────────────────────────────────────┐
│  📦 SKU Risk Analysis                                            │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │ SKU        │ Product Name       │ Incidents │ Avg Days │ Risk ││
│  │ JD-SEBC-12 │ Jimmy Dean 12ct    │    4      │   3.5    │ 🔴   ││
│  │ TY-WINGS-5 │ Tyson Wings 5lb    │    2      │   4.0    │ 🟡   ││
│  │ JD-CROS-12 │ Jimmy Dean Cros.   │    0      │    —     │ 🟢   ││
│  └──────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### Раздел 3: Patterns Dashboard — паттерны и выводы

```
┌─────────────────────────────────────────────────────────────────┐
│  📊 Patterns & Insights                                          │
│                                                                  │
│  ⚠️ HIGH RISK COMBINATIONS (на основе всех инцидентов):         │
│                                                                  │
│  🔴 UPS Ground + Tampa >85°F + Transit >3 days                  │
│     Incidents: 6/6 (100% thaw rate)                             │
│     Recommendation: Use 2Day Air when Tampa >85°F               │
│                                                                  │
│  🟡 FedEx 2Day + Destination >85°F                              │
│     Incidents: 3/7 (43% thaw rate)                              │
│     Recommendation: Consider extra ice pack for hot destinations │
│                                                                  │
│  ✅ UPS 2nd Day Air + Tampa <80°F                               │
│     Incidents: 0/18 (0% thaw rate)                              │
│     Status: Safe combination                                     │
│                                                                  │
│  📈 Thaw Rate by Transit Days:                                   │
│  1 day: 0%  │  2 days: 2%  │  3 days: 18%  │  4+ days: 87%     │
│                                                                  │
│  🌡️ Thaw Rate by Tampa Temperature:                              │
│  <75°F: 0%  │  75-80°F: 5%  │  80-85°F: 22%  │  >85°F: 61%    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🗄️ СХЕМА БД

```prisma
model FrozenIncident {
  id                    Int      @id @default(autoincrement())
  createdAt             DateTime @default(now())
  
  // Связи
  csCaseId              String?
  
  // Заказ
  orderId               String
  amazonOrderId         String?
  trackingNumber        String?
  
  // Товар
  sku                   String
  productName           String
  boxSize               String?  // XS/S/M/L/XL
  weightLbs             Float?
  
  // Перевозка
  carrier               String   // ups / fedex / usps
  service               String   // "2nd Day Air" / "Ground" / etc.
  shipDate              String   // YYYY-MM-DD
  promisedEdd           String?  // YYYY-MM-DD
  actualDelivery        String?  // YYYY-MM-DD
  daysInTransit         Int?
  daysLate              Int?
  claimsProtectedBadge  Boolean?
  labelCost             Float?
  
  // Адрес получателя
  destZip               String?
  destCity              String?
  destState             String?
  destLat               Float?
  destLon               Float?
  
  // Погода — отправка (Tampa, FL)
  originTempF           Float?
  originFeelsLikeF      Float?
  originTempHighF       Float?
  originWeatherDesc     String?
  
  // Погода — доставка (у получателя)
  destTempF             Float?
  destFeelsLikeF        Float?
  destTempHighF         Float?
  destWeatherDesc       String?
  
  // Результат
  outcome               String   @default("thawed") // "thawed" | "unclear" | "ok"
  customerComplained    Boolean  @default(true)
  resolution            String?
  notes                 String?
}

model SkuRiskProfile {
  id                Int      @id @default(autoincrement())
  updatedAt         DateTime @updatedAt
  
  sku               String   @unique
  productName       String
  
  totalIncidents    Int      @default(0)
  thawedCount       Int      @default(0)
  thawRate          Float?
  
  avgDaysInTransit  Float?
  avgOriginTempF    Float?
  avgDestTempF      Float?
  
  mostCommonCarrier String?
  mostCommonService String?
  
  riskScore         Int      @default(0)
  riskLevel         String   @default("unknown") // "low" / "medium" / "high" / "critical"
  
  lastIncidentDate  String?
}
```

---

## ⚙️ ENV ПЕРЕМЕННЫЕ

```env
# Origin location (Tampa, FL)
ORIGIN_LAT=27.9506
ORIGIN_LON=-82.4572
ORIGIN_CITY=Tampa
ORIGIN_STATE=FL
```

---

## 📁 СТРУКТУРА ФАЙЛОВ

```
src/
├── app/
│   ├── frozen-analytics/
│   │   └── page.tsx
│   └── api/
│       └── frozen/
│           ├── incidents/route.ts
│           ├── incidents/[id]/route.ts
│           ├── sku-risk/route.ts
│           └── patterns/route.ts
├── components/
│   └── frozen-analytics/
│       ├── IncidentsTable.tsx
│       ├── IncidentDetail.tsx
│       ├── SkuRiskTable.tsx
│       ├── PatternsDashboard.tsx
│       ├── WeatherBlock.tsx
│       └── TransitTimeline.tsx
└── lib/
    ├── frozen-analytics.ts
    ├── weather.ts
    └── geocoding.ts
```

---

*Версия: v1.0 — 2026-04-07 (черновик концепции)*
*Для: Salutem Solutions Control Center*
*Модуль: Frozen Delivery Analytics*
