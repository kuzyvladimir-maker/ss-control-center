# Shipping Service Mismatch Prevention Rule

## Правило

IF customer selected expedited shipping (Next Day, Two-Day, Priority)
AND expedited service NOT available from any carrier
THEN:
  → DO NOT SHIP with standard service
  → CONTACT CUSTOMER: "The expedited shipping option you selected is currently
     unavailable for your area. Would you like us to proceed with standard
     shipping or cancel the order?"
  → OR CANCEL ORDER if customer doesn't respond within 12 hours

## Обоснование

Отправка заказа другим сервисом чем заказал клиент приводит к:
- Недовольству клиента (80% вероятность)
- Refund/return (высокая вероятность)
- Negative feedback или A-to-Z claim
- Потеря: товар + доставка + возврат

Реальный кейс (Deborah, Apr 2026): клиент заплатил $62 за Next Day, отправили
UPS Ground, товар придёт через 5 дней. Клиент хочет cancel, но это невозможно
(заказ уже в пути). Следствия: недовольство, возможный A-to-Z claim, потенциальный
return. См. wiki-статью `docs/wiki/amazon-notifications-map.md` и seed-запись
в `KnowledgeBaseEntry` (tag `shipping_mismatch`).

## Реализация (Phase 2)

В Shipping Labels модуле при генерации плана:
1. Проверить `requested shipping service` из Amazon order (SP-API
   `ShipmentServiceLevelCategory` / `ShippingService`)
2. Сравнить с доступными rates от Veeqo
3. Если mismatch → пометить заказ HOLD + уведомить Владимира
4. Через Telegram отправить алерт: "Order {orderId} requested {service} но
   Veeqo не даёт expedited rate. Action: hold + contact customer?"
5. Автоматический hold на 12 часов, после — cancel через SP-API

## Связанные артефакты
- `src/lib/customer-hub/message-enricher.ts` — определение `shippingMismatch` в
  реальном времени для входящих сообщений (T21 classification)
- `src/lib/customer-hub/message-analyzer.ts` — SYSTEM_PROMPT содержит
  SHIPPING MISMATCH rules + пример ответа
- `src/lib/customer-hub/knowledge-base.ts` — seed entry с canonical T21
  ответом
- `docs/CUSTOMER_HUB_ALGORITHM_v2.2.md` — общий алгоритм Customer Hub
- `docs/AMAZON_NOTIFICATIONS_MAP.md` — маппинг Amazon уведомлений → модули

## История
- 2026-04-11: Правило создано по итогам аудита Customer Hub (кейс Deborah).
  Customer Hub теперь детектит T21 и показывает policy warning, генерирует
  правильный ответ через knowledge base. Phase 2 — превенция на уровне
  Shipping Labels.
