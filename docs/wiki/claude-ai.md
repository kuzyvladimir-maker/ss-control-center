# 🤖 Claude AI — Интеграция

## Суть
Anthropic Claude API (claude-sonnet-4-20250514) для AI-анализа сообщений покупателей, генерации ответов, классификации отзывов, оценки удаляемости.

## Использование
- **Customer Hub:** Decision Engine (5 слоёв анализа), генерация ответов
- **Feedback Manager:** классификация удаляемости, генерация запросов удаления
- **A-to-Z/Chargeback:** генерация ответов на претензии

## Связанные файлы
- `src/lib/claude.ts` — API клиент
- `src/lib/customer-hub/message-analyzer.ts` — анализ сообщений

## 🔗 Связи
- **Используется в:** [Customer Hub](customer-hub.md), [Decision Engine](customer-hub-decision-engine.md), [Feedback Manager](feedback-manager.md), [A-to-Z & Chargeback](atoz-chargeback.md)
- **См. также:** [External API Auth](external-api-auth.md)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
