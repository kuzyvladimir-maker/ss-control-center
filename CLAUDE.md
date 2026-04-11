# CLAUDE.md — Salutem Solutions Control Center

## 🎯 О ПРОЕКТЕ

**SS Control Center** — веб-платформа для управления e-commerce бизнесом на маркетплейсах (Amazon, Walmart). Единый интерфейс для управления заказами, доставкой, клиентским сервисом, аналитикой и здоровьем аккаунтов.

**Владелец:** Владимир (не разработчик). Объясняй простыми словами. Код с комментариями.

---

## 🏗️ ТЕХНИЧЕСКИЙ СТЕК

```
Frontend:  Next.js 14+ (App Router) + React 18 + TypeScript
Styling:   Tailwind CSS + shadcn/ui components
Backend:   Next.js API Routes (app/api/)
Database:  SQLite (Prisma ORM)
AI:        Anthropic Claude API (claude-sonnet-4-20250514)
Auth:      Пока нет
```

---

## 🏪 АККАУНТЫ AMAZON (5 штук)

| # | Аккаунт | Email | Store Index | SP-API | Gmail API |
|---|---------|-------|-------------|--------|-----------|
| 1 | Salutem Solutions | amazon@salutem.solutions | store1 | ✅ | ❌ (нужен OAuth) |
| 2 | Vladimir Personal | kuzy.vladimir@gmail.com | store2 | ✅ | ✅ |
| 3 | AMZ Commerce | TBD | store3 | ✅ | ❌ |
| 4 | Sirius International | TBD | store4 | ✅ | ❌ |
| 5 | Retailer Distributor | TBD | store5 | ✅ | ❌ |

Walmart — 1 аккаунт (API ключ пока отсутствует).

SP-API auth: per-store credentials `AMAZON_SP_REFRESH_TOKEN_STORE{N}` с fallback на shared.
Файл: `src/lib/amazon-sp-api/auth.ts`

---

## 🔌 ВНЕШНИЕ API И СЕРВИСЫ

| Сервис | Назначение | Файл |
|--------|-----------|------|
| **Veeqo** | Заказы, shipping rates, покупка этикеток | `lib/veeqo.ts` |
| **Amazon SP-API** | Orders, messaging, reports, account health, finances | `lib/amazon-sp-api/` |
| **Sellbrite** | Product listings | `lib/sellbrite.ts` |
| **Gmail API** | Получение buyer messages, chargeback notifications | `lib/gmail-api.ts` (создаётся) |
| **Claude API** | AI-анализ сообщений, Decision Engine | `lib/claude.ts` |
| **Google Sheets** | SKU Database v2 | `lib/google-sheets.ts` |
| **Telegram Bot** | Уведомления Владимиру | `lib/telegram.ts` |
| **Weather API** | Frozen analytics — погода при доставке | `lib/weather.ts` |
| **Geocoding** | Координаты для frozen analytics | `lib/geocoding.ts` |

---

## 📁 СТРУКТУРА ПРОЕКТА

```
ss-control-center/
├── CLAUDE.md                         # Этот файл
├── docs/
│   ├── CUSTOMER_HUB_ALGORITHM_v2.1.md # Алгоритм Customer Hub (Messages, A-to-Z, CB, Feedback)
│   ├── MASTER_PROMPT_v3.1.md          # Алгоритм Shipping Labels
│   ├── CS_ALGORITHM_v1.md             # Legacy CS алгоритм (заменён Customer Hub)
│   ├── FROZEN_ANALYTICS_v1.0.md       # Frozen delivery analytics
│   ├── N8N_SHIPPING_ARCHITECTURE_v1.1.md
│   └── CUSTOMER_HUB_ALGORITHM_v1.0.md # Legacy (заменён v2.1)
├── prisma/
│   └── schema.prisma
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx                   # Dashboard
│   │   ├── account-health/page.tsx
│   │   ├── shipping/page.tsx
│   │   ├── customer-hub/page.tsx      # ← НОВЫЙ: единая страница с 4 табами
│   │   ├── customer-service/page.tsx  # Legacy (будет убран)
│   │   ├── claims/atoz/page.tsx       # Legacy (внутри Customer Hub)
│   │   ├── feedback/page.tsx          # Legacy (внутри Customer Hub)
│   │   ├── frozen-analytics/page.tsx
│   │   ├── adjustments/page.tsx
│   │   ├── analytics/page.tsx         # Phase 2
│   │   ├── listings/page.tsx          # Phase 2
│   │   ├── suppliers/page.tsx         # Phase 3
│   │   ├── promotions/page.tsx        # Phase 3
│   │   ├── integrations/page.tsx
│   │   ├── settings/page.tsx
│   │   └── api/
│   │       ├── customer-hub/          # ← НОВЫЙ
│   │       │   ├── messages/
│   │       │   ├── atoz/
│   │       │   ├── chargebacks/
│   │       │   ├── feedback/
│   │       │   └── stats/
│   │       ├── shipping/              # plan, buy, fix-sku, fix-tag
│   │       ├── cs/                    # Legacy (analyze, cases, stats)
│   │       ├── account-health/
│   │       ├── adjustments/
│   │       ├── claims/atoz/
│   │       ├── feedback/
│   │       ├── frozen/
│   │       ├── amazon/                # SP-API: stores, messages, test
│   │       ├── veeqo/orders/
│   │       ├── sync/
│   │       ├── dashboard/summary/
│   │       ├── sku/
│   │       └── external/              # API для Claude-агента, n8n
│   ├── components/
│   │   ├── layout/                    # Sidebar, Header, AppShell
│   │   ├── customer-hub/              # ← НОВЫЙ: все компоненты Customer Hub
│   │   ├── cs/                        # Legacy CS components
│   │   ├── claims/
│   │   ├── feedback/
│   │   ├── frozen-analytics/
│   │   ├── adjustments/
│   │   ├── account-health/
│   │   └── ui/                        # shadcn/ui
│   ├── lib/
│   │   ├── amazon-sp-api/             # auth, client, orders, messaging, reports, finances, solicitations
│   │   ├── customer-hub/              # ← НОВЫЙ: gmail-parser, message-enricher, message-analyzer, response-sender
│   │   ├── claims/strategy.ts
│   │   ├── sync/                      # orders-sync, finances-sync
│   │   ├── veeqo.ts
│   │   ├── sellbrite.ts
│   │   ├── claude.ts
│   │   ├── gmail-api.ts               # ← НОВЫЙ: Gmail OAuth client
│   │   ├── google-sheets.ts
│   │   ├── telegram.ts
│   │   ├── weather.ts
│   │   ├── geocoding.ts
│   │   ├── frozen-analytics.ts
│   │   ├── prisma.ts
│   │   └── utils.ts
│   ├── generated/prisma/              # Prisma generated client
│   ├── types/index.ts
│   └── middleware.ts
```

---

## 📊 БАЗА ДАННЫХ (Prisma — 19 моделей)

| Модель | Назначение |
|--------|-----------|
| **BuyerMessage** | ← НОВЫЙ: сообщения покупателей (Gmail + скриншоты Walmart) |
| **CsCase** | Legacy CS кейсы (скриншоты) |
| **ShippingPlan** | Планы доставки |
| **ShippingPlanItem** | Позиции в плане |
| **Store** | Магазины (Amazon, Walmart) |
| **Setting** | Настройки приложения |
| **ProductTypeOverride** | Frozen/Dry переопределения |
| **FrozenIncident** | Инциденты с frozen товарами |
| **SkuRiskProfile** | Риск-профили SKU (frozen) |
| **ShippingAdjustment** | Корректировки стоимости доставки |
| **SkuAdjustmentProfile** | Профили корректировок по SKU |
| **AtozzClaim** | A-to-Z claims + Chargebacks |
| **SellerFeedback** | Отзывы продавца |
| **ProductReview** | Отзывы на товар |
| **AccountHealthSnapshot** | Снимки здоровья аккаунта |
| **AccountAlert** | Алерты по метрикам |
| **ReportSyncJob** | Задачи синхронизации отчётов |
| **AmazonOrder** | Синхронизированные заказы |
| **SyncLog** | Логи синхронизации |

---

## 📱 МОДУЛИ И SIDEBAR

```
📊 Dashboard            ← Работает (карточки + data overview + quick actions)
💓 Account Health       ← Работает (SP-API sync, метрики ODR/LSR/VTR)
🚚 Shipping Labels      ← Работает (Veeqo plan + buy labels)
🎯 Customer Hub         ← В РАЗРАБОТКЕ (4 таба: Messages, A-to-Z, CB, Feedback)
🌡️ Frozen Analytics     ← Начат (таблица инцидентов, SKU risk)
📊 Adjustments          ← Начат (мониторинг корректировок)
🏷️ Product Listings     ← Phase 2
💰 Sales Analytics      ← Phase 2
🛒 Suppliers            ← Phase 3
📢 Promotions           ← Phase 3
🔄 Integrations         ← Страница есть
⚙️ Settings             ← Работает (stores, API keys, SP-API test)
```

---

## 🎯 CUSTOMER HUB (главный модуль в разработке)

**Путь:** `/customer-hub`
**Алгоритм:** `docs/CUSTOMER_HUB_ALGORITHM_v2.1.md`

Единая страница с 4 табами, заменяет отдельные `/customer-service`, `/claims/atoz`, `/feedback`.

| Таб | Источник | Обогащение | Действие |
|-----|----------|------------|----------|
| **Messages** | Gmail API (`@marketplace.amazon.com`) | SP-API Orders + Veeqo tracking | Claude → SP-API Messaging |
| **A-to-Z** | SP-API Reports | SP-API Orders + tracking | Генерация ответа |
| **Chargebacks** | Gmail (`cb-seller-notification@amazon.com`) | SP-API Orders + tracking | Генерация ответа |
| **Feedback** | SP-API Reports | — | Request Removal / ответ |

**Walmart** — временно через скриншоты (модальное окно), пока нет API ключа.

**Decision Engine:** 5 слоёв (классификация T1-T20 → риск → решение → чеклист → кто платит).
Подробности — в `docs/CUSTOMER_HUB_ALGORITHM_v2.1.md`.

---

## 🚚 SHIPPING LABELS

**Путь:** `/shipping`
**Алгоритм:** `docs/MASTER_PROMPT_v3.1.md`

Самый развитый модуль (810 строк). Генерация плана → выбор carrier/service → покупка этикеток через Veeqo.

---

## 🎨 ДИЗАЙН

- **Светлая тема** (white bg, gray borders)
- **Sidebar** слева (collapsible)
- **Header** сверху (дата + уведомления)
- **shadcn/ui** компоненты
- Desktop-first (1280px+)
- Язык интерфейса: **English**

Цвета: Primary `#2563EB`, Success `#16A34A`, Warning `#F59E0B`, Danger `#DC2626`

---

## 🔌 EXTERNAL API

REST API для Claude-агента, n8n, Telegram-бот.
Auth: `Authorization: Bearer <SSCC_API_TOKEN>`
Middleware: `src/middleware.ts`

MCP Server (Phase 2): `GET /api/mcp/sse`

---

## 🔒 БЕЗОПАСНОСТЬ

- API ключи ТОЛЬКО в `.env`, НИКОГДА в коде
- `.env` в `.gitignore`
- API routes проксируют запросы
- External API защищён Bearer token
- SP-API credentials per-store

---

## 📚 СПРАВОЧНЫЕ ДОКУМЕНТЫ

| Файл | Содержание | Статус |
|------|-----------|--------|
| `docs/CUSTOMER_HUB_ALGORITHM_v2.1.md` | Customer Hub: Messages, A-to-Z, Chargebacks, Feedback, Decision Engine, Walmart | **Актуальный** |
| `docs/MASTER_PROMPT_v3.1.md` | Shipping Labels: timezone, Frozen/Dry, carriers, budget | **Актуальный** |
| `docs/FROZEN_ANALYTICS_v1.0.md` | Frozen delivery analytics | **Актуальный** |
| `docs/N8N_SHIPPING_ARCHITECTURE_v1.1.md` | n8n architecture (справка) | Справочный |
| `docs/CS_ALGORITHM_v1.md` | Legacy CS (скриншоты) | **Заменён** Customer Hub v2.1 |
| `docs/CUSTOMER_HUB_ALGORITHM_v1.0.md` | Legacy Customer Hub | **Заменён** v2.1 |

---

## 📝 СИСТЕМА ЛОГИРОВАНИЯ СЕССИЙ

### При НАЧАЛЕ каждой сессии:
1. Прочитай `docs/wiki/index.md` — там оглавление накопленных знаний
2. Прочитай последний файл из `docs/dev-log/` — там лог предыдущей сессии
3. Это даст тебе контекст того, что уже сделано и какие решения приняты

### При ЗАВЕРШЕНИИ каждой сессии (когда задача выполнена):
1. Открой (или создай) файл `docs/dev-log/YYYY-MM-DD.md` (текущая дата)
2. Добавь блок в конец файла:

```
### Session HH:MM

**Задача:** [что просил Владимир]
**Сделано:**
- [конкретно что создано/изменено, с путями к файлам]

**Решения:**
- [какие технические решения приняты и почему]

**Проблемы:**
- [что пошло не так, workarounds, на что обратить внимание]

**Затронутые файлы:**
- `path/to/file.ts` — краткое описание изменения
```

3. Если в ходе сессии получены важные знания (новый паттерн, решение бага, особенность API), создай или обнови wiki-статью в `docs/wiki/` и обнови `docs/wiki/index.md`

### Формат wiki-статей (`docs/wiki/*.md`):

Имя файла: `kebab-case.md` (например `veeqo-api-quirks.md`, `frozen-shipping-rules.md`)

Структура статьи:
```markdown
# Название

## Суть
Краткое описание (2-3 предложения)

## Детали
Подробное описание

## Связанные файлы
- `src/lib/veeqo.ts`
- `docs/MASTER_PROMPT_v3.1.md`

## История
- 2026-04-10: Создана на основе сессии (ссылка на лог)
```

### Когда создавать wiki-статью:
- Найден неочевидный баг или workaround
- Принято архитектурное решение (почему выбрали X а не Y)
- Обнаружена особенность внешнего API (Veeqo, Sellbrite, etc.)
- Создан переиспользуемый паттерн или утилита
- Что-то важное для будущих сессий

### 🔗 ПРАВИЛА СВЯЗЕЙ (обязательно!):
При создании или обновлении wiki-статьи ВСЕГДА:
1. Добавить секцию `## 🔗 Связи` с подсекциями:
   - **Зависит от:** (от каких модулей/API/правил зависит)
   - **Используется в:** (где используется результат)
   - **Связанные модули:** (двусторонние связи)
   - **См. также:** (полезные ссылки)
2. Обновить **обратные ссылки** — зайти в каждую связанную статью и добавить ссылку обратно
3. Обновить `docs/wiki/CONNECTIONS.md` — добавить новую статью в карту связей
4. Обновить `docs/wiki/index.md` — добавить в оглавление в правильную секцию

Связи — это главная ценность wiki. Без связей статья изолирована и бесполезна.

### ВАЖНО:
- НЕ логируй тривиальные вещи (изменил текст кнопки, поправил опечатку)
- Логируй РЕШЕНИЯ, ПРОБЛЕМЫ и ЗНАНИЯ
- Wiki-статьи должны быть полезны через месяц, а не только сегодня

---

## ❌ ЧЕГО НИКОГДА НЕ ДЕЛАТЬ

- Не хардкодить API ключи
- Не угадывать тип товара (Frozen/Dry) — только по тегам Veeqo
- Не покупать Walmart этикетки в weekend
- Не брать даты из Veeqo без конвертации UTC → UTC-7
- Не отправлять эмодзи в сообщениях клиентам Amazon
- Не предлагать скидки/компенсации за изменение отзыва
- Не использовать SAFE-T для carrier delay (только Support/Buy Shipping)
- Не спорить о безопасности еды с клиентом
- Не утверждать что товар безопасен при жалобе на spoilage
- Не просить вернуть frozen товары (food safety)
- Не игнорировать VAS поле при покупке этикетки
