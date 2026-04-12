# 🎯 Customer Hub — Модуль

## Суть
Единая страница с 4 табами (Messages, A-to-Z, Chargebacks, Feedback), заменяющая отдельные legacy страницы `/customer-service`, `/claims/atoz`, `/feedback`. Данные из Gmail API + Amazon SP-API. AI Decision Engine на 5 слоёв.

## Путь в приложении
`/customer-hub` — **в активной разработке**

## 4 таба

| Таб | Источник | Обогащение | Действие |
|-----|----------|------------|----------|
| Messages | Gmail API (`@marketplace.amazon.com`) | SP-API Orders + Veeqo tracking | Claude анализ → SP-API Messaging |
| A-to-Z | SP-API Reports (`GET_CLAIM_DATA`) | SP-API Orders (трекинг) | Генерация ответа → SP-API |
| Chargebacks | Gmail (`cb-seller-notification@amazon.com`) | SP-API Orders | Генерация ответа → email |
| Feedback | SP-API Reports (`GET_SELLER_FEEDBACK_DATA`) | — | Request Removal / ответ |

## Decision Engine (5 слоёв)
1. **Классификация** — тип проблемы T1-T20
2. **Риск** — оценка A-to-Z/chargeback риска
3. **Решение** — замена/возврат/эскалация
4. **Чеклист** — что нужно сделать
5. **Кто платит** — мы/carrier/Amazon

## Walmart
Временно через скриншоты (модальное окно), пока нет Walmart API ключа.

## Связанные файлы
- `src/app/customer-hub/page.tsx` — UI
- `src/app/api/customer-hub/` — API routes (messages, atoz, chargebacks, feedback, stats)
- `src/components/customer-hub/` — компоненты
- `src/lib/customer-hub/` — gmail-parser, message-enricher, message-analyzer, response-sender
- `src/lib/claude.ts` — AI Decision Engine
- `docs/CUSTOMER_HUB_ALGORITHM_v2.1.md` — полный алгоритм

## DB модели
- `BuyerMessage` — сообщения покупателей
- `AtozzClaim` — A-to-Z + Chargebacks
- `SellerFeedback` — отзывы продавца
- `ProductReview` — отзывы на товар

## 🔗 Связи
- **Зависит от:** [Gmail API](gmail-api.md), [Amazon SP-API](amazon-sp-api.md), [Claude AI](claude-ai.md), [Veeqo API](veeqo-api.md), [Amazon Notifications Map](amazon-notifications-map.md) (источники и приоритеты email-уведомлений)
- **Используется в:** [Dashboard](dashboard.md)
- **Связанные модули:** [A-to-Z & Chargeback](atoz-chargeback.md), [Feedback Manager](feedback-manager.md), [Frozen Analytics](frozen-analytics.md)
- **Заменяет:** Legacy `/customer-service`, `/claims/atoz`, `/feedback`
- **См. также:** [Decision Engine](customer-hub-decision-engine.md), [Database Schema](database-schema.md)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
