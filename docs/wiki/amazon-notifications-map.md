# 📬 Amazon Notifications Map — маппинг на модули

## Суть
Amazon Seller Central присылает ~30 типов email-уведомлений. Не все доступны через SP-API. Этот документ определяет какие уведомления критичны для каждого модуля Control Center, через какой канал их лучше получать (SP-API vs Gmail парсинг) и какие надо включить/отключить в Seller Central настройках. Полный сводный документ — [docs/AMAZON_NOTIFICATIONS_MAP.md](../AMAZON_NOTIFICATIONS_MAP.md). Gmail search queries — [src/lib/customer-hub/gmail-queries.ts](../../ss-control-center/src/lib/customer-hub/gmail-queries.ts).

## Принципы
1. **SP-API — основной источник** когда возможно (structured data, нет парсинга).
2. **Gmail — fallback и критичные алерты** которых нет в SP-API (Chargebacks, Listing compliance, Buyer Abuse).
3. **Veeqo — основной источник для заказов** (Dashboard, Shipping). Gmail дублирует как backup.
4. **Dual-channel для критичных событий** — Claims через SP-API Reports + Gmail alerts как триггер синхронизации.

## Каналы получения
| Канал | Что даёт | Когда использовать |
|---|---|---|
| **SP-API Messaging** | Отправка сообщений покупателю | Только для отправки — чтения нет |
| **Gmail API** | Все входящие email от Amazon | Основной канал для buyer messages, chargebacks, compliance алертов |
| **SP-API Reports** | A-to-Z claims, seller feedback, finances | Структурированные данные для агрегации |
| **SP-API Notifications** | Account Health, Business Updates | Push-style уведомления |
| **Veeqo API** | Заказы, трекинг, stock | Единственный источник для shipping состояния |

## Критичные уведомления (🔴)
Без них Control Center пропустит события требующие немедленной реакции:

| Уведомление | Канал | Модуль |
|---|---|---|
| Buyer Messages | Gmail (`from:marketplace.amazon.com`) | Customer Hub → Messages |
| Chargebacks | Gmail (`cb-seller-notification@amazon.com`) | Customer Hub → Chargebacks |
| A-to-Z Claims | SP-API Reports + Gmail alerts | Customer Hub → A-to-Z |
| Pending Returns | Gmail (`seller-notification@amazon.com`) | Customer Hub → Messages |
| Refund Notifications | Gmail | Adjustments + Customer Hub |
| Buyer Abuse Prevention | Gmail | Customer Hub → Feedback |
| Listing Compliance | Gmail | Account Health |
| Listing Removals | Gmail | Account Health |
| Inbound Shipment Problems | Gmail (`ship-notify@amazon.com`) | Shipping Labels |
| Business Updates | SP-API Notifications + Gmail backup | Account Health |

## Маппинг по модулям

### 🎯 Customer Hub
Основной потребитель уведомлений. Большинство данных через Gmail, SP-API для отправки и обогащения.
- **Messages** ← Gmail `from:marketplace.amazon.com` (единственный канал получения)
- **Chargebacks** ← Gmail `cb-seller-notification@amazon.com` (нет в SP-API!)
- **A-to-Z** ← SP-API Reports `GET_CLAIM_DATA` + Gmail Claims Notifications как триггер
- **Feedback** ← SP-API Reports `GET_SELLER_FEEDBACK_DATA`
- **Returns/Refunds alerts** ← Gmail парсинг (Phase 1.5)

### 🚚 Shipping Labels
Veeqo — основной источник. Gmail — алерты про FBA Inbound проблемы.
- **Новые заказы** ← Veeqo API (основной) + Gmail Merchant Order (backup)
- **FBA Inbound problems** ← Gmail `ship-notify@amazon.com` (только канал)

### 💓 Account Health
SP-API для метрик, Gmail для compliance alerts.
- **ODR / LSR / VTR** ← SP-API Account Health API
- **Listing compliance / removals** ← Gmail (критично, нет в API)
- **Business Updates** ← SP-API Notifications + Gmail backup

### 📊 Adjustments
- **Refunds** ← SP-API Finances API + Gmail триггер для синхронизации
- **Inventory removals** ← SP-API Reports + Gmail алерт

### 🌡️ Frozen Analytics
Не получает уведомления напрямую — обогащается через Customer Hub (категория C3 — spoiled/thawed complaints из buyer messages).

### 📊 Dashboard
- **Orders awaiting fulfillment** ← Veeqo API
- **Open CS cases** ← БД `BuyerMessage`
- **Active A-to-Z** ← БД `AtozzClaim`
- **Account Health alerts** ← SP-API + Gmail

## Gmail Queries (из gmail-queries.ts)
Полный список в [src/lib/customer-hub/gmail-queries.ts](../../ss-control-center/src/lib/customer-hub/gmail-queries.ts). Phase-деление:

**Phase 1 (текущий)**
- `buyerMessages` — `from:marketplace.amazon.com to:{email} newer_than:12h`
- `chargebacks` — `from:cb-seller-notification@amazon.com newer_than:7d`

**Phase 1.5**
- `returns` — `subject:"return"`
- `refunds` — `subject:"refund"`
- `deliveryFailures` — `subject:"delivery failure"`
- `buyerAbuse` — `subject:"abuse"`
- `buyerOptOut` — `subject:"opt-out"`

**Phase 2**
- `listingIssues` — `subject:("compliance" OR "removed" OR "suppressed")`
- `pricingAlerts` — `subject:("featured offer" OR "pricing")`
- `inboundProblems` — `from:ship-notify@amazon.com subject:"problem"`

## Включить в Seller Central (действие)
Эти уведомления Vladimir должен **включить вручную** в https://sellercentral.amazon.com/notification-preferences:

1. Merchant Order Notifications (Email) — backup для Dashboard
2. Inbound Shipment Notifications — FBA статусы
3. Inbound Shipment Problem Notifications — критично
4. Pending Returns — триггер Customer Hub
5. Refund Notifications — триггер Adjustments
6. Delivery Failures (Messaging) — знать что reply не дошёл
7. Buyer Opt-out (Messaging) — не спамить
8. Featured Offer Recommendations — Buy Box мониторинг
9. Pricing Notifications — цены

## Отключить (шум)
1. Marketing — бесполезно
2. Loan Invitations — бесполезно
3. Prime Order SMS — дубль Veeqo

## Парсеры которые понадобятся
| Email From | Тип | Модуль | Статус |
|---|---|---|---|
| `*@marketplace.amazon.com` | Buyer Message | Customer Hub → Messages | ✅ `gmail-parser.ts` |
| `cb-seller-notification@amazon.com` | Chargeback | Customer Hub → Chargebacks | ⏳ запланирован |
| `seller-notification@amazon.com` (returns/refunds) | Returns/Refunds | Customer Hub + Adjustments | ⏳ Phase 1.5 |
| `seller-notification@amazon.com` (compliance) | Listing issues | Account Health | ⏳ Phase 2 |
| `ship-notify@amazon.com` | Inbound problems | Shipping Labels | ⏳ Phase 2 |
| `seller-notification@amazon.com` (abuse) | Buyer Abuse | Customer Hub → Feedback | Часть `gmail-parser.ts` |

> Точные `From:` адреса нужно уточнить на реальных письмах — значения выше приблизительные.

## Связанные файлы
- [docs/AMAZON_NOTIFICATIONS_MAP.md](../AMAZON_NOTIFICATIONS_MAP.md) — полный справочник (224 строки, полная таблица всех 30+ уведомлений)
- `src/lib/customer-hub/gmail-queries.ts` — константы Gmail queries
- `src/lib/customer-hub/gmail-parser.ts` — парсер buyer messages (Phase 1)
- `src/lib/gmail-api.ts` — OAuth + Gmail API wrapper
- `src/app/api/customer-hub/messages/route.ts` — sync потребляет `buyerMessages` query

## 🔗 Связи

### Зависит от
- [Gmail API](gmail-api.md) — канал получения всех уведомлений, OAuth на 5 магазинов
- [Amazon SP-API](amazon-sp-api.md) — альтернативный канал (Reports, Notifications API, Account Health)

### Используется в
- [Customer Hub](customer-hub.md) — главный потребитель (Messages, Chargebacks, A-to-Z, Feedback)
- [Account Health](account-health.md) — Listing compliance, removals, Business Updates
- [Shipping Labels](shipping-labels.md) — Inbound shipment problems, Merchant Order backup
- [Adjustments Monitor](adjustments-monitor.md) — Refund triggers, inventory removals
- [A-to-Z & Chargeback](atoz-chargeback.md) — Chargeback single source, Claims notifications

### Связанные модули
- [Dashboard](dashboard.md) — агрегирует счётчики уведомлений (unread, active claims, alerts)
- [Feedback Manager](feedback-manager.md) — Buyer Abuse Prevention alerts

### См. также
- [Customer Hub Decision Engine](customer-hub-decision-engine.md) — обработка входящих сообщений после парсинга
- [N8N Automation](n8n-automation.md) — alternative polling механизм для Gmail queries

## История
- 2026-04-11: Wiki-статья создана на основе `docs/AMAZON_NOTIFICATIONS_MAP.md` v1.0. Константы вынесены в `src/lib/customer-hub/gmail-queries.ts`. Phase 1 query (`buyerMessages`) уже используется в `messages/route.ts`, остальные — справочно для Phase 1.5 и 2.
