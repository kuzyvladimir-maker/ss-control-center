# 🧠 Customer Hub Decision Engine

## Суть
AI-движок классификации и принятия решений по обращениям покупателей. 5 слоёв анализа, работает через Claude API.

## 5 слоёв

### Слой 1: Классификация (Problem Type T1-T20)
Определение типа проблемы: where is my order, damaged, spoiled, wrong item, missing item, etc.

### Слой 2: Оценка риска
A-to-Z risk (HIGH/MEDIUM/LOW), food safety risk (boolean), urgency.

### Слой 3: Решение
Action: REPLACEMENT, REFUND, A2Z_GUARANTEE, ESCALATE, INFO, PHOTO_REQUEST.

### Слой 4: Чеклист
Internal actions: что нужно проверить/сделать перед ответом.

### Слой 5: Кто платит
WHO_SHOULD_PAY: us / carrier / Amazon / buyer.

## Связанные файлы
- `src/lib/customer-hub/message-analyzer.ts` — реализация
- `src/lib/claude.ts` — Claude API клиент
- `docs/CUSTOMER_HUB_ALGORITHM_v2.1.md` — полное описание

## 🔗 Связи
- **Часть:** [Customer Hub](customer-hub.md)
- **Зависит от:** [Claude AI](claude-ai.md), [Amazon SP-API](amazon-sp-api.md) (данные заказа для контекста)
- **Влияет на:** [A-to-Z & Chargeback](atoz-chargeback.md) (risk assessment)
- **См. также:** [Frozen shipping rules](frozen-shipping-rules.md) (food safety)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
