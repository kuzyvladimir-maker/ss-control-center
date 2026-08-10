# Walmart channel suspension — 2026-08-10

## Решение владельца

10 августа 2026 года владелец сообщил, что Walmart marketplace account
заблокирован, и поручил остановить все cron-задачи, мониторинги, тестирование и
автоматические действия, относящиеся к каналу продаж Walmart.

Это **обратимая остановка**, а не удаление реализации. Исторические листинги,
черновики, API-адаптеры, Product Truth evidence и журналы сохранены.
Остановленный предшествующий монитор описан в
[Walmart catalog restoration monitor](./walmart-catalog-restoration-monitor-2026-08-09.md).

## Что остановлено

- Из `vercel.json` удалены все 12 Walmart-specific schedule entries:
  основной sync, account health, orders, три ship-confirm запуска,
  cancellation watchdog, quantity inquiry, listing quality, offer-restoration
  monitor, reports и catalog report.
- Удалено расписание `bundle-factory-publish`: сегодня оно обслуживает только
  Walmart.
- Общий `bundle-factory-poll-pending` продолжает обслуживать Amazon, но явно
  исключает `ChannelSKU.channel = WALMART`.
- Общий `bundle-factory-tick` продолжает обслуживать Amazon, но не выбирает
  Walmart GenerationJob.
- Общий weekly Finance Funds продолжает Amazon ingest, но больше не запускает
  Walmart payout ingest.
- В production `Store(channel=Walmart)` переведён в `active=false`.
- В production установлены:
  - `Setting.walmart_factory_paused = true`;
  - `Setting.walmart_channel_suspended = {status:SUSPENDED,...}`.
- Открытых Walmart `PublishBatch` на момент остановки не было; предусмотренное
  обновление переводит такие партии в `PAUSED`.
- Bundle Factory показывает Walmart как suspended и не даёт выбрать канал.
- API создания Walmart build возвращает `423 WALMART_CHANNEL_SUSPENDED` до
  получения shipping templates, Product Truth enrichment или иных действий.
- `WalmartClient` проверяет source-controlled circuit breaker до OAuth и до
  любого marketplace API request. Наличие сохранённых credentials само по себе
  не может возобновить обращения.

## Что намеренно не остановлено

Product Truth worker остаётся запущенным. Это единый, независимый от каналов
донорский каталог для Bundle Factory, Unit Economics, Procurement и других
каналов. Он не является Walmart sales-channel automation. Отдельного локального
Walmart worker/LaunchAgent на момент проверки не было.

## Зафиксированное production-состояние

- Walmart stores деактивировано: `1`.
- Открытых Walmart publish batches переведено в pause: `0` (их не было).
- Walmart generation jobs в `PENDING/IN_PROGRESS`: `0`.
- Pollable Walmart ChannelSKU сохранено без изменения: `10`; cron их больше не
  опрашивает.
- В новом cron manifest остаётся 14 задач, ни одна не содержит `walmart`, и
  Walmart-only `bundle-factory-publish` отсутствует.

## Как возобновлять канал

Возобновление не должно происходить автоматически после возврата account health.
Нужна отдельная команда владельца и последовательный controlled reactivation:

1. Получить подтверждение Walmart, что account и catalog снова активны.
2. Проверить credentials read-only вызовом и buyer-facing availability на
   нескольких старых SKU.
3. Переключить source-controlled `WALMART_CHANNEL_SUSPENDED` только отдельным
   кодовым изменением с тестами и deployment.
4. Вернуть `Store.active=true` и снять `walmart_factory_paused`.
5. Вернуть только необходимые schedules; сначала read-only health/orders,
   затем polling, и лишь после отдельного решения владельца — publishing.
6. Выполнить один controlled canary и проверить buyer page. Feed acceptance не
   считается доказательством доступности покупателю.

До прохождения всех шагов Walmart остаётся fail-closed.
