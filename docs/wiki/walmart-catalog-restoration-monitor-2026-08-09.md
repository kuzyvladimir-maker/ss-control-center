# Walmart catalog restoration monitor — 2026-08-09

## Назначение

Этот монитор отвечает на один операционный вопрос: вернулось ли на публичной
витрине Walmart покупаемое предложение продавца **STARFITSTORE / SIRIUS TRADING
INTERNATIONAL LLC** после приостановки каталога.

Seller API для этой проверки недостаточно. Во время приостановки он продолжал
показывать отдельные SKU как `PUBLISHED`, `ACTIVE` и `IN_STOCK`, хотя покупатель
видел другого продавца либо `Not Available`. Поэтому источник результата —
публичная buyer-PDP конкретного Walmart item, а не внутренний статус листинга.

## Контрольная выборка

Монитор проверяет три старых SKU, по которым были недавние продажи:

| Seller SKU | Walmart item ID | Последняя подтверждённая продажа |
|---|---:|---|
| `RizwanX-198` | `168645059` | 2026-08-07 |
| `FaisalX-1142` | `8412902252` | 2026-08-07 |
| `FaisalX-1884` | `9608853551` | 2026-08-06 |

Связка `seller SKU → UPC → Walmart item ID` была разрешена через seller item API
и Walmart catalog search 2026-08-09. Публичная identity продавца взята из
сохранённой buyer-PDP от 2026-08-01, когда предложение было доступно:

- seller legal name: `SIRIUS TRADING INTERNATIONAL LLC`;
- seller display name: `STARFITSTORE`;
- seller ID: `AAF796A61B674A8E93906B5A41C19CDB`;
- catalog seller ID: `101604958`.

## Что считается восстановлением

SKU получает статус `AVAILABLE` только при одновременном выполнении условий:

1. В primary, secondary или top-boosted offers найдено точное предложение нашего
   продавца по ID либо известному имени.
2. Статус предложения — `IN_STOCK` или `AVAILABLE`.
3. Shipping availability — `IN_STOCK` или `AVAILABLE`.
4. У предложения есть положительная цена.
5. Для primary offer Walmart разрешает Add to Cart.

Наличие товара у другого продавца не является восстановлением нашего каталога.
Captcha, bot wall, неожиданная структура страницы, другой item ID или неверная
canonical URL дают `UNKNOWN`, но никогда ложный `AVAILABLE`.

## Исполнение и уведомления

- Production route: `GET /api/cron/walmart-offer-restoration`.
- Расписание Vercel: `17 */4 * * *`, то есть каждые четыре часа на 17-й минуте.
- Проверка бесплатная: три прямых read-only GET к walmart.com, без Oxylabs,
  Unwrangle и других платных провайдеров.
- Монитор ничего не записывает в Walmart и не меняет листинги, цены или остатки.
- Состояние сохраняется в `Setting` под ключом
  `walmart:offer-restoration-monitor:store1:v1`.
- Telegram отправляется только при первом наблюдении `AVAILABLE` или при переходе
  из `UNAVAILABLE`/`UNKNOWN` в `AVAILABLE`; повторные циклы не спамят.
- Событие сначала записывается как pending. Если Telegram временно недоступен,
  следующий cron повторит только уведомление, не теряя обнаруженное восстановление.

## Реализация и проверка

- `src/lib/walmart/offer-restoration-monitor.ts` — строгий parser, identity match,
  конечный автомат и текст уведомления.
- `src/app/api/cron/walmart-offer-restoration/route.ts` — cron orchestration,
  сохранение состояния и Telegram.
- `src/lib/walmart/__tests__/offer-restoration-monitor.test.ts` — защита от
  ложного срабатывания на другого продавца, primary/secondary offer, bot wall и
  повторные уведомления.

До выпуска локально подтверждено: все три текущие PDP определяются как
`UNAVAILABLE / OWN_OFFER_NOT_PRESENT`, даже когда товар доступен у другого
продавца. Историческая живая PDP нашего продавца определяется как
`AVAILABLE / OWN_OFFER_BUYABLE`.

## Production activation

- Source commit: `a64554691e92c443c64d00e6886cee330775733b`.
- Production deployment: `dpl_499vv5vWy7QGjtMA3sfkHvU4sMBM`, status `READY`,
  основной alias `salutemsolutions.info` обслуживает этот deployment.
- `vercel crons ls` подтвердил регистрацию
  `/api/cron/walmart-offer-restoration` с расписанием `17 */4 * * *`.
- Первый авторизованный production run вернул HTTP 200: `available=0`,
  `unavailable=3`, `unknown=0`; все три SKU —
  `OWN_OFFER_NOT_PRESENT`, ошибок нет.
- Контрольный run подтвердил `paidProviderCalls=0`, `walmartWrites=0`; Telegram
  не вызывался, потому что перехода в `AVAILABLE` ещё не было.
