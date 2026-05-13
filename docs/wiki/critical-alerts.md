# Critical Alerts Engine

Система мгновенных уведомлений в Telegram + UI push при пересечении критических порогов на Amazon и Walmart.

⊂ [Account Health v2.0](account-health-v2.md)
⇔ [Telegram Notifications](telegram-notifications.md)

---

## Принцип работы

При каждом sync (Amazon каждые 4ч, Walmart каждые 24ч) после сохранения snapshot вызывается `evaluateCriticalAlerts()`:

1. Для каждого правила из `ALERT_RULES` проверяется значение метрики из нового snapshot
2. Если порог пересечён И за последние 24ч такого же алерта не было — создаётся `CriticalAlert` запись
3. Если severity = `CRITICAL` или `HIGH` — алерт сразу отправляется в Telegram
4. UI получает алерт через polling `GET /api/alerts/unacknowledged` (раз в 30 сек)
5. Колокольчик в топбаре показывает счётчик · клик → popover со списком

---

## Severity levels

| Severity | Telegram | UI push | Когда |
|---|---|---|---|
| **CRITICAL** | ✅ | ✅ | Метрика пересекла критический порог Amazon/Walmart (грозит блокировкой) |
| **HIGH** | ✅ | ✅ | Метрика пересекла warning порог; новые Listing Policy violations |
| **WARNING** | ❌ | ✅ | Метрика приближается к порогу, но ещё не превысила |

---

## Правила (выборка)

### Amazon — CRITICAL
| Метрика | Порог | Источник |
|---|---|---|
| Account Health Rating | ≤ 200 | SP-API |
| Order Defect Rate | ≥ 1% | SP-API |
| Late Shipment Rate (30d) | ≥ 4% | SP-API |
| Pre-fulfillment Cancel Rate (7d) | ≥ 2.5% | SP-API |
| Valid Tracking Rate (30d) | ≤ 95% | SP-API |
| On-Time Delivery Rate (14d) | ≤ 90% | SP-API |
| Новые Food Safety нарушения | ≥ 1 | SP-API Reports |
| Новые Suspected IP нарушения | ≥ 1 | SP-API Reports |

### Amazon — HIGH
| Метрика | Порог |
|---|---|
| Новые Listing Policy нарушения | ≥ 1 |

### Walmart — CRITICAL
| Метрика | Порог |
|---|---|
| Late shipment (30d) | ≥ 5% |
| Cancellations (30d) | ≥ 2% |
| Valid tracking (30d) | ≤ 99% |
| On-time delivery (30d) | ≤ 90% |
| Seller response (30d) | ≤ 95% |

### Walmart — HIGH
| Метрика | Порог |
|---|---|
| Negative feedback (60d) | ≥ 2% |
| Returns (60d) | ≥ 6% |
| Item not received (60d) | ≥ 2% |
| Новые Item Compliance issues | ≥ 1 |

> Полный список — см. `src/lib/account-health/alert-rules.ts`.

---

## Anti-spam логика

- Не дублировать алерт того же типа в течение **24 часов** для того же магазина
- При resolve алерта (POST `/api/alerts/:id/resolve`) cooldown сбрасывается
- Telegram отправка идёт **только при создании** записи `CriticalAlert` — даже если алерт не acknowledged, повторно в Telegram не уходит

---

## Acknowledgment workflow

1. Алерт создан → telegram отправлен → UI push (toast)
2. Пользователь видит в топбаре badge с числом → клик → popover
3. По каждому алерту 2 действия:
   - **Acknowledge** — "я увидел, разбираюсь" (alert исчезает из топбара, остаётся в истории)
   - **Resolve** — "проблема устранена" (полностью закрывает алерт, может срабатывать заново)

---

## БД модель

```prisma
model CriticalAlert {
  id, storeId, channel, alertType, severity
  metricName, metricValue, metricThreshold
  title, message, actionUrl
  detectedAt
  telegramSent, telegramSentAt, telegramMessageId
  acknowledged, acknowledgedAt, acknowledgedBy
  resolvedAt
}
```

---

## Связи

- ⊂ [Account Health v2.0](account-health-v2.md)
- ⇔ [Telegram Notifications](telegram-notifications.md)
- → [Dashboard](dashboard.md) (счётчик алертов в Health Issues card)
- → Topbar `CriticalAlertsBell` компонент

---

## Implementation status (2026-05-12)

| Компонент | Статус |
|---|---|
| `ALERT_RULES` (17 правил Amazon + Walmart) | ✅ `src/lib/account-health/alert-rules.ts` |
| Evaluator с 24h dedup window | ✅ `src/lib/account-health/critical-alert-evaluator.ts` |
| Telegram delivery (`sendCriticalAlert`) | ✅ `src/lib/telegram.ts` (fallback на `TELEGRAM_CHAT_ID`) |
| UI bell + acknowledge/resolve | ✅ `src/components/critical-alerts/CriticalAlertsBell.tsx` |
| `CriticalAlert` Prisma model | ✅ местная + Turso prod |
| Toast при появлении нового алерта | ❌ Не реализован (`sonner` toast — отложен, UI bell счётчик показывает) |

### Telegram chat

Текущее поведение:
- читается `TELEGRAM_ALERT_CHAT_ID`;
- если не задан → fallback на `TELEGRAM_CHAT_ID` + `console.warn` breadcrumb.

Чтобы выделить алерты в отдельный чат: создать новый Telegram-чат / topic, прописать `TELEGRAM_ALERT_CHAT_ID=<chat_id>` в env (local + Vercel prod).

---

Последнее обновление: 2026-05-12
