# ПРОМПТ ДЛЯ CLAUDE CODE — Добавление Amazon Notifications Map в проект

## Контекст
Мы проанализировали все типы уведомлений Amazon Seller Central и создали справочный документ `docs/AMAZON_NOTIFICATIONS_MAP.md` (уже лежит в папке docs/). Он маппит каждое уведомление на модули Control Center и определяет: какие критичны, как получаем данные (SP-API vs Gmail), какие включить/отключить.

## Задача

### 1. Обновить CLAUDE.md
Прочитай `CLAUDE.md`. В секции где перечислены файлы в `docs/`, добавь строку:
```
│   ├── AMAZON_NOTIFICATIONS_MAP.md    # Маппинг уведомлений Amazon → модули CC + Gmail queries
```

В секции `🔌 ВНЕШНИЕ API И СЕРВИСЫ` после строки с Gmail API добавь:
```
> Подробный маппинг уведомлений Amazon и Gmail queries для каждого модуля — см. `docs/AMAZON_NOTIFICATIONS_MAP.md`
```

### 2. Обновить Customer Hub алгоритм
Прочитай `docs/CUSTOMER_HUB_ALGORITHM_v2.1.md`. В начало, после секции "ОБЗОР", добавь:
```
> 📋 Полный маппинг Amazon уведомлений и Gmail queries → `docs/AMAZON_NOTIFICATIONS_MAP.md`
```

### 3. Создать файл gmail-queries.ts
Создай `ss-control-center/src/lib/customer-hub/gmail-queries.ts`:

```typescript
/**
 * Gmail search queries для polling уведомлений Amazon.
 * Справочник: docs/AMAZON_NOTIFICATIONS_MAP.md
 * 
 * Phase 1: buyerMessages, chargebacks
 * Phase 1.5: returns, refunds, deliveryFailures, buyerAbuse
 * Phase 2: listingIssues, pricingAlerts
 */

export const GMAIL_QUERIES = {
  // ===== PHASE 1 (Customer Hub — Messages + Chargebacks) =====
  
  /** Buyer messages — основной канал получения сообщений покупателей */
  buyerMessages: (accountEmail: string) =>
    `from:marketplace.amazon.com to:${accountEmail} newer_than:12h`,

  /** Chargebacks — единственный канал (нет в SP-API) */
  chargebacks: 'from:cb-seller-notification@amazon.com newer_than:7d',

  // ===== PHASE 1.5 (Returns, Refunds, Messaging issues) =====
  
  /** Pending Returns — триггер для Customer Hub */
  returns: 'from:seller-notification@amazon.com subject:"return" newer_than:2d',

  /** Refund Notifications — триггер для Adjustments синхронизации */
  refunds: 'from:seller-notification@amazon.com subject:"refund" newer_than:2d',

  /** Delivery Failures — сообщение не дошло до покупателя */
  deliveryFailures: 'from:seller-notification@amazon.com subject:"delivery failure" newer_than:7d',

  /** Buyer Abuse Prevention — для Feedback таба */
  buyerAbuse: 'from:seller-notification@amazon.com subject:"abuse" newer_than:7d',

  /** Buyer Opt-out — покупатель отказался от сообщений */
  buyerOptOut: 'from:seller-notification@amazon.com subject:"opt-out" newer_than:7d',

  // ===== PHASE 2 (Account Health, Listings, Pricing) =====
  
  /** Listing issues — compliance, removals, suppressions */
  listingIssues: 'from:seller-notification@amazon.com subject:("compliance" OR "removed" OR "suppressed") newer_than:7d',

  /** Pricing & Featured Offer alerts */
  pricingAlerts: 'from:seller-notification@amazon.com subject:("featured offer" OR "pricing") newer_than:7d',

  /** Inbound Shipment Problems — для Shipping Labels */
  inboundProblems: 'from:ship-notify@amazon.com subject:"problem" newer_than:7d',
} as const;

/** Email → Store маппинг */
export const EMAIL_TO_STORE: Record<string, { storeIndex: number; storeName: string }> = {
  'amazon@salutem.solutions': { storeIndex: 1, storeName: 'Salutem Solutions' },
  'kuzy.vladimir@gmail.com': { storeIndex: 2, storeName: 'Vladimir Personal' },
  // Phase 2+: добавить остальные аккаунты
};

/** Типы уведомлений для логирования и фильтрации */
export type NotificationType =
  | 'buyer_message'
  | 'chargeback'
  | 'return'
  | 'refund'
  | 'delivery_failure'
  | 'buyer_abuse'
  | 'buyer_optout'
  | 'listing_issue'
  | 'pricing_alert'
  | 'inbound_problem';
```

## Файлы для чтения перед началом работы
- `CLAUDE.md`
- `docs/AMAZON_NOTIFICATIONS_MAP.md`
- `docs/CUSTOMER_HUB_ALGORITHM_v2.1.md`

## Что НЕ делать
- НЕ менять логику существующих парсеров
- НЕ создавать новые парсеры (Phase 1.5 / Phase 2)
- НЕ удалять существующий код
