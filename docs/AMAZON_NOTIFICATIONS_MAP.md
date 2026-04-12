# Amazon Seller Central Notifications — Маппинг на модули Control Center
## Version 1.0 — 2026-04-11

---

## ЗАЧЕМ ЭТОТ ДОКУМЕНТ

Amazon Seller Central предлагает ~30 типов email-уведомлений. Не все из них доступны через SP-API.
Этот документ определяет:
1. Какие уведомления критичны для каждого модуля
2. Как мы получаем данные: SP-API или Gmail (парсинг писем)
3. Какие уведомления стоит включить, а какие не нужны

**Email получателя для всех аккаунтов:** идёт на привязанный email (amazon@salutem.solutions, kuzy.vladimir@gmail.com и т.д.)

---

## СВОДНАЯ ТАБЛИЦА

| Уведомление | Модуль CC | Канал получения | Приоритет | Включить? |
|---|---|---|---|---|
| **ACCOUNT NOTIFICATIONS** | | | | |
| Business Updates | Account Health | SP-API (Notifications API) + Gmail fallback | 🔴 Критично | ✅ Да (уже вкл.) |
| Technical Notifications | Settings / Dashboard | Gmail | 🟡 Полезно | ✅ Да (уже вкл.) |
| Buyer Abuse Prevention Actions | Customer Hub (Feedback) | Gmail (парсинг) | 🔴 Критично | ✅ Да (уже вкл.) |
| **FBA INBOUND SHIPMENT** | | | | |
| Pickup plan changes | Shipping Labels | Gmail | 🟡 Полезно | ✅ Да (уже вкл.) |
| Delivery plan changes | Shipping Labels | Gmail | 🟡 Полезно | ✅ Да (уже вкл.) |
| **ORDER NOTIFICATIONS** | | | | |
| Merchant Order (Sold, Ship Now) — SMS | Dashboard | SMS | ⚪ Опционально | ❌ Нет (есть Veeqo) |
| Merchant Order (Sold, Ship Now) — Email | Dashboard / Shipping | Gmail или Veeqo webhook | 🟡 Полезно | ✅ **Включить!** |
| Amazon Fulfillment Order | — | N/A (FBA) | ⚪ Не нужно | ❌ Нет |
| Multichannel Fulfillment | — | N/A | ⚪ Не нужно | ❌ Нет |
| Inbound Shipment Notifications | Shipping Labels | Gmail | 🟡 Полезно | ✅ **Включить!** |
| Inbound Shipment Problem | Shipping Labels / Account Health | Gmail | 🔴 Критично | ✅ **Включить!** |
| **PRIME NOTIFICATIONS** | | | | |
| Prime Order (Email) | — | Gmail | ⚪ Шум | ❌ Нет (есть Veeqo) |
| Prime Order (SMS) | — | SMS | ⚪ Шум | ❌ Нет |
| **RETURNS, CLAIMS, RECOVERY** | | | | |
| Pending Returns | Customer Hub (Messages) | Gmail (парсинг) | 🔴 Критично | ✅ **Включить!** |
| Claims Notifications | Customer Hub (A-to-Z / CB) | SP-API Reports + Gmail | 🔴 Критично | ✅ Да (уже вкл.) |
| Refund Notifications | Adjustments / Customer Hub | Gmail (парсинг) | 🔴 Критично | ✅ **Включить!** |
| Grade and Resell | — | N/A | ⚪ Не нужно | ❌ Нет |
| **LISTING NOTIFICATIONS** | | | | |
| My listing has been created | Product Listings (Phase 2) | Gmail | ⚪ Шум | ❌ Пока нет |
| Listing has recommendations | Product Listings (Phase 2) | Gmail | 🟡 Полезно | ✅ Оставить вкл. |
| Listing has closed | Product Listings (Phase 2) / Account Health | Gmail | 🔴 Критично | ✅ Оставить вкл. |
| Listing compliance requirements | Account Health | Gmail (парсинг) | 🔴 Критично | ✅ Оставить вкл. |
| Inventory removal orders | Adjustments | Gmail | 🟡 Полезно | ✅ Оставить вкл. |
| **REPORTS** | | | | |
| Product Bundles Sales Report | Sales Analytics (Phase 2) | Gmail | ⚪ Пока не нужно | ❌ Нет |
| Open Listings Report | Product Listings (Phase 2) | Gmail | ⚪ Пока не нужно | ❌ Нет |
| Order Fulfillment Report | Dashboard / Shipping | Gmail | 🟡 Полезно | ❌ Пока нет (есть Veeqo) |
| Sold Listings Report | Sales Analytics (Phase 2) | Gmail | ⚪ Пока не нужно | ❌ Нет |
| Cancelled Listings Report | Product Listings (Phase 2) | Gmail | ⚪ Пока не нужно | ❌ Нет |
| **AMAZON BUSINESS** | | | | |
| Quote Requests | Customer Hub (Messages) | Gmail (парсинг) | 🟡 Полезно | ✅ Оставить вкл. |
| **MESSAGING** | | | | |
| Buyer Messages | Customer Hub (Messages) | Gmail API (основной канал!) | 🔴 Критично | ✅ Да (уже вкл.) |
| Confirmation Notifications | Customer Hub (Messages) | Gmail (парсинг) | 🔴 Критично | ✅ Да — автоматически определяет что ответ дошёл → status=SENT |
| Delivery Failures | Customer Hub | Gmail (парсинг) | 🟡 Полезно | ✅ **Включить!** |
| Buyer Opt-out | Customer Hub | Gmail | 🟡 Полезно | ✅ **Включить!** |
| **MARKETING** | | | | |
| Marketing | — | Gmail | ⚪ Шум | ❌ Отключить |
| **AMAZON LENDING** | | | | |
| Loan Invitations | — | Gmail | ⚪ Не нужно | ❌ Отключить |
| **PRICING AND OFFER** | | | | |
| Featured Offer Recommendations | Product Listings (Phase 2) / Dashboard | Gmail | 🟡 Полезно | ✅ **Включить!** |
| Pricing Notifications | Product Listings (Phase 2) | Gmail | 🟡 Полезно | ✅ **Включить!** |
| **LISTINGS REQUIRING ATTENTION** | | | | |
| Listings removals requiring approval | Account Health | Gmail (парсинг) | 🔴 Критично | ✅ Да (уже вкл.) |

---

## МАППИНГ ПО МОДУЛЯМ

### 🎯 Customer Hub
**Основной потребитель уведомлений.** Большинство данных получаем через API, Gmail — fallback и дополнение.

| Что нужно | SP-API | Gmail (fallback/дополнение) |
|---|---|---|
| Buyer Messages | SP-API Messaging API (для отправки) | Gmail API `from:marketplace.amazon.com` — **основной канал получения** |
| A-to-Z Claims | SP-API Reports `GET_CLAIM_DATA` | Gmail `Claims Notifications` — алерт + триггер синхронизации |
| Chargebacks | ❌ Нет в SP-API | Gmail `from:cb-seller-notification@amazon.com` — **единственный канал** |
| Returns | SP-API Reports `GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA` | Gmail `Pending Returns` — алерт |
| Refunds | SP-API Finances API | Gmail `Refund Notifications` — алерт + проверка |
| Buyer Abuse | ❌ Нет в SP-API | Gmail `Buyer Abuse Prevention Actions` — парсить для Feedback таба |
| Delivery Failures (messaging) | ❌ | Gmail — знать что ответ не дошёл |
| Buyer Opt-out | ❌ | Gmail — не отправлять повторно |
| Quote Requests (B2B) | SP-API | Gmail — алерт |

### 🚚 Shipping Labels
**Основной источник — Veeqo API.** Gmail-уведомления полезны как дублирующий канал.

| Что нужно | Veeqo API | Gmail (дополнение) |
|---|---|---|
| Новый заказ (Ship Now) | ✅ Veeqo Orders API — основной | Gmail `Merchant Order Notifications` — backup алерт |
| FBA Inbound проблемы | ❌ | Gmail `Inbound Shipment Problem` — **единственный канал** |
| FBA Inbound статус | ❌ | Gmail `Pickup/Delivery plan changes` |

### 💓 Account Health
**Основной источник — SP-API.** Gmail — для критичных алертов, которых нет в API.

| Что нужно | SP-API | Gmail |
|---|---|---|
| ODR / LSR / VTR | ✅ SP-API Account Health API | — |
| Listing compliance | ❌ Частично | Gmail `Listing compliance requirements` — **критично** |
| Listing removals | ❌ Частично | Gmail `Listings removals requiring approval` — **критично** |
| Business Updates | SP-API Notifications | Gmail `Business Updates` — backup |
| Listing closed | SP-API Catalog API | Gmail `Listing has closed` — алерт |

### 📊 Adjustments
| Что нужно | SP-API | Gmail |
|---|---|---|
| Refunds | ✅ SP-API Finances API | Gmail `Refund Notifications` — триггер для синхронизации |
| Inventory removals | SP-API Reports | Gmail `Inventory removal orders` — алерт |

### 🌡️ Frozen Analytics
| Что нужно | SP-API | Gmail |
|---|---|---|
| Frozen complaints | Через Customer Hub (category C3) | Buyer Messages с ключевыми словами "thawed", "melted" |

### 📊 Dashboard
| Что нужно | Источник |
|---|---|
| Orders awaiting fulfillment | Veeqo API |
| Open CS cases count | БД (BuyerMessage) |
| Active A-to-Z claims | БД (AtozzClaim) |
| Account Health alerts | SP-API + Gmail alerts |

---

## ЧТО НУЖНО ВКЛЮЧИТЬ В SELLER CENTRAL (действие)

### Включить сейчас (не включено на скриншотах):
1. ✅ **Merchant Order Notifications (Email)** — backup для Dashboard
2. ✅ **Inbound Shipment Notifications** — FBA статусы
3. ✅ **Inbound Shipment Problem Notifications** — критичные проблемы
4. ✅ **Pending Returns** — триггер для Customer Hub
5. ✅ **Refund Notifications** — триггер для Adjustments
6. ✅ **Delivery Failures** (Messaging) — знать что ответ не дошёл
7. ✅ **Buyer Opt-out** (Messaging) — не спамить клиента
8. ✅ **Featured Offer Recommendations** — для Buy Box мониторинга
9. ✅ **Pricing Notifications** — для ценового мониторинга

### Отключить (шум):
1. ❌ **Marketing** — бесполезно
2. ❌ **Loan Invitations** — бесполезно
3. ❌ **Prime Order Notifications (SMS)** — дубль Veeqo

### Оставить как есть (уже включено и нужно):
- Business Updates ✅
- Technical Notifications ✅
- Buyer Abuse Prevention ✅
- Claims Notifications ✅
- Buyer Messages ✅
- Listing recommendations/closed/compliance/removal ✅
- Quote Requests ✅

---

## GMAIL ПАРСИНГ — ШАБЛОНЫ ПИСЕМ ДЛЯ ПАРСИНГА

Для модулей, которые получают данные через Gmail, нужны парсеры:

| Email From | Тип | Модуль | Парсер |
|---|---|---|---|
| `*@marketplace.amazon.com` | Buyer Message | Customer Hub → Messages | `gmail-parser.ts` (уже запланирован) |
| `cb-seller-notification@amazon.com` | Chargeback | Customer Hub → Chargebacks | `chargeback-parser.ts` (уже запланирован) |
| `seller-notification@amazon.com` | Returns / Refunds | Customer Hub + Adjustments | **Нужен новый парсер** |
| `ship-notify@amazon.com` | Inbound problems | Shipping Labels | **Нужен новый парсер** (Phase 2) |
| `seller-notification@amazon.com` | Listing issues | Account Health | **Нужен новый парсер** (Phase 2) |
| `seller-notification@amazon.com` | Buyer Abuse | Customer Hub → Feedback | Часть `gmail-parser.ts` |

> **Примечание:** Точные адреса отправителей (`From:`) нужно уточнить на реальных письмах. Выше — приблизительные, основанные на стандартной конфигурации Amazon.

---

## ПРИОРИТЕТЫ РЕАЛИЗАЦИИ

### Phase 1 (текущий):
- Gmail парсер buyer messages ✅ (запланирован)
- Gmail парсер chargebacks ✅ (запланирован)
- SP-API Reports для A-to-Z и Feedback ✅ (запланирован)

### Phase 1.5 (после основного Customer Hub):
- Gmail парсер для returns/refunds → триггер Adjustments синхронизации
- Gmail парсер для delivery failures / buyer opt-out → флаги в Customer Hub

### Phase 2:
- Gmail парсер для listing issues → Account Health алерты
- Gmail парсер для pricing/offer → Product Listings модуль
- Gmail парсер для inbound shipment problems → Shipping Labels алерты

---

## НАСТРОЙКА GMAIL QUERIES

```typescript
// Все Gmail queries для Control Center polling:

const GMAIL_QUERIES = {
  // Customer Hub — Messages (уже в алгоритме v2.1)
  buyerMessages: 'from:marketplace.amazon.com to:{account_email} newer_than:12h',
  
  // Customer Hub — Chargebacks (уже в алгоритме v2.1)
  chargebacks: 'from:cb-seller-notification@amazon.com newer_than:7d',
  
  // Returns & Refunds (Phase 1.5)
  returns: 'from:seller-notification@amazon.com subject:"return" newer_than:2d',
  refunds: 'from:seller-notification@amazon.com subject:"refund" newer_than:2d',
  
  // Messaging issues (Phase 1.5)
  deliveryFailures: 'from:seller-notification@amazon.com subject:"delivery failure" newer_than:7d',
  
  // Account Health alerts (Phase 2)
  listingIssues: 'from:seller-notification@amazon.com subject:("compliance" OR "removed" OR "suppressed") newer_than:7d',
  
  // Pricing (Phase 2)
  pricingAlerts: 'from:seller-notification@amazon.com subject:("featured offer" OR "pricing") newer_than:7d',
};
```

> ⚠️ Эти queries — стартовые шаблоны. Нужно уточнить на реальных письмах и адаптировать regex парсеры.
