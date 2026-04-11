# ⭐ Feedback Manager

## Суть
Мониторинг, AI-классификация и управление Seller Feedback и Product Reviews на Amazon. Определение удаляемости, генерация запросов удаления и публичных ответов.

## Категории удаления
- `PRODUCT_REVIEW` — отзыв о товаре (не о продавце)
- `CARRIER_DELAY` — жалоба на доставку
- `OBSCENE` — нецензурная лексика
- `PERSONAL_INFO` — персональные данные
- `PROMOTIONAL` — рекламный контент
- `PRICING_ONLY` — только о цене

## Действия
- Request Removal (через Amazon)
- Contact Buyer (попросить удалить)
- Respond Publicly
- Monitor (ничего не делать)

## Связанные файлы
- Часть [Customer Hub](customer-hub.md) (таб Feedback)
- `src/app/api/customer-hub/feedback/` — API
- `docs/FEEDBACK_MANAGER_v1.0.md` — полный алгоритм

## DB модели
- `SellerFeedback` — отзывы продавца
- `ProductReview` — отзывы на товар

## 🔗 Связи
- **Зависит от:** [Amazon SP-API](amazon-sp-api.md), [Claude AI](claude-ai.md)
- **Влияет на:** [Account Health](account-health.md) (Negative Feedback → ODR)
- **Часть:** [Customer Hub](customer-hub.md)
- **Бизнес-правило:** Никогда не предлагать скидки/компенсации за изменение отзыва

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
