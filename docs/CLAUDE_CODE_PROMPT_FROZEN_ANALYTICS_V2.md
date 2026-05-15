# 🌡️ Claude Code Prompt: Frozen Analytics v2.0 — Phase 1+2

**Документ:** `CLAUDE_CODE_PROMPT_FROZEN_ANALYTICS_V2.md`
**Дата:** 2026-05-15
**Спецификация:** `docs/FROZEN_ANALYTICS_v2_0.md`
**Wiki:** `docs/wiki/frozen-analytics.md`

---

## 🎯 ЦЕЛЬ

Реализовать модуль **Frozen Analytics v2.0** — переориентация с реактивной аналитики (по жалобам) на **проактивный прогноз** рисков для frozen-доставок. Каждую ночь система анализирует заказы на 1-3 дня вперёд по всем 5 Amazon-аккаунтам через Veeqo, проверяет погоду по маршруту (Tampa → destination) через Open-Meteo, выдаёт утром список заказов с риском и рекомендациями (больше льда / другой carrier / отложить).

**Бизнес-цель:** свести к минимуму жалобы на растаявшие товары через предотвращение, особенно летом (июнь–сентябрь).

Реализуем **Phase 1 + Phase 2 одним заходом**:
- Phase 1: MVP — модели БД, pipeline (Veeqo + Open-Meteo forecast), Rules Engine, UI Tab "Today's Risk", n8n cron, Telegram-summary
- Phase 2: Climate normals, цикл обучения через CS Hub, Tab "Patterns & Learning"

Phase 3 (баннер в Shipping Labels) и Phase 4 (UI редактирования правил) — **отдельным промптом потом**, в этой задаче НЕ делаем.

---

## 📚 ЧТО ПРОЧИТАТЬ ПЕРЕД НАЧАЛОМ

**Обязательно прочитай эти файлы в указанном порядке:**

1. `docs/FROZEN_ANALYTICS_v2_0.md` — главная спецификация (источник правды)
2. `docs/wiki/frozen-analytics.md` — wiki-страница модуля
3. `docs/wiki/weather-geocoding.md` — про Open-Meteo
4. `docs/wiki/index.md` — общая карта проекта
5. `CLAUDE.md` — техспек проекта
6. `prisma/schema.prisma` — текущая схема БД (обрати внимание на существующие `FrozenIncident` и `SkuRiskProfile`)

**Посмотри существующий код:**

7. `src/app/frozen-analytics/page.tsx` — текущая страница (вероятно заглушки)
8. `src/components/frozen-analytics/` — папка с компонентами (если есть)
9. `src/lib/veeqo/` — клиент Veeqo (паттерны вызовов API)
10. `src/lib/frozen-dry-classification.ts` — функция определения frozen по тегам Veeqo (если есть)
11. `src/app/api/cs/` — паттерны API routes для CS модуля
12. `src/app/api/cs/analyze/route.ts` — место, куда нужно добавить связку с FrozenRiskAlert

**Дизайн-референс:**

13. `design/frozen_analytics_salutem.html` — HTML mockup (если есть) — source of truth для визуала
14. `design/DESIGN_TOKENS.md` — Salutem Design System токены

---

## 🏗️ АРХИТЕКТУРНЫЕ РЕШЕНИЯ (принципиально)

### 1. Cron-job — **в n8n на VPS, НЕ в Next.js**

Next.js деплоится на Vercel (serverless), там не работает `node-cron`. n8n уже работает на VPS Владимира и делает HTTP-вызов к Next.js API route:

```
n8n (расписание 03:00 EST + retry + Telegram alert при ошибке)
    ↓ HTTP POST с Bearer auth
Next.js: POST /api/frozen/run-analysis
    ↓ возвращает { processed, alerts, errors, duration }
n8n: если errors > 0 → Telegram "Frozen cron упал: ..."
n8n: 07:00 EST → второй workflow → GET /api/frozen/morning-summary → Telegram
```

**Создаём в Next.js только API endpoints** + JSON-файлы workflow для n8n (Владимир сам импортирует в n8n UI). Сам cron-планировщик НЕ устанавливаем в проект.

### 2. Все 5 Amazon-аккаунтов сразу

Источник заказов — **Veeqo**, а не SP-API. Veeqo агрегирует заказы со всех 5 Amazon-аккаунтов (и Walmart) в одно место. Делаем **один Veeqo-запрос на все аккаунты**, не 5 отдельных.

В `FrozenRiskAlert` сохраняем `storeIndex` и `storeName` (можно вытащить из Veeqo channel data) — это даёт фильтрацию в UI по магазину.

Walmart по бизнес-правилу `walmart-restrictions.md` не отгружает Frozen, но фильтр всё равно применяется через теги Veeqo — если случайно frozen-заказ попадёт на Walmart, он будет обработан как все остальные.

### 3. Rules Engine — **в БД с seed-значениями**

Модель `FrozenRule` в Prisma. При первом запуске Prisma seed наполняет таблицу дефолтными правилами R1-R6 + M1-M4 из кода (`prisma/seeds/frozen-rules.ts`). Runtime читает правила из БД через Prisma. **UI редактора правил в этой задаче НЕ делаем** (это Phase 4). Менять пороги можно через REST-клиент (`PUT /api/frozen/rules/{id}`).

### 4. Геокодинг — npm пакет `uszipcode-typed` (оффлайн)

```bash
npm install uszipcode-typed
```

Использовать его для lookup `ZIP → {lat, lon, city, state}`. Это работает мгновенно без сетевых вызовов. Fallback на Open-Meteo Geocoding API только если пакет не справился.

### 5. Дизайн — Salutem Design System v1.0

- Шрифты: Inter Tight (UI), JetBrains Mono (числа температуры)
- Базовый размер: 13.5px
- Чёрного текста нет — только `--ink: #15201B`
- На зелёных фонах используем `--green-cream: #F0E8D0`, не белый
- `tabular-nums` для всех числовых значений
- Радиусы: 6/10/14px

**Цвета risk levels** (use CSS variables from design tokens, fallback values):

| Level | Цвет фона карточки | Текст | Иконка |
|-------|---------------------|-------|--------|
| OK | `--green-light` (#E8F4EC) | `--ink` | 🟢 |
| LOW | `--amber-light` (#FFF6E0) | `--ink` | 🟡 |
| MEDIUM | `--amber` (#F5A623) | `--ink` | 🟠 |
| HIGH | `--orange` (#E87E2F) | white | 🔴 |
| CRITICAL | `--red-deep` (#B23A3A) | white | 🚨 |

---

## 📐 SHARED CHECKLIST

Веди этот чеклист в файле `docs/dev-log/frozen-v2-progress.md`. Создай его в начале работы. Отмечай галочками что сделано. Обновляй после каждого крупного шага. Это нужно для отслеживания прогресса.

```markdown
# Frozen Analytics v2.0 — Implementation Progress

## Phase 1: MVP
- [ ] Step 1: Prisma models (FrozenRiskAlert, FrozenRule + поле linkedAlertId в FrozenIncident)
- [ ] Step 2: Prisma migration + seed для FrozenRule
- [ ] Step 3: lib/frozen-analytics/weather-open-meteo.ts
- [ ] Step 4: lib/frozen-analytics/geocoding-zip.ts (uszipcode-typed)
- [ ] Step 5: lib/frozen-analytics/rules-engine.ts
- [ ] Step 6: lib/frozen-analytics/recommendations.ts
- [ ] Step 7: lib/frozen-analytics/pipeline.ts (orchestrator)
- [ ] Step 8: lib/frozen-analytics/morning-summary.ts
- [ ] Step 9: API: POST /api/frozen/run-analysis (триггер cron)
- [ ] Step 10: API: GET /api/frozen/morning-summary
- [ ] Step 11: API: GET/PATCH /api/frozen/alerts
- [ ] Step 12: API: GET/PUT /api/frozen/rules
- [ ] Step 13: UI: /frozen-analytics/page.tsx (4 таба)
- [ ] Step 14: UI: TodaysRiskTab + RiskAlertCard
- [ ] Step 15: Ensure IncidentsLogTab и SkuRiskTab работают (existing or new)

## Phase 2: Learning loop + Climate normals
- [ ] Step 16: Open-Meteo Climate Normals integration в weather-open-meteo.ts
- [ ] Step 17: Anomaly calculation в pipeline
- [ ] Step 18: API: GET /api/frozen/patterns (метрики эффективности)
- [ ] Step 19: UI: PatternsDashboard tab
- [ ] Step 20: CS Hub integration: при создании frozen-кейса искать FrozenRiskAlert
- [ ] Step 21: Обновление FrozenRiskAlert.resultedInComplaint + linkedIncidentId

## Final
- [ ] Step 22: n8n workflow JSON-файлы (2 файла)
- [ ] Step 23: Wiki update — frozen-analytics.md, CONNECTIONS.md, index.md
- [ ] Step 24: README в docs/dev-log с инструкцией по импорту n8n
- [ ] Step 25: Manual test через POST /api/frozen/run-analysis
- [ ] Step 26: Git commit + push
```

---

## 📦 STEP 1: Prisma Models

Файл: `prisma/schema.prisma` — добавить в конец.

```prisma
// === FROZEN ANALYTICS v2.0 — Proactive Risk Prediction ===

model FrozenRiskAlert {
  id                     String   @id @default(cuid())
  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt
  
  // Order identification
  orderId                String   // Veeqo order number (e.g. 113-4567890)
  veeqoOrderId           String?  // Internal Veeqo ID
  storeIndex             Int?     // 1-5 for Amazon stores
  storeName              String?  // "Salutem Solutions" etc.
  channel                String   @default("Amazon") // Amazon | Walmart
  
  // Product
  sku                    String
  productName            String?
  asin                   String?
  
  // Shipping plan (at time of alert generation)
  shipDate               String   // YYYY-MM-DD
  edd                    String?  // YYYY-MM-DD expected delivery date
  transitDays            Int?
  plannedCarrier         String?  // ups | fedex | usps
  plannedService         String?  // "Ground" | "2nd Day Air" etc.
  
  // Destination
  destZip                String
  destCity               String?
  destState              String?
  destLat                Float?
  destLon                Float?
  
  // Weather — Tampa (origin) on ship_date
  originTempF            Float?
  originFeelsLikeF       Float?
  originTempMaxF         Float?
  originNormalF          Float?   // 30-year average
  originAnomalyF         Float?   // origin - normal
  originWeatherDesc      String?
  
  // Weather — Destination on EDD
  destTempF              Float?
  destFeelsLikeF         Float?
  destTempMaxF           Float?
  destNormalF            Float?
  destAnomalyF           Float?
  destWeatherDesc        String?
  
  // Risk assessment
  riskLevel              String   // ok | low | medium | high | critical
  riskScore              Int      // 0-100
  triggeredRules         String   // JSON array: ["R3", "M1"]
  recommendations        String   // JSON array of strings
  
  // User action
  status                 String   @default("pending") // pending | applied | ignored | resolved
  appliedAt              DateTime?
  appliedBy              String?
  userNotes              String?
  shippingChoiceFollowed Boolean? // Did user follow recommended carrier/service?
  
  // Learning loop (filled after delivery)
  resultedInComplaint    Boolean? // Updated after CS check
  linkedIncidentId       String?  // FrozenIncident.id if complaint came
  
  @@unique([orderId, shipDate])
  @@index([riskLevel, status])
  @@index([shipDate])
  @@index([sku])
  @@index([storeIndex])
}

model FrozenRule {
  id             String   @id @default(cuid())
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  
  ruleCode       String   @unique // "R1", "R2", ..., "M1", "M2", ...
  ruleType       String   // "base" | "modifier"
  description    String
  
  // Conditions (JSON for flexibility)
  conditions     String   // {"originMin":85,"originMax":90,"destMin":null,...}
  
  // Outcome
  riskLevel      String?  // ok|low|medium|high|critical (for base rules)
  modifier       Int?     // +1, +2 (for modifier rules)
  recommendation String?  // text template
  
  enabled        Boolean  @default(true)
  priority       Int      @default(100) // lower = applied first
}
```

**Добавить поле в существующую `FrozenIncident`:**

Найди модель `FrozenIncident` и добавь в конец полей:
```prisma
  linkedAlertId String? // FrozenRiskAlert.id, если был alert до жалобы
  @@index([linkedAlertId])
```

---

## 🌱 STEP 2: Migration + Seed для FrozenRule

```bash
npx prisma migrate dev --name add_frozen_analytics_v2
```

Файл: `prisma/seeds/frozen-rules.ts`

```typescript
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const DEFAULT_RULES = [
  // === BASE RULES ===
  {
    ruleCode: 'R1',
    ruleType: 'base',
    description: 'Both origin and destination cool',
    conditions: JSON.stringify({ originMax: 80, destMax: 80 }),
    riskLevel: 'ok',
    recommendation: null,
    priority: 10,
  },
  {
    ruleCode: 'R2',
    ruleType: 'base',
    description: 'Mild warmth (80-85°F)',
    conditions: JSON.stringify({ tempMin: 80, tempMax: 85, applyTo: 'any' }),
    riskLevel: 'low',
    recommendation: 'Стандартная упаковка, Ground приемлем',
    priority: 20,
  },
  {
    ruleCode: 'R3',
    ruleType: 'base',
    description: 'Moderate heat (85-90°F)',
    conditions: JSON.stringify({ tempMin: 85, tempMax: 90, applyTo: 'any' }),
    riskLevel: 'medium',
    recommendation: '+1 ice pack, рекомендуется 2-Day вместо Ground',
    priority: 30,
  },
  {
    ruleCode: 'R4',
    ruleType: 'base',
    description: 'High heat (90-95°F)',
    conditions: JSON.stringify({ tempMin: 90, tempMax: 95, applyTo: 'any' }),
    riskLevel: 'high',
    recommendation: '+2 ice packs, ТОЛЬКО 2-Day или быстрее',
    priority: 40,
  },
  {
    ruleCode: 'R5',
    ruleType: 'base',
    description: 'Extreme heat (>95°F)',
    conditions: JSON.stringify({ tempMin: 95, applyTo: 'any' }),
    riskLevel: 'critical',
    recommendation: 'Замените на Overnight, +2 ice packs',
    priority: 50,
  },
  {
    ruleCode: 'R6',
    ruleType: 'base',
    description: 'Long transit + warm destination',
    conditions: JSON.stringify({ transitMin: 3, destMin: 85 }),
    riskLevel: 'critical',
    recommendation: 'Сократите время в пути или отложите отгрузку',
    priority: 60,
  },
  // === MODIFIERS (повышают risk на 1 уровень) ===
  {
    ruleCode: 'M1',
    ruleType: 'modifier',
    description: 'Аномальная жара в Тампе (>5°F выше нормы)',
    conditions: JSON.stringify({ originAnomalyMin: 5 }),
    modifier: 1,
    recommendation: 'Жара в Тампе аномальная для этой даты',
    priority: 100,
  },
  {
    ruleCode: 'M2',
    ruleType: 'modifier',
    description: 'Аномальная жара у получателя (>5°F выше нормы)',
    conditions: JSON.stringify({ destAnomalyMin: 5 }),
    modifier: 1,
    recommendation: 'Жара у получателя аномальная для этой даты',
    priority: 100,
  },
  {
    ruleCode: 'M3',
    ruleType: 'modifier',
    description: 'SKU имеет историю инцидентов (high/critical risk profile)',
    conditions: JSON.stringify({ skuRiskMin: 'high' }),
    modifier: 1,
    recommendation: 'Этот SKU уже таял ранее',
    priority: 100,
  },
  {
    ruleCode: 'M4',
    ruleType: 'modifier',
    description: 'USPS Ground Advantage с transit >2 дня',
    conditions: JSON.stringify({ carrier: 'usps', service: 'ground_advantage', transitMin: 2 }),
    modifier: 1,
    recommendation: 'USPS GA медленнее обещанного',
    priority: 100,
  },
];

export async function seedFrozenRules() {
  for (const rule of DEFAULT_RULES) {
    await prisma.frozenRule.upsert({
      where: { ruleCode: rule.ruleCode },
      update: {}, // не перезаписываем — у пользователя могут быть свои значения
      create: rule,
    });
  }
  console.log(`✅ Seeded ${DEFAULT_RULES.length} frozen rules`);
}

// Run if executed directly
if (require.main === module) {
  seedFrozenRules().finally(() => prisma.$disconnect());
}
```

Добавить в `package.json`:
```json
"scripts": {
  "seed:frozen-rules": "tsx prisma/seeds/frozen-rules.ts"
}
```

Запустить: `npm run seed:frozen-rules`

---

## 🌤️ STEP 3: Open-Meteo Client

Файл: `src/lib/frozen-analytics/weather-open-meteo.ts`

```typescript
/**
 * Open-Meteo API client for Frozen Analytics.
 * - Forecast: api.open-meteo.com (current + future, до 16 дней)
 * - Climate normals: climate-api.open-meteo.com (для расчёта anomaly)
 * - НЕ требует API ключа!
 */

export interface WeatherDay {
  date: string;          // YYYY-MM-DD
  tempMaxF: number;
  tempMinF: number;
  feelsLikeMaxF: number;
  weatherCode: number;   // WMO weather code
  weatherDesc: string;   // "Sunny", "Partly cloudy", etc.
}

export interface ClimateNormal {
  date: string;
  meanTempF: number;     // 30-year average
}

/**
 * Получить прогноз на конкретные даты для координат.
 * Использует /v1/forecast (поддерживает текущий день и до 16 дней вперёд).
 */
export async function fetchForecast(
  lat: number,
  lon: number,
  startDate: string, // YYYY-MM-DD
  endDate: string    // YYYY-MM-DD
): Promise<WeatherDay[]> {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lat.toFixed(4));
  url.searchParams.set('longitude', lon.toFixed(4));
  url.searchParams.set('daily', 
    'temperature_2m_max,temperature_2m_min,apparent_temperature_max,weathercode'
  );
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('start_date', startDate);
  url.searchParams.set('end_date', endDate);
  
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Open-Meteo forecast failed: ${res.status}`);
  const data = await res.json();
  
  return data.daily.time.map((date: string, i: number) => ({
    date,
    tempMaxF: data.daily.temperature_2m_max[i],
    tempMinF: data.daily.temperature_2m_min[i],
    feelsLikeMaxF: data.daily.apparent_temperature_max[i],
    weatherCode: data.daily.weathercode[i],
    weatherDesc: weatherCodeToDesc(data.daily.weathercode[i]),
  }));
}

/**
 * Получить климатические нормы (среднее за 30 лет) для координат и дат.
 * Использует climate-api.open-meteo.com.
 * Возвращает meanTempF для каждой даты — это база для расчёта anomaly.
 */
export async function fetchClimateNormals(
  lat: number,
  lon: number,
  startDate: string,
  endDate: string
): Promise<ClimateNormal[]> {
  const url = new URL('https://climate-api.open-meteo.com/v1/climate');
  url.searchParams.set('latitude', lat.toFixed(4));
  url.searchParams.set('longitude', lon.toFixed(4));
  url.searchParams.set('start_date', startDate);
  url.searchParams.set('end_date', endDate);
  url.searchParams.set('models', 'MRI_AGCM3_2_S');
  url.searchParams.set('daily', 'temperature_2m_mean');
  url.searchParams.set('temperature_unit', 'fahrenheit');
  
  const res = await fetch(url.toString());
  if (!res.ok) {
    // Climate API может быть недоступен — это не критично, anomaly будет null
    console.warn(`Climate normals unavailable: ${res.status}`);
    return [];
  }
  const data = await res.json();
  
  if (!data.daily?.time) return [];
  
  return data.daily.time.map((date: string, i: number) => ({
    date,
    meanTempF: data.daily.temperature_2m_mean[i],
  }));
}

/**
 * WMO weather code → human-readable description.
 * https://open-meteo.com/en/docs (search for "Weather variable documentation")
 */
function weatherCodeToDesc(code: number): string {
  const map: Record<number, string> = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Fog',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    71: 'Slight snow',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail',
  };
  return map[code] || `Code ${code}`;
}
```

---

## 📍 STEP 4: Geocoding

```bash
npm install uszipcode-typed
```

Файл: `src/lib/frozen-analytics/geocoding-zip.ts`

```typescript
/**
 * ZIP code → geographic coordinates lookup.
 * Uses npm package `uszipcode-typed` (offline, ~2MB JSON database).
 * Fallback: Open-Meteo Geocoding API (network call).
 */

import { ZipCodeLookup } from 'uszipcode-typed';

export interface ZipLocation {
  zip: string;
  lat: number;
  lon: number;
  city: string;
  state: string; // 2-letter code (CA, NY, etc.)
}

const zipLookup = new ZipCodeLookup();

/**
 * Lookup ZIP → coordinates. Returns null if not found.
 */
export function lookupZip(zip: string): ZipLocation | null {
  const cleaned = zip.trim().slice(0, 5); // ZIP+4 format support
  const result = zipLookup.byZipcode(cleaned);
  
  if (!result || !result.lat || !result.lng) return null;
  
  return {
    zip: cleaned,
    lat: result.lat,
    lon: result.lng,
    city: result.city || 'Unknown',
    state: result.state || 'XX',
  };
}

/**
 * Fallback: query Open-Meteo Geocoding API.
 * Use only if `lookupZip` returns null.
 */
export async function geocodeFallback(zip: string): Promise<ZipLocation | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${zip}&country=US&count=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.results?.[0]) return null;
    
    const r = data.results[0];
    return {
      zip,
      lat: r.latitude,
      lon: r.longitude,
      city: r.name,
      state: r.admin1_code || 'XX',
    };
  } catch {
    return null;
  }
}
```

---

## ⚙️ STEP 5: Rules Engine

Файл: `src/lib/frozen-analytics/rules-engine.ts`

```typescript
import { prisma } from '@/lib/prisma';

export interface RuleContext {
  originTempF: number | null;
  destTempF: number | null;
  originAnomalyF: number | null;
  destAnomalyF: number | null;
  transitDays: number | null;
  carrier: string | null;
  service: string | null;
  sku: string;
  skuRiskLevel?: string | null; // from SkuRiskProfile
}

export interface RuleResult {
  riskLevel: string;
  riskScore: number; // 0-100
  triggeredRules: string[]; // ["R3", "M1"]
}

const LEVEL_ORDER = ['ok', 'low', 'medium', 'high', 'critical'];

/**
 * Apply all enabled rules from DB and return final risk level + triggered rules.
 */
export async function evaluateRisk(ctx: RuleContext): Promise<RuleResult> {
  const rules = await prisma.frozenRule.findMany({
    where: { enabled: true },
    orderBy: [{ ruleType: 'desc' }, { priority: 'asc' }], // base first, then modifiers
  });
  
  const baseRules = rules.filter(r => r.ruleType === 'base');
  const modifiers = rules.filter(r => r.ruleType === 'modifier');
  
  // Find highest matching base rule
  let baseLevel = 'ok';
  const triggered: string[] = [];
  
  for (const rule of baseRules) {
    const cond = JSON.parse(rule.conditions);
    if (matchesBaseRule(cond, ctx)) {
      if (levelRank(rule.riskLevel!) > levelRank(baseLevel)) {
        baseLevel = rule.riskLevel!;
        // не break — может быть более серьёзное правило ниже
      }
      triggered.push(rule.ruleCode);
    }
  }
  
  // Apply modifiers
  let finalLevel = baseLevel;
  for (const mod of modifiers) {
    const cond = JSON.parse(mod.conditions);
    if (matchesModifierRule(cond, ctx)) {
      finalLevel = bumpLevel(finalLevel, mod.modifier || 1);
      triggered.push(mod.ruleCode);
    }
  }
  
  return {
    riskLevel: finalLevel,
    riskScore: levelToScore(finalLevel),
    triggeredRules: triggered,
  };
}

function matchesBaseRule(cond: any, ctx: RuleContext): boolean {
  // applyTo: 'any' means apply to max(origin, dest)
  if (cond.applyTo === 'any') {
    const maxTemp = Math.max(ctx.originTempF || 0, ctx.destTempF || 0);
    if (cond.tempMin != null && maxTemp < cond.tempMin) return false;
    if (cond.tempMax != null && maxTemp >= cond.tempMax) return false;
    return true;
  }
  
  // Specific checks
  if (cond.originMax != null && (ctx.originTempF || 999) > cond.originMax) return false;
  if (cond.destMax != null && (ctx.destTempF || 999) > cond.destMax) return false;
  if (cond.destMin != null && (ctx.destTempF || 0) < cond.destMin) return false;
  if (cond.transitMin != null && (ctx.transitDays || 0) < cond.transitMin) return false;
  
  return true;
}

function matchesModifierRule(cond: any, ctx: RuleContext): boolean {
  if (cond.originAnomalyMin != null) {
    return (ctx.originAnomalyF || 0) >= cond.originAnomalyMin;
  }
  if (cond.destAnomalyMin != null) {
    return (ctx.destAnomalyF || 0) >= cond.destAnomalyMin;
  }
  if (cond.skuRiskMin != null) {
    if (!ctx.skuRiskLevel) return false;
    return levelRank(ctx.skuRiskLevel) >= levelRank(cond.skuRiskMin);
  }
  if (cond.carrier != null) {
    if (ctx.carrier?.toLowerCase() !== cond.carrier) return false;
    if (cond.service && !ctx.service?.toLowerCase().includes(cond.service.replace('_', ' '))) return false;
    if (cond.transitMin != null && (ctx.transitDays || 0) < cond.transitMin) return false;
    return true;
  }
  return false;
}

function levelRank(level: string): number {
  return LEVEL_ORDER.indexOf(level);
}

function bumpLevel(level: string, by: number): string {
  const idx = Math.min(LEVEL_ORDER.indexOf(level) + by, LEVEL_ORDER.length - 1);
  return LEVEL_ORDER[idx];
}

function levelToScore(level: string): number {
  const map: Record<string, number> = {
    ok: 5, low: 25, medium: 50, high: 75, critical: 95,
  };
  return map[level] || 0;
}
```

---

## 💬 STEP 6: Recommendations Generator

Файл: `src/lib/frozen-analytics/recommendations.ts`

```typescript
import type { RuleContext, RuleResult } from './rules-engine';

export function buildRecommendations(
  ctx: RuleContext,
  result: RuleResult,
  skuHistoryCount?: number
): string[] {
  const recs: string[] = [];
  const maxTemp = Math.max(ctx.originTempF || 0, ctx.destTempF || 0);
  
  // Critical actions
  if (result.riskLevel === 'critical') {
    if (ctx.service && !/(overnight|next.day|1.day)/i.test(ctx.service)) {
      recs.push(`🔴 Замените service на Overnight (если доступно у carrier)`);
    }
    if ((ctx.transitDays || 0) >= 3 && (ctx.destTempF || 0) >= 85) {
      recs.push(`🚛 Текущий transit ${ctx.transitDays} дн. слишком долгий при ${ctx.destTempF}°F в destination`);
    }
  }
  
  // Ice pack recommendations
  if (maxTemp >= 90) {
    recs.push(`🧊 Добавьте 2 дополнительных ice pack (max temp ${maxTemp.toFixed(0)}°F)`);
  } else if (maxTemp >= 85) {
    recs.push(`🧊 Добавьте 1 дополнительный ice pack (max temp ${maxTemp.toFixed(0)}°F)`);
  }
  
  // Service recommendation
  if (result.riskLevel === 'high' && ctx.service && /ground/i.test(ctx.service)) {
    recs.push(`📦 Выберите 2-Day Air вместо Ground (current: ${ctx.service})`);
  }
  
  // Anomaly notes
  if ((ctx.originAnomalyF || 0) > 5) {
    recs.push(`☀️ В Тампе на ${ctx.originAnomalyF?.toFixed(0)}°F выше нормы для этого дня`);
  }
  if ((ctx.destAnomalyF || 0) > 5) {
    recs.push(`🌡️ У получателя на ${ctx.destAnomalyF?.toFixed(0)}°F выше нормы для этого дня`);
  }
  
  // SKU history
  if (skuHistoryCount && skuHistoryCount > 0) {
    recs.push(`⚠️ SKU ${ctx.sku} ранее таял ${skuHistoryCount} раз`);
  }
  
  return recs;
}
```

---

## 🔧 STEP 7: Pipeline Orchestrator

Файл: `src/lib/frozen-analytics/pipeline.ts`

```typescript
import { prisma } from '@/lib/prisma';
import { fetchVeeqoOrders } from '@/lib/veeqo'; // existing function — use same pattern as Shipping Labels
import { isOrderFrozen } from '@/lib/frozen-dry-classification'; // existing
import { lookupZip, geocodeFallback } from './geocoding-zip';
import { fetchForecast, fetchClimateNormals } from './weather-open-meteo';
import { evaluateRisk } from './rules-engine';
import { buildRecommendations } from './recommendations';

const ORIGIN_LAT = parseFloat(process.env.FROZEN_ORIGIN_LAT || '27.9506');
const ORIGIN_LON = parseFloat(process.env.FROZEN_ORIGIN_LON || '-82.4572');
const LOOKAHEAD_DAYS = parseInt(process.env.FROZEN_LOOKAHEAD_DAYS || '3', 10);

export interface PipelineResult {
  processed: number;     // all orders fetched
  frozenOrders: number;  // filtered to frozen only
  alertsCreated: number;
  alertsUpdated: number;
  errors: number;
  errorDetails: string[];
  durationMs: number;
}

/**
 * Run nightly frozen analytics pipeline.
 * Called by:
 * - n8n cron via POST /api/frozen/run-analysis (production)
 * - Manual trigger from UI (dev/test)
 */
export async function runFrozenAnalysisPipeline(): Promise<PipelineResult> {
  const start = Date.now();
  const result: PipelineResult = {
    processed: 0,
    frozenOrders: 0,
    alertsCreated: 0,
    alertsUpdated: 0,
    errors: 0,
    errorDetails: [],
    durationMs: 0,
  };
  
  try {
    // 1. Calculate date window
    const today = new Date();
    const endDate = new Date(today);
    endDate.setDate(today.getDate() + LOOKAHEAD_DAYS);
    
    const todayStr = today.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);
    
    // 2. Fetch orders from Veeqo (all stores in one call)
    // Use existing pattern from Shipping Labels module
    const orders = await fetchVeeqoOrders({
      status: ['awaiting_fulfillment', 'ready_to_ship'],
      shipDateFrom: todayStr,
      shipDateTo: endStr,
    });
    result.processed = orders.length;
    
    // 3. Pre-fetch origin (Tampa) weather for full date range (one call)
    const originForecast = await fetchForecast(ORIGIN_LAT, ORIGIN_LON, todayStr, endStr);
    const originNormals = await fetchClimateNormals(ORIGIN_LAT, ORIGIN_LON, todayStr, endStr);
    const originByDate = new Map(originForecast.map(d => [d.date, d]));
    const originNormalByDate = new Map(originNormals.map(n => [n.date, n.meanTempF]));
    
    // 4. Process each order
    for (const order of orders) {
      try {
        // Check if frozen
        const isFrozen = await isOrderFrozen(order);
        if (!isFrozen) continue;
        result.frozenOrders++;
        
        // Geocode destination ZIP
        const destZip = order.deliver_to?.zip || order.shipping_address?.zip;
        if (!destZip) continue;
        
        let destLoc = lookupZip(destZip);
        if (!destLoc) destLoc = await geocodeFallback(destZip);
        if (!destLoc) {
          result.errorDetails.push(`No geocoding for ZIP ${destZip} (order ${order.number})`);
          continue;
        }
        
        // Determine ship date and EDD
        const shipDate = order.expected_dispatch_date?.slice(0, 10) || todayStr;
        const transitDays = order.expected_delivery_days || 3;
        const edd = addDays(shipDate, transitDays);
        
        // Get origin weather for ship date
        const originDay = originByDate.get(shipDate);
        const originNormal = originNormalByDate.get(shipDate);
        
        // Fetch destination weather for EDD (separate call per unique location)
        const destForecast = await fetchForecast(destLoc.lat, destLoc.lon, edd, edd);
        const destDay = destForecast[0];
        const destNormals = await fetchClimateNormals(destLoc.lat, destLoc.lon, edd, edd);
        const destNormal = destNormals[0]?.meanTempF;
        
        // Lookup SKU risk profile
        const sku = order.allocations?.[0]?.line_items?.[0]?.sku || 'UNKNOWN';
        const skuProfile = await prisma.skuRiskProfile.findUnique({ where: { sku } });
        
        // Build context
        const ctx = {
          originTempF: originDay?.tempMaxF || null,
          destTempF: destDay?.tempMaxF || null,
          originAnomalyF: originDay && originNormal ? originDay.tempMaxF - originNormal : null,
          destAnomalyF: destDay && destNormal ? destDay.tempMaxF - destNormal : null,
          transitDays,
          carrier: order.preferred_courier?.toLowerCase() || null,
          service: order.preferred_service || null,
          sku,
          skuRiskLevel: skuProfile?.riskLevel || null,
        };
        
        // Evaluate
        const evalResult = await evaluateRisk(ctx);
        const recommendations = buildRecommendations(ctx, evalResult, skuProfile?.thawedCount);
        
        // Skip 'ok' results — not worth alerting
        if (evalResult.riskLevel === 'ok') continue;
        
        // Upsert alert
        const upserted = await prisma.frozenRiskAlert.upsert({
          where: { orderId_shipDate: { orderId: order.number, shipDate } },
          create: {
            orderId: order.number,
            veeqoOrderId: String(order.id),
            storeIndex: getStoreIndex(order),
            storeName: order.channel?.type_code || null,
            channel: order.channel?.name?.includes('Walmart') ? 'Walmart' : 'Amazon',
            sku,
            productName: order.allocations?.[0]?.line_items?.[0]?.product_title || null,
            shipDate,
            edd,
            transitDays,
            plannedCarrier: ctx.carrier,
            plannedService: ctx.service,
            destZip: destLoc.zip,
            destCity: destLoc.city,
            destState: destLoc.state,
            destLat: destLoc.lat,
            destLon: destLoc.lon,
            originTempF: originDay?.tempMaxF,
            originFeelsLikeF: originDay?.feelsLikeMaxF,
            originTempMaxF: originDay?.tempMaxF,
            originNormalF: originNormal,
            originAnomalyF: ctx.originAnomalyF,
            originWeatherDesc: originDay?.weatherDesc,
            destTempF: destDay?.tempMaxF,
            destFeelsLikeF: destDay?.feelsLikeMaxF,
            destTempMaxF: destDay?.tempMaxF,
            destNormalF: destNormal,
            destAnomalyF: ctx.destAnomalyF,
            destWeatherDesc: destDay?.weatherDesc,
            riskLevel: evalResult.riskLevel,
            riskScore: evalResult.riskScore,
            triggeredRules: JSON.stringify(evalResult.triggeredRules),
            recommendations: JSON.stringify(recommendations),
            status: 'pending',
          },
          update: {
            // Re-evaluate if shipDate same — update weather and recommendations
            originTempF: originDay?.tempMaxF,
            destTempF: destDay?.tempMaxF,
            originAnomalyF: ctx.originAnomalyF,
            destAnomalyF: ctx.destAnomalyF,
            riskLevel: evalResult.riskLevel,
            riskScore: evalResult.riskScore,
            triggeredRules: JSON.stringify(evalResult.triggeredRules),
            recommendations: JSON.stringify(recommendations),
          },
        });
        
        if (upserted.createdAt.getTime() === upserted.updatedAt.getTime()) {
          result.alertsCreated++;
        } else {
          result.alertsUpdated++;
        }
      } catch (err: any) {
        result.errors++;
        result.errorDetails.push(`Order ${order.number}: ${err.message}`);
      }
    }
  } catch (err: any) {
    result.errors++;
    result.errorDetails.push(`Pipeline fatal: ${err.message}`);
  }
  
  result.durationMs = Date.now() - start;
  return result;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function getStoreIndex(order: any): number | null {
  // Veeqo channel naming — extract store index from channel name
  // Adapt to actual Veeqo data structure
  const name = order.channel?.name || '';
  const match = name.match(/Store\s*(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}
```

⚠️ **ВАЖНО:** Перед написанием этого файла **изучи реальную структуру данных Veeqo** из `src/lib/veeqo/`. Поля могут отличаться (`deliver_to.zip` vs `shipping_address.zip`, `preferred_courier` vs `courier_code` и т.п.). Адаптируй маппинг под существующие паттерны проекта.

---

## 📨 STEP 8: Morning Summary

Файл: `src/lib/frozen-analytics/morning-summary.ts`

```typescript
import { prisma } from '@/lib/prisma';

export interface MorningSummary {
  date: string;
  total: number;
  byLevel: { ok: number; low: number; medium: number; high: number; critical: number };
  topAlerts: Array<{
    orderId: string;
    sku: string;
    destCity: string;
    destState: string;
    riskLevel: string;
    topRecommendation: string;
  }>;
  telegramMessage: string;
}

export async function buildMorningSummary(): Promise<MorningSummary> {
  const today = new Date().toISOString().slice(0, 10);
  
  const alerts = await prisma.frozenRiskAlert.findMany({
    where: {
      shipDate: { gte: today },
      status: 'pending',
      riskLevel: { in: ['medium', 'high', 'critical'] },
    },
    orderBy: [{ riskLevel: 'desc' }, { shipDate: 'asc' }],
    take: 50,
  });
  
  const byLevel = { ok: 0, low: 0, medium: 0, high: 0, critical: 0 };
  alerts.forEach(a => byLevel[a.riskLevel as keyof typeof byLevel]++);
  
  const topAlerts = alerts.slice(0, 5).map(a => ({
    orderId: a.orderId,
    sku: a.sku,
    destCity: a.destCity || 'Unknown',
    destState: a.destState || '',
    riskLevel: a.riskLevel,
    topRecommendation: JSON.parse(a.recommendations)[0] || '',
  }));
  
  // Build Telegram message
  const emoji = { critical: '🔴', high: '🟠', medium: '🟡' };
  const lines = [
    `🌡️ <b>Frozen Risk — ${today}</b>`,
    `Всего алертов: ${alerts.length}`,
    `${emoji.critical} CRITICAL: ${byLevel.critical}`,
    `${emoji.high} HIGH: ${byLevel.high}`,
    `${emoji.medium} MEDIUM: ${byLevel.medium}`,
    '',
    'Топ 5:',
  ];
  
  topAlerts.forEach(a => {
    lines.push(`• ${emoji[a.riskLevel as keyof typeof emoji] || '⚠️'} ${a.orderId} → ${a.destCity}, ${a.destState}`);
    lines.push(`  ${a.topRecommendation}`);
  });
  
  lines.push('');
  lines.push('Открыть: /frozen-analytics');
  
  return {
    date: today,
    total: alerts.length,
    byLevel,
    topAlerts,
    telegramMessage: lines.join('\n'),
  };
}
```

---

## 🌐 STEP 9-12: API Routes

### `src/app/api/frozen/run-analysis/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { runFrozenAnalysisPipeline } from '@/lib/frozen-analytics/pipeline';
import { verifyApiKey } from '@/lib/auth/api-key'; // use existing External API Auth middleware

export async function POST(req: NextRequest) {
  if (!verifyApiKey(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
  try {
    const result = await runFrozenAnalysisPipeline();
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// Vercel: function timeout — adjust if needed
export const maxDuration = 300; // 5 minutes
```

### `src/app/api/frozen/morning-summary/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { buildMorningSummary } from '@/lib/frozen-analytics/morning-summary';
import { verifyApiKey } from '@/lib/auth/api-key';

export async function GET(req: NextRequest) {
  if (!verifyApiKey(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const summary = await buildMorningSummary();
  return NextResponse.json(summary);
}
```

### `src/app/api/frozen/alerts/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const status = url.searchParams.get('status') || undefined;
  const minLevel = url.searchParams.get('min_level');
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);
  
  const levelFilter = minLevel ? {
    in: ['ok', 'low', 'medium', 'high', 'critical'].slice(
      ['ok', 'low', 'medium', 'high', 'critical'].indexOf(minLevel)
    )
  } : undefined;
  
  const alerts = await prisma.frozenRiskAlert.findMany({
    where: { status, ...(levelFilter && { riskLevel: levelFilter }) },
    orderBy: [{ shipDate: 'asc' }, { riskScore: 'desc' }],
    take: limit,
  });
  
  return NextResponse.json({
    alerts: alerts.map(a => ({
      ...a,
      triggeredRules: JSON.parse(a.triggeredRules),
      recommendations: JSON.parse(a.recommendations),
    })),
  });
}
```

### `src/app/api/frozen/alerts/[id]/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  const { status, userNotes, shippingChoiceFollowed, appliedBy } = body;
  
  const updated = await prisma.frozenRiskAlert.update({
    where: { id: params.id },
    data: {
      ...(status && { status, appliedAt: status === 'applied' ? new Date() : undefined }),
      ...(userNotes !== undefined && { userNotes }),
      ...(shippingChoiceFollowed !== undefined && { shippingChoiceFollowed }),
      ...(appliedBy && { appliedBy }),
    },
  });
  
  return NextResponse.json(updated);
}
```

### `src/app/api/frozen/rules/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  const rules = await prisma.frozenRule.findMany({
    orderBy: [{ ruleType: 'desc' }, { ruleCode: 'asc' }],
  });
  return NextResponse.json({ rules });
}

export async function PUT(req: NextRequest) {
  const { id, ...data } = await req.json();
  const updated = await prisma.frozenRule.update({ where: { id }, data });
  return NextResponse.json(updated);
}
```

### `src/app/api/frozen/patterns/route.ts`

Метрики эффективности за последние 30 дней:

```typescript
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  
  const allAlerts = await prisma.frozenRiskAlert.findMany({
    where: { createdAt: { gte: thirtyDaysAgo } },
    select: { riskLevel: true, status: true, resultedInComplaint: true, sku: true, destState: true },
  });
  
  // Calculate metrics
  const total = allAlerts.length;
  const applied = allAlerts.filter(a => a.status === 'applied').length;
  const truePositives = allAlerts.filter(a => a.resultedInComplaint === true).length;
  const falsePositives = allAlerts.filter(a => a.resultedInComplaint === false && a.status === 'applied').length;
  
  // Missed cases — frozen incidents without linked alert
  const missedCases = await prisma.frozenIncident.count({
    where: { createdAt: { gte: thirtyDaysAgo }, linkedAlertId: null },
  });
  
  // Top SKUs and states
  const skuCounts = new Map<string, number>();
  const stateCounts = new Map<string, number>();
  allAlerts.forEach(a => {
    skuCounts.set(a.sku, (skuCounts.get(a.sku) || 0) + 1);
    if (a.destState) stateCounts.set(a.destState, (stateCounts.get(a.destState) || 0) + 1);
  });
  
  return NextResponse.json({
    period: { from: thirtyDaysAgo.toISOString().slice(0, 10), days: 30 },
    total,
    appliedCount: applied,
    appliedRate: total > 0 ? (applied / total) : 0,
    truePositives,
    falsePositives,
    missedCases,
    detectionRate: (truePositives + missedCases) > 0 ? truePositives / (truePositives + missedCases) : null,
    topSkus: [...skuCounts.entries()].sort((a,b) => b[1]-a[1]).slice(0, 10),
    topStates: [...stateCounts.entries()].sort((a,b) => b[1]-a[1]).slice(0, 10),
  });
}
```

---

## 🎨 STEP 13-15: UI

### Главная страница `src/app/frozen-analytics/page.tsx`

```typescript
'use client';
import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import TodaysRiskTab from '@/components/frozen-analytics/TodaysRiskTab';
import IncidentsLogTab from '@/components/frozen-analytics/IncidentsLogTab';
import SkuRiskTab from '@/components/frozen-analytics/SkuRiskTab';
import PatternsDashboard from '@/components/frozen-analytics/PatternsDashboard';

export default function FrozenAnalyticsPage() {
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--ink)' }}>
          🌡️ Frozen Analytics
        </h1>
      </div>
      
      <Tabs defaultValue="today">
        <TabsList>
          <TabsTrigger value="today">🔮 Today's Risk</TabsTrigger>
          <TabsTrigger value="incidents">📋 Incidents Log</TabsTrigger>
          <TabsTrigger value="sku">📦 SKU Risk</TabsTrigger>
          <TabsTrigger value="patterns">📊 Patterns</TabsTrigger>
        </TabsList>
        
        <TabsContent value="today"><TodaysRiskTab /></TabsContent>
        <TabsContent value="incidents"><IncidentsLogTab /></TabsContent>
        <TabsContent value="sku"><SkuRiskTab /></TabsContent>
        <TabsContent value="patterns"><PatternsDashboard /></TabsContent>
      </Tabs>
    </div>
  );
}
```

### `src/components/frozen-analytics/TodaysRiskTab.tsx`

```typescript
'use client';
import { useEffect, useState } from 'react';
import RiskAlertCard from './RiskAlertCard';

export default function TodaysRiskTab() {
  const [alerts, setAlerts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    fetch('/api/frozen/alerts?status=pending&min_level=low')
      .then(r => r.json())
      .then(d => { setAlerts(d.alerts || []); setLoading(false); });
  }, []);
  
  const runAnalysis = async () => {
    setLoading(true);
    await fetch('/api/frozen/run-analysis', { 
      method: 'POST', 
      headers: { 'Authorization': `Bearer ${process.env.NEXT_PUBLIC_API_KEY}` } 
    });
    const r = await fetch('/api/frozen/alerts?status=pending&min_level=low').then(r => r.json());
    setAlerts(r.alerts || []);
    setLoading(false);
  };
  
  if (loading) return <div className="p-6">Загрузка...</div>;
  
  const grouped = {
    critical: alerts.filter(a => a.riskLevel === 'critical'),
    high: alerts.filter(a => a.riskLevel === 'high'),
    medium: alerts.filter(a => a.riskLevel === 'medium'),
    low: alerts.filter(a => a.riskLevel === 'low'),
  };
  
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-4 text-sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
          <span>🔴 Critical: <b>{grouped.critical.length}</b></span>
          <span>🟠 High: <b>{grouped.high.length}</b></span>
          <span>🟡 Medium: <b>{grouped.medium.length}</b></span>
        </div>
        <button onClick={runAnalysis} className="btn-primary">
          🔄 Run analysis now
        </button>
      </div>
      
      {alerts.length === 0 && (
        <div className="text-center py-12 text-sm opacity-60">
          Нет заказов с риском на ближайшие 3 дня. 🟢 Всё спокойно.
        </div>
      )}
      
      {(['critical', 'high', 'medium', 'low'] as const).map(level => (
        grouped[level].length > 0 && (
          <div key={level}>
            <h3 className="text-sm font-medium mb-2 capitalize">{level} ({grouped[level].length})</h3>
            <div className="space-y-2">
              {grouped[level].map(alert => (
                <RiskAlertCard key={alert.id} alert={alert} onUpdate={(updated) => {
                  setAlerts(prev => prev.map(a => a.id === updated.id ? updated : a));
                }} />
              ))}
            </div>
          </div>
        )
      ))}
    </div>
  );
}
```

### `src/components/frozen-analytics/RiskAlertCard.tsx`

Карточка с погодой, рекомендациями, действиями (Apply / Ignore / Notes). Используй паттерны существующих карточек из проекта (например из `src/components/customer-hub/`). Цвет фона зависит от `riskLevel` (см. таблицу в начале промпта).

### `src/components/frozen-analytics/PatternsDashboard.tsx`

Метрики за 30 дней — total / applied rate / detection rate / missed cases / topSkus / topStates. Использовать карточки и простые графики (можно `recharts` если уже подключён, или просто HTML-таблицы).

### `src/components/frozen-analytics/IncidentsLogTab.tsx` и `SkuRiskTab.tsx`

Если эти компоненты уже частично реализованы в v1.0 — проверь и убедись, что они работают с обновлённой моделью `FrozenIncident` (добавлено поле `linkedAlertId`). Если их нет — создай минимальные таблицы.

---

## 🔄 STEP 20-21: CS Hub Integration (Learning Loop)

В `src/app/api/cs/analyze/route.ts` (или там где создаётся `FrozenIncident` при категории C3/Frozen thawed):

```typescript
// После создания FrozenIncident:
if (savedIncident && savedIncident.category === 'C3' /* или whatever frozen category */) {
  // Найти связанный alert
  const alert = await prisma.frozenRiskAlert.findFirst({
    where: { orderId: savedIncident.orderId },
    orderBy: { createdAt: 'desc' },
  });
  
  if (alert) {
    await prisma.frozenRiskAlert.update({
      where: { id: alert.id },
      data: { 
        resultedInComplaint: true, 
        linkedIncidentId: savedIncident.id,
        status: 'resolved',
      },
    });
    await prisma.frozenIncident.update({
      where: { id: savedIncident.id },
      data: { linkedAlertId: alert.id },
    });
  }
}
```

Также добавь cron-задачу (раз в день) для пометки `resultedInComplaint = false` у alerts, которые были применены/проигнорированы и прошли 7 дней без жалобы — это даёт нам метрику "true negative".

---

## 🤖 STEP 22: n8n Workflows

Создай два JSON-файла в `docs/n8n-workflows/`:

### `frozen-nightly-analysis.json`

Структура workflow:
1. **Cron Node:** расписание `0 3 * * *` (03:00 каждый день), timezone America/New_York
2. **HTTP Request Node:** POST на `https://{NEXT_JS_URL}/api/frozen/run-analysis`, header `Authorization: Bearer {API_KEY}`
3. **IF Node:** проверка `{{$json.errors}} > 0`
4. **Telegram Node** (TRUE branch): отправить сообщение `🚨 Frozen analysis failed: {{$json.errorDetails}}`

### `frozen-morning-summary.json`

1. **Cron Node:** `0 7 * * *` (07:00), America/New_York
2. **HTTP Request Node:** GET `/api/frozen/morning-summary`
3. **IF Node:** `{{$json.total}} > 0`
4. **Telegram Node:** отправить `{{$json.telegramMessage}}` (parse_mode HTML)

Создай также `docs/n8n-workflows/README.md` с инструкцией как импортировать эти workflow в n8n UI (Settings → Import from File).

---

## 📚 STEP 23: Wiki Update

После реализации обнови:

1. **`docs/wiki/frozen-analytics.md`** — измени статус с "в разработке" на "реализован Phase 1+2". Добавь раздел "Текущее состояние" с описанием что работает.

2. **`docs/wiki/index.md`** — обнови дату последнего обновления и добавь в changelog: `Frozen Analytics v2.0 Phase 1+2 реализован — проактивный прогноз через Open-Meteo + n8n cron`.

3. **`docs/wiki/CONNECTIONS.md`** — обнови блок Frozen Analytics (уже подготовлен в спецификации):
   - `← Veeqo API, Weather/Geocoding (Open-Meteo), Frozen/Dry классификация, Shipment Monitor`
   - `→ Dashboard (счётчик заказов с риском)`
   - `⇔ Shipping Labels (баннер с рекомендацией Phase 3), Customer Hub (цикл обучения), n8n Автоматизация (ночной cron), Telegram (утренний summary), Frozen shipping rules`

4. **`docs/wiki/n8n-automation.md`** — добавь упоминание двух новых workflow.

---

## 🧪 STEP 25: Тестирование

После завершения реализации:

1. Запусти `npm run dev`
2. Открой `/frozen-analytics` — должны отображаться 4 таба
3. На табе "Today's Risk" нажми **"🔄 Run analysis now"** — должен запуститься pipeline
4. Проверь, что в БД появились `FrozenRiskAlert` записи (можно через Prisma Studio: `npx prisma studio`)
5. Открой одну из карточек, нажми "Apply" → проверь, что `status` обновился на `applied`
6. Открой таб "Patterns" — должны быть базовые метрики
7. Проверь n8n: импортируй `frozen-nightly-analysis.json`, запусти manually — должен прийти ответ от API

---

## ✅ STEP 26: Git Commit

После завершения и тестирования:

```bash
git add .
git commit -m "feat(frozen-analytics): proactive risk prediction v2.0

- Add FrozenRiskAlert and FrozenRule Prisma models
- Implement Open-Meteo forecast + climate normals pipeline
- Add Rules Engine with R1-R6 base rules and M1-M4 modifiers
- UI: Today's Risk tab with action cards
- UI: Patterns & Learning tab with effectiveness metrics
- Integrate CS Hub for learning loop (linkedAlertId)
- Add n8n workflows for nightly cron (03:00 EST) and morning summary (07:00 EST)
- Geocoding via uszipcode-typed (offline)

Spec: docs/FROZEN_ANALYTICS_v2_0.md
Wiki: docs/wiki/frozen-analytics.md"
git push
```

---

## 🚨 КРИТИЧНЫЕ МОМЕНТЫ ВНИМАНИЯ

1. **НЕ ставить cron в коде Next.js** — только n8n workflow. Vercel не держит постоянные процессы.

2. **Сначала прочитать существующий `src/lib/veeqo/` и `src/lib/frozen-dry-classification.ts`** — там есть рабочие функции, которые нужно переиспользовать. НЕ создавай дублирующий Veeqo-клиент.

3. **Поля Veeqo могут отличаться от моего примера** — `deliver_to.zip`, `expected_dispatch_date`, `preferred_courier` это предположения. Проверь реальные поля в проекте и адаптируй маппинг в `pipeline.ts`.

4. **Climate API может падать** — это не критично. Обработай как warning, оставь `originAnomalyF/destAnomalyF` как `null`, остальное должно работать.

5. **Rate limiting Open-Meteo:** ~10000 запросов в день free tier. При 100 frozen-заказах в день × 2 запроса (forecast + climate) × 4 endpoints = безопасно. Но не зацикливай вызовы без задержки на тестах.

6. **Дизайн:** строго следуй Salutem Design System. Открой существующие компоненты (`src/components/customer-hub/`, `src/components/shipping/`) для понимания паттернов — карточки, кнопки, отступы.

7. **Salutem Design System токены** — все цвета через CSS variables (`var(--ink)`, `var(--green-cream)`). Не используй Tailwind цвета напрямую (типа `text-gray-900`) — это нарушение дизайн-системы (см. legacy-rebrand-2026-05).

8. **Обновление чеклиста `docs/dev-log/frozen-v2-progress.md`** — обязательно после каждого шага. Это инструмент для отслеживания на случай прерывания.

---

## 🔚 ПОСЛЕ ЗАВЕРШЕНИЯ

Сообщи Vladimir в чате:
- Какие шаги выполнены (со ссылкой на progress.md)
- Какие могли потребовать ручного вмешательства (например структура Veeqo-полей)
- Готовы ли n8n workflow к импорту
- Что планировать в Phase 3 (Shipping Labels banner) и Phase 4 (UI rules editor)

---

*Промпт: v1.0 — 2026-05-15*
*Для: Claude Code в VS Code*
*Спецификация: docs/FROZEN_ANALYTICS_v2_0.md*
