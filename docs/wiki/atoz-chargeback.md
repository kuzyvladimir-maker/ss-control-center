# ⚖️ A-to-Z & Chargeback Management

## Суть
Автоматический мониторинг, сбор доказательств и защита от A-to-Z Guarantee Claims и Chargebacks. Каждый проигранный кейс = прямые убытки + ухудшение ODR. Приоритет: CRITICAL.

## Типы претензий
| Тип | Источник | Deadline | Влияние |
|-----|---------|---------|---------|
| A-to-Z | Amazon | 3-7 дней | Убыток + ODR |
| Chargeback | Банк через Amazon | 3-7 дней | Убыток + fee |

## Стратегии защиты
- `BUY_SHIPPING_PROTECTION` — если label куплен через Buy Shipping
- `PROOF_OF_DELIVERY` — подтверждение доставки
- `INR_DEFENSE` — защита от "Item Not Received"
- `CARRIER_DELAY_DEFENSE` — задержка carrier
- `MANUAL_REVIEW` — ручная проверка

## Связанные файлы
- Часть [Customer Hub](customer-hub.md) (табы A-to-Z и Chargebacks)
- `src/lib/claims/strategy.ts` — стратегии защиты
- `src/app/api/customer-hub/atoz/`, `chargebacks/` — API
- `docs/ATOZ_CHARGEBACK_MANAGEMENT_v1.0.md` — полный алгоритм

## DB модель
- `AtozzClaim` — Status: NEW → EVIDENCE_GATHERED → RESPONSE_READY → SUBMITTED → DECIDED → APPEALED → CLOSED

## 🔗 Связи
- **Зависит от:** [Amazon SP-API](amazon-sp-api.md), [Gmail API](gmail-api.md) (chargebacks), [Claude AI](claude-ai.md), [Amazon Notifications Map](amazon-notifications-map.md) (chargebacks — только канал через Gmail, нет в SP-API)
- **Влияет на:** [Account Health](account-health.md) (ODR: A-to-Z rate + Chargeback rate)
- **Часть:** [Customer Hub](customer-hub.md)
- **См. также:** [Carrier selection rules](carrier-selection-rules.md) (Claims Protected badge)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
