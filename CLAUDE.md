# CLAUDE.md — Salutem Solutions Control Center

## 🎯 О ПРОЕКТЕ

Ты строишь **Salutem Solutions Control Center** — веб-платформу для управления e-commerce бизнесом на маркетплейсах (Amazon, Walmart). Один интерфейс для управления заказами, доставкой, клиентским сервисом и аналитикой.

**Владелец:** Владимир (не разработчик, базовый уровень). Объясняй технические решения простыми словами. Код должен быть чистым, с комментариями.

---

## 🏗️ ТЕХНИЧЕСКИЙ СТЕК

```
Frontend:  Next.js 14+ (App Router) + React 18 + TypeScript
Styling:   Tailwind CSS + shadcn/ui components
Backend:   Next.js API Routes (app/api/)
Database:  SQLite (через Prisma ORM) — позже можно мигрировать на PostgreSQL
AI:        Anthropic Claude API (claude-sonnet-4-20250514)
Auth:      Пока нет (добавим позже)
```

### Внешние API и сервисы:

| Сервис | Назначение | Auth |
|--------|-----------|------|
| **Veeqo** | Заказы, shipping rates, покупка этикеток | `x-api-key: Vqt/5554f1df2e6b934f5e6e90d2f3dde79e` |
| **Sellbrite** | Product listings, bulk edit | Basic Auth: token `1e8b87b4-39bb-4bf6-8aac-15d2ac2c974c`, secret `2a2c045898d23447d2fdb4db0485654a` |
| **Sellerboard** | Sales analytics (CSV фиды по URL) | URL-фиды (настраиваются в sellerboard Settings → Automation) |
| **Google Drive** | Хранение shipping label PDFs | OAuth2 (kuzy.vladimir@gmail.com) |
| **Google Sheets** | SKU Database v2 | Sheet ID: `1H-bx0iZ_oL0i0CFbHN_QbfXzkGJC_f_hV90s-V6cqzY` |
| **Telegram Bot** | Уведомления Владимиру | Chat ID: `486456466` |
| **Claude API** | AI-анализ скриншотов для Customer Service | Anthropic API key (в .env) |

### Структура .env:
```env
# Veeqo
VEEQO_API_KEY=Vqt/5554f1df2e6b934f5e6e90d2f3dde79e
VEEQO_BASE_URL=https://api.veeqo.com

# Sellbrite
SELLBRITE_ACCOUNT_TOKEN=1e8b87b4-39bb-4bf6-8aac-15d2ac2c974c
SELLBRITE_SECRET_KEY=2a2c045898d23447d2fdb4db0485654a
SELLBRITE_BASE_URL=https://api.sellbrite.com/v1

# Google
GOOGLE_SHEETS_ID=1H-bx0iZ_oL0i0CFbHN_QbfXzkGJC_f_hV90s-V6cqzY
GOOGLE_DRIVE_ROOT_FOLDER=1vq_nT4g3F8i5MDiaKQymsPuEI0itTtVt

# Telegram
TELEGRAM_BOT_TOKEN=<bot_token>
TELEGRAM_CHAT_ID=486456466

# Claude AI
ANTHROPIC_API_KEY=<api_key>

# App
DATABASE_URL=file:./dev.db
NEXTAUTH_SECRET=<random_secret>
```

---

## 📁 СТРУКТУРА ПРОЕКТА

```
ss-control-center/
├── CLAUDE.md                    # Этот файл
├── docs/
│   ├── CS_ALGORITHM_v1.1.md     # Алгоритм Customer Service
│   ├── MASTER_PROMPT_v3.1.md    # Алгоритм Shipping Labels
│   └── N8N_ARCHITECTURE_v1.1.md # Архитектура n8n (справка)
├── prisma/
│   └── schema.prisma            # Схема базы данных
├── src/
│   ├── app/
│   │   ├── layout.tsx           # Root layout (sidebar + header)
│   │   ├── page.tsx             # Dashboard (главная)
│   │   ├── shipping/
│   │   │   └── page.tsx         # Shipping Labels модуль
│   │   ├── customer-service/
│   │   │   └── page.tsx         # Customer Service модуль
│   │   ├── listings/
│   │   │   └── page.tsx         # Product Listings (фаза 2)
│   │   ├── analytics/
│   │   │   └── page.tsx         # Sales Analytics (фаза 2)
│   │   ├── suppliers/
│   │   │   └── page.tsx         # Supplier Management (фаза 3)
│   │   ├── promotions/
│   │   │   └── page.tsx         # Promotions (фаза 3)
│   │   ├── settings/
│   │   │   └── page.tsx         # Settings & Config
│   │   └── api/
│   │       ├── veeqo/           # Veeqo API proxy
│   │       ├── shipping/        # Shipping plan logic
│   │       ├── cs/              # Customer Service AI
│   │       ├── sellbrite/       # Sellbrite API proxy
│   │       ├── analytics/       # Sellerboard data
│   │       └── external/        # External API (для Claude-агента, n8n)
│   │           ├── status/
│   │           ├── shipping/
│   │           ├── cs/
│   │           ├── orders/
│   │           └── mcp/         # MCP Server (фаза 2)
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx      # Навигация
│   │   │   └── Header.tsx       # Шапка
│   │   ├── shipping/            # Компоненты для shipping
│   │   ├── cs/                  # Компоненты для CS
│   │   ├── dashboard/           # Компоненты для dashboard
│   │   └── ui/                  # shadcn/ui компоненты
│   ├── lib/
│   │   ├── veeqo.ts             # Veeqo API client
│   │   ├── sellbrite.ts         # Sellbrite API client
│   │   ├── claude.ts            # Claude AI client
│   │   ├── google-drive.ts      # Google Drive client
│   │   ├── google-sheets.ts     # Google Sheets client
│   │   ├── telegram.ts          # Telegram notifications
│   │   └── utils.ts             # Утилиты (timezone, dates)
│   └── types/
│       └── index.ts             # TypeScript типы
├── public/
├── package.json
├── tailwind.config.ts
├── tsconfig.json
└── next.config.js
```

---

## 🎨 ДИЗАЙН И UI

### Общий стиль:
- **Светлая тема** (white background, subtle gray borders)
- Левая **sidebar** с иконками модулей (collapsible)
- Верхний **header** с названием текущего модуля + уведомления
- **shadcn/ui** компоненты для consistency
- Responsive, но основной фокус — desktop (1280px+)
- Язык интерфейса: **English**

### Sidebar навигация:
```
📊 Dashboard
🚚 Shipping Labels
💬 Customer Service
🏷️ Product Listings    (Phase 2 — disabled)
💰 Sales Analytics     (Phase 2 — disabled)
🛒 Suppliers           (Phase 3 — disabled)
📢 Promotions          (Phase 3 — disabled)
🔄 Integrations        (Phase 2 — disabled)
⚙️ Settings
```

Модули Phase 2/3 показываются в sidebar но неактивны (grayed out, с badge "Coming Soon").

### Цветовая палитра:
- Primary: `#2563EB` (blue-600)
- Success: `#16A34A` (green-600)
- Warning: `#F59E0B` (amber-500)
- Danger: `#DC2626` (red-600)
- Background: `#FFFFFF`
- Sidebar bg: `#F8FAFC` (slate-50)
- Text: `#1E293B` (slate-800)
- Muted text: `#64748B` (slate-500)

---

## 📦 ФАЗА 1 — ТРИ МОДУЛЯ

### МОДУЛЬ 1: CUSTOMER SERVICE (приоритет #1)

**Путь:** `/customer-service`

**Что делает:** Владимир загружает скриншот кейса с Amazon/Walmart → AI анализирует → выдаёт готовый ответ клиенту.

**Интерфейс:**

```
┌─────────────────────────────────────────────────────────┐
│  💬 Customer Service                                     │
│                                                          │
│  ┌──────────────────────┐  ┌──────────────────────────┐ │
│  │  📸 Upload Screenshot │  │  📊 Analysis              │ │
│  │                       │  │                           │ │
│  │  [Drag & drop zone]  │  │  Channel: Amazon          │ │
│  │                       │  │  Store: [auto-detected]   │ │
│  │  или                  │  │  Order: 123-456-789       │ │
│  │  [Paste Ctrl+V]      │  │  Customer: John Smith     │ │
│  │                       │  │  Product: Jimmy Dean 12ct │ │
│  │                       │  │  Type: 🧊 Frozen          │ │
│  │                       │  │  Category: C3 - Thawed    │ │
│  │                       │  │  Priority: 🔴 HIGH        │ │
│  └──────────────────────┘  │  Language: English         │ │
│                             └──────────────────────────┘ │
│                                                          │
│  ┌──────────────────────────────────────────────────────┐│
│  │  💬 Recommended Response                              ││
│  │                                                       ││
│  │  Dear John,                                           ││
│  │                                                       ││
│  │  I'm so sorry to hear that your frozen item arrived   ││
│  │  thawed...                                            ││
│  │                                                       ││
│  │  Best regards,                                        ││
│  │  [Store Name]                                         ││
│  └──────────────────────────────────────────────────────┘│
│                                                          │
│  [📋 Copy Response]  [✏️ Edit]  [🔄 Regenerate]         │
│                                                          │
│  🎯 Action: REPLACEMENT  ⏰ Respond within 12 hours     │
│  ⚠️ Internal: File SAFE-T claim within 30 days          │
└─────────────────────────────────────────────────────────┘
```

**Логика API route (`/api/cs/analyze`):**
1. Принять изображение (base64)
2. Отправить в Claude API с промптом из `docs/CS_ALGORITHM_v1.1.md`
3. Claude анализирует скриншот и возвращает JSON:
```json
{
  "channel": "Amazon",
  "store": "Store Name",
  "orderId": "123-456-789",
  "customerName": "John Smith",
  "product": "Jimmy Dean Sausage 12ct",
  "productType": "Frozen",
  "category": "C3",
  "categoryName": "Frozen item arrived thawed",
  "priority": "HIGH",
  "language": "English",
  "branch": "A",
  "branchName": "Carrier fault — Buy Shipping Protection",
  "response": "Dear John,...",
  "action": "REPLACEMENT",
  "urgency": "Respond within 12 hours",
  "internalNotes": "File SAFE-T claim within 30 days"
}
```
4. Отобразить результат в интерфейсе
5. Кнопка "Copy" копирует только текст ответа в clipboard

**Claude API prompt для анализа скриншота:**
```
Ты — AI-агент Customer Service для Salutem Solutions. 
Проанализируй скриншот кейса с маркетплейса.

[Вставить полный текст CS_ALGORITHM_v1.1.md]

Ответь СТРОГО в JSON формате:
{
  "channel": "Amazon" или "Walmart",
  "store": "название магазина со скриншота",
  "orderId": "номер заказа",
  "customerName": "имя клиента",
  "product": "название товара",
  "productType": "Frozen" или "Dry",
  "category": "C1-C10",
  "categoryName": "описание категории",
  "priority": "LOW/MEDIUM/HIGH/CRITICAL",
  "language": "English" или "Spanish",
  "branch": "A" или "B" (для C3),
  "branchName": "описание ветки",
  "response": "готовый текст ответа клиенту",
  "action": "REPLACEMENT/REFUND/ESCALATE/INFO",
  "urgency": "текст срочности",
  "internalNotes": "внутренние заметки для Владимира"
}
```

**Фичи:**
- Drag & drop загрузка скриншота
- Paste из clipboard (Ctrl+V)
- История обработанных кейсов (сохранять в БД)
- Фильтр истории по каналу, категории, дате
- Badge с количеством кейсов за сегодня

---

### МОДУЛЬ 2: SHIPPING LABELS (приоритет #2)

**Путь:** `/shipping`

**Что делает:** Формирует Shipping Plan на текущий день, показывает для одобрения, покупает этикетки одной кнопкой.

**Интерфейс:**

```
┌─────────────────────────────────────────────────────────┐
│  🚚 Shipping Labels                        [🔄 Refresh] │
│                                                          │
│  📅 Today: Monday, April 7, 2026 (ET)                   │
│  Status: ⏳ Plan ready — 12 orders / 2 need attention   │
│                                                          │
│  ┌──────────────────────────────────────────────────────┐│
│  │  # | Order  | Channel | Product      | Type | ...   ││
│  │  1 | 12345  | Amazon  | Jimmy Dean   | 🧊   | ...   ││
│  │  2 | 12346  | Walmart | Tyson Wings  | 📦   | ...   ││
│  │  ...                                                 ││
│  └──────────────────────────────────────────────────────┘│
│                                                          │
│  [📋 Generate Plan]  [✅ Buy All Labels]  [📥 Export]   │
│                                                          │
│  Legend: 🧊 Frozen  📦 Dry  ✅ Bought  ❌ Needs Review  │
└─────────────────────────────────────────────────────────┘
```

**Логика (из MASTER_PROMPT_v3.1.md):**

**API route `/api/shipping/plan` (GET):**
1. Fetch все заказы из Veeqo (`GET /orders?status=awaiting_fulfillment&page_size=100`)
2. Пагинация: page=1,2,3... пока не пустой
3. Фильтры:
   - Тег "Placed" есть на заказе
   - `dispatch_date` (конвертировать UTC→UTC-7) = сегодня (America/New_York)
   - channel = Amazon или Walmart
   - Walmart + weekend → пропустить
4. Для каждого заказа:
   - `GET /products/{product_id}` → определить Frozen/Dry по тегам
   - Lookup SKU в Google Sheets (SKU Database v2)
   - `GET /shipping/rates/{allocation_id}` → получить ставки
   - Применить алгоритм выбора (из MASTER_PROMPT_v3.1.md):
     - DRY: самый дешёвый rate где EDD ≤ Delivery By, UPS приоритет при ≤10%
     - FROZEN: EDD ≤ 3 кал. дня + EDD ≤ Delivery By
   - Проверка бюджета
5. Вернуть план как JSON массив

**API route `/api/shipping/buy` (POST):**
1. Принять массив одобренных строк плана
2. Для каждой:
   - Проверить дубль (employee_notes не содержит "Label Purchased")
   - `POST /shipping/shipments` → купить этикетку
   - Скачать PDF
   - Загрузить в Google Drive (структура папок из MASTER_PROMPT)
   - `PUT /orders/{id}` → добавить employee note "✅ Label Purchased: ..."
   - Обновить статус строки
3. Отправить итог в Telegram

**ВАЖНО — timezone логика:**
```typescript
// "Сегодня" = по America/New_York
const today = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

// Все даты из Veeqo конвертировать UTC → UTC-7 (Pacific)
function veeqoDateToLocal(utcDate: string): string {
  const d = new Date(utcDate);
  d.setHours(d.getHours() - 7);
  return d.toISOString().split('T')[0];
}
```

**ВАЖНО — покупка этикетки (payload):**
```json
{
  "carrier": "amazon_shipping_v2",
  "shipment": {
    "allocation_id": "...",
    "carrier_id": "...",
    "remote_shipment_id": "...",
    "service_type": "...",
    "notify_customer": false,
    "sub_carrier_id": "UPS",
    "service_carrier": "ups",
    "payment_method_id": null,
    "total_net_charge": "...",
    "base_rate": "...",
    "value_added_service__VAS_GROUP_ID_CONFIRMATION": "NO_CONFIRMATION"
  }
}
```

**ВАЖНО — VAS поле обязательно!** Без него ошибка для UPS/USPS.

**ВАЖНО — формат имени PDF файла:**
```
(EDD Apr 07 | DL Apr 09) Product Name -- Qty.pdf
```

**ВАЖНО — структура папок Google Drive:**
```
Shipping Labels/
  04 April/
    07/          ← день ФАКТИЧЕСКОЙ отгрузки
      Amazon/
        (EDD ...) Product -- Qty.pdf
      Walmart/
```

---

### МОДУЛЬ 3: DASHBOARD (приоритет #3)

**Путь:** `/` (главная страница)

**Что показывает:**
- Количество заказов awaiting_fulfillment (из Veeqo)
- Заказы на сегодня с Ship By = today
- Сколько этикеток куплено / осталось
- Количество открытых CS кейсов
- Быстрые ссылки: "Generate Shipping Plan", "Open CS"

**Интерфейс:**

```
┌─────────────────────────────────────────────────────────┐
│  📊 Dashboard                   Monday, April 7, 2026   │
│                                                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │ Orders   │ │ Ship     │ │ Labels   │ │ CS Cases │   │
│  │ Today    │ │ Today    │ │ Bought   │ │ Open     │   │
│  │   24     │ │   18     │ │  12/18   │ │    3     │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘   │
│                                                          │
│  📋 Today's Orders                        [View All →]  │
│  ┌──────────────────────────────────────────────────────┐│
│  │ # | Order | Channel | Product | Status | Ship By    ││
│  │ ...                                                  ││
│  └──────────────────────────────────────────────────────┘│
│                                                          │
│  ⚡ Quick Actions                                        │
│  [🚚 Generate Shipping Plan]  [💬 Customer Service]     │
└─────────────────────────────────────────────────────────┘
```

---

## ⚙️ SETTINGS

**Путь:** `/settings`

Страница для конфигурации:
- **Stores:** Список магазинов (название, канал, подпись для CS) — CRUD
- **API Keys:** Отображение статуса подключений (Veeqo ✅, Sellbrite ✅, etc.)
- **Notifications:** Telegram chat ID, включить/выключить уведомления
- **SKU Database:** Ссылка на Google Sheets + кнопка "Test Connection"
- **External API:** Генерация API-токена для внешнего доступа (Claude-агент, n8n, etc.)

---

## 🔌 EXTERNAL API (для Claude-агента и автоматизаций)

Control Center предоставляет REST API для внешних систем (Claude-агент, n8n, Telegram-бот).

**Аутентификация:** Bearer token в заголовке
```
Authorization: Bearer <SSCC_API_TOKEN>
```
Token генерируется в Settings → External API. Хранится в `.env` как `SSCC_API_TOKEN`.

### Endpoints:

#### Dashboard
```
GET /api/external/status
→ Общий статус: кол-во заказов, этикеток, открытых CS кейсов
```

#### Shipping Labels
```
POST /api/external/shipping/plan
→ Запустить генерацию Shipping Plan на сегодня
→ Response: { planId, orders: [...], readyCount, stopCount }

GET /api/external/shipping/plan/:id
→ Получить план по ID

POST /api/external/shipping/buy
→ Body: { planId } или { planId, orderIds: [...] }
→ Купить все этикетки (или выборочно) по плану
→ Response: { bought: [...], errors: [...] }

GET /api/external/shipping/history?date=2026-04-07
→ История купленных этикеток за дату
```

#### Customer Service
```
POST /api/external/cs/analyze
→ Body: { image: "<base64>" } или { imageUrl: "https://..." }
→ AI анализирует скриншот и возвращает JSON с ответом
→ Response: { channel, store, category, response, action, ... }

GET /api/external/cs/cases?status=open&limit=10
→ Список CS кейсов

POST /api/external/cs/cases/:id/resolve
→ Body: { resolution: "replacement" | "refund", notes: "..." }
→ Отметить кейс как решённый
```

#### Orders
```
GET /api/external/orders?status=awaiting_fulfillment
→ Список заказов (прокси к Veeqo с кешированием)

GET /api/external/orders/:id
→ Детали заказа
```

### Пример использования Claude-агентом:

```
Владимир в Telegram: "Покажи план на сегодня"
→ Claude-агент: POST /api/external/shipping/plan
→ Claude-агент: форматирует ответ и шлёт в Telegram

Владимир: "Покупай"
→ Claude-агент: POST /api/external/shipping/buy { planId: "..." }
→ Claude-агент: "✅ Куплено 12 этикеток, 2 ошибки"

Владимир: скидывает скриншот в Telegram
→ Claude-агент: POST /api/external/cs/analyze { image: "<base64>" }
→ Claude-агент: отправляет готовый ответ в Telegram
```

### MCP Server (опционально, фаза 2)

Control Center может выступать как MCP Server для Claude — это позволит Claude напрямую вызывать функции Control Center как tools. Реализовать как отдельный endpoint:
```
GET /api/mcp/sse → MCP Server (Server-Sent Events transport)
```

Tools для MCP:
- `generate_shipping_plan` — сгенерировать план
- `buy_shipping_labels` — купить этикетки
- `analyze_cs_screenshot` — анализировать кейс
- `get_order_status` — статус заказа
- `get_dashboard` — общая статистика

> Это позволит подключить Control Center как MCP server в Claude Desktop / Claude.ai (как сейчас подключён твой VPS через ngrok).

### Middleware для External API:

```typescript
// src/middleware.ts — проверка токена для /api/external/*
import { NextRequest, NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith('/api/external')) {
    const token = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (token !== process.env.SSCC_API_TOKEN) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }
  return NextResponse.next();
}
```

### Добавить в .env:
```env
# External API
SSCC_API_TOKEN=<сгенерировать случайный токен>
```

---

## 🔒 ПРАВИЛА БЕЗОПАСНОСТИ

1. Все API ключи — ТОЛЬКО в `.env`, НИКОГДА в коде
2. `.env` в `.gitignore`
3. API routes проксируют запросы к внешним API (клиент никогда не вызывает Veeqo/Sellbrite напрямую)
4. Нет авторизации для UI сейчас, но структура готова для NextAuth.js
5. External API (`/api/external/*`) защищён Bearer token через middleware
6. SSCC_API_TOKEN — длинный случайный токен (минимум 32 символа)

---

## 📋 ПОРЯДОК РЕАЛИЗАЦИИ

### Шаг 1: Инициализация
```bash
npx create-next-app@latest ss-control-center --typescript --tailwind --eslint --app --src-dir
cd ss-control-center
npx shadcn@latest init
npx prisma init --datasource-provider sqlite
```

### Шаг 2: Layout + Navigation
- Создать Sidebar с навигацией
- Создать Header
- Настроить root layout

### Шаг 3: Customer Service модуль
- API route `/api/cs/analyze`
- Интерфейс загрузки скриншота
- Отображение результатов
- Copy to clipboard
- История кейсов

### Шаг 4: Shipping Labels модуль
- API route `/api/shipping/plan`
- API route `/api/shipping/buy`
- Таблица с планом
- Кнопка "Buy All Labels"
- Интеграция с Google Drive

### Шаг 5: Dashboard
- Карточки со статистикой
- Таблица заказов на сегодня
- Quick actions

---

## 📚 СПРАВОЧНЫЕ ДОКУМЕНТЫ

При реализации модулей ОБЯЗАТЕЛЬНО сверяйся с документами в `/docs/`:

1. **CS_ALGORITHM_v1.1.md** — полный алгоритм Customer Service с шаблонами ответов, классификацией кейсов (C1-C10), политиками Amazon/Walmart, Buy Shipping Protection логикой
2. **MASTER_PROMPT_v3.1.md** — полный алгоритм покупки shipping labels: timezone правила, классификация Frozen/Dry, выбор перевозчика, бюджет, алгоритмы по дням недели, формат PDF файлов
3. **N8N_ARCHITECTURE_v1.1.md** — архитектура n8n workflow (справочно, логику брать из MASTER_PROMPT)

---

## ❌ ЧЕГО НИКОГДА НЕ ДЕЛАТЬ

- Не хардкодить API ключи
- Не угадывать тип товара (Frozen/Dry) — только по тегам Veeqo
- Не покупать Walmart этикетки в weekend
- Не использовать устаревшие Veeqo endpoints (`/api/v1/*`)
- Не отправлять эмодзи в сообщениях клиентам Amazon
- Не предлагать скидки/компенсации за изменение отзыва
- Не брать даты из Veeqo без конвертации UTC → UTC-7
- Не игнорировать VAS поле при покупке этикетки
- Не использовать колонку H для FedEx One Rate (нужна K)
