# 📨 Telegram-уведомления: аудит и маршрутизация (2026-06-08)

> Решение Владимира: кроны захламляли личку бота Джеки и мешали диалогу.
> Провели аудит всех Telegram-отправок и развели потоки. Источник правды по
> тому, кто и куда шлёт.

## 🔴 Корень проблемы

В коде (`src/lib/telegram.ts`) уже заложена маршрутизация по отдельным
чатам/топикам, НО на Vercel заданы только две переменные:
`TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID` (личка Джеки). У всех остальных
каналов стоит «fallback в личку» → **всё валилось в ЛС Джеки**.

Дополнительно: у бота настроен **webhook** (на OpenClaw-сервере, где живут
Telegram-боты), поэтому `getUpdates` и кнопка «Discover Telegram IDs» на
`/settings` возвращают пусто — апдейты забирает webhook. Авто-дискавери id
групп через Bot API недоступен, пока webhook активен.

## 📋 Все Telegram-отправки

### Кроны по расписанию (Vercel `vercel.json`)

| Источник | Расписание | Функция | Сообщение |
|---|---|---|---|
| walmart-cancellation-watchdog | каждые 30 мин | `sendWalmartTelegram` | новые запросы на отмену Walmart |
| walmart-ship-confirm | 02/03/10:00 | `sendWalmartTelegram` | сводка авто-ship-confirm |
| walmart-quantity-inquiry-poll | 14:00, 22:00 | `sendWalmartTelegram` | запросы покупателей по количеству |
| reprice-amazon | каждые 2 ч (:45) | `sendTelegramMessage` | сводка репрайсера (только при изменениях) |
| account-health-amazon | 07:00 | `sendCriticalAlert` | критические алерты здоровья |
| account-health-walmart | 11:00 | `sendCriticalAlert` | критические алерты здоровья |

Кроны БЕЗ Telegram (не трогали): walmart-sync, orders-amazon/walmart,
orders-shipments-amazon, adjustments-amazon, frozen-analysis,
walmart-listing-quality, walmart-reports.

### Не на расписании Vercel (триггерятся вручную / n8n)

| Источник | Когда | Сообщение |
|---|---|---|
| procurement-priority | по триггеру | приоритетные заказы на закупку |
| frozen morning-summary | 07:00 ET (n8n) | утренняя сводка frozen (маршрут задаётся в n8n) |
| shipping/buy | покупка лейблов | сводка по купленным лейблам |
| bundle-factory publish | публикация бандла | успех / первая публикация / провал |

## ✅ Решения Владимира (2026-06-08)

| Поток | Решение |
|---|---|
| **Walmart-операционка** (watchdog / ship-confirm / quantity) | → отдельная группа/топик (НЕ личка) |
| **Репрайсер Amazon** | → не слать |
| **Account Health алерты** (Amazon + Walmart) | → не слать |
| **Закупки** (procurement-priority) | → оставить как есть (личка) |
| **Ручные сводки** (shipping buy, bundle publish) | → не слать |

## 🔧 Реализация

«Не слать» сделано через **env-флаги-выключатели** (по умолчанию OFF), а не
удалением кода — чтобы любой поток можно было вернуть одной переменной на
Vercel без правки кода. UI-строки и бизнес-логика НЕ трогались: например,
строки `CriticalAlert` для Account Health по-прежнему создаются (видны в UI),
гейтится только Telegram-пуш.

Флаги (`.env.example`):

| Флаг | Поток | По умолчанию |
|---|---|---|
| `TELEGRAM_REPRICE_ENABLED` | reprice-amazon | OFF |
| `TELEGRAM_HEALTH_ALERTS_ENABLED` | account-health критические алерты | OFF |
| `TELEGRAM_SHIPPING_BUY_ENABLED` | shipping/buy сводка | OFF |
| `TELEGRAM_BUNDLE_PUBLISH_ENABLED` | bundle publish (успех/первая/провал) | OFF |

Маршрутизация Walmart (остаётся ВКЛ, но в группу):

| Переменная | Назначение |
|---|---|
| `TELEGRAM_WALMART_CHAT_ID` | id супергруппы (-100…) для Walmart-операционки |
| `TELEGRAM_WALMART_THREAD_ID` | опц. id топика внутри группы |

Чтобы Walmart-поток ушёл из лички в группу — задать `TELEGRAM_WALMART_CHAT_ID`
на Vercel (production) и сделать redeploy. Без неё работает старый fallback в
личку.

## 📝 Затронутые файлы

- `src/app/api/cron/reprice-amazon/route.ts` — гейт `TELEGRAM_REPRICE_ENABLED`
- `src/lib/account-health/critical-alert-evaluator.ts` — гейт `TELEGRAM_HEALTH_ALERTS_ENABLED` (строки в БД сохраняются)
- `src/app/api/shipping/buy/route.ts` — гейт `TELEGRAM_SHIPPING_BUY_ENABLED`
- `src/lib/bundle-factory/distribution/distribution-pipeline.ts` — гейт `TELEGRAM_BUNDLE_PUBLISH_ENABLED`
- `.env.example` — документация флагов + Walmart-маршрутизации

## Связано с
- [Telegram Notifications](telegram-notifications.md) — базовая интеграция отправки сообщений
- [Critical Alerts Engine](critical-alerts.md) — один из потоков, разводимых по чатам
