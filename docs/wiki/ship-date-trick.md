# 📅 Ship Date Trick (Frozen Monday-shift)

## Суть
Для Frozen-заказов жёсткое ограничение «3 календарных дня от отгрузки до доставки» часто оставляет в выборке только варианты с Saturday surcharge ($15-25 дороже плана). Сдвиг фактической даты отгрузки на следующий понедельник часто открывает более дешёвую обычную будничную ставку, которая по-прежнему укладывается и в 3-дневное правило (теперь от понедельника), и в дедлайн маркетплейса.

Алгоритм автоматический — оператор ничего не делает руками.

> **Связь с Master Prompt:** [MASTER_PROMPT_v3.1 §7](../MASTER_PROMPT_v3.1.md) описывает этот трюк подробно для Чт и Пт (раздел "ЧЕТВЕРГ — ключевой алгоритм" / "ПЯТНИЦА — детальный алгоритм"). Мой код — упрощённая универсальная версия:
>
> - Master Prompt §7 строго привязан к дням недели (Чт/Пт)
> - Мой код срабатывает в **любой будний день кроме понедельника** при условии (нет рейта **ИЛИ** в лучшем рейте Saturday surcharge)
> - Master Prompt предписывает в Чт сначала проверить субботнюю доставку, потом трюк
> - Мой код проверяет цену лучшей ставки с Sat-surcharge против цены Monday-rate, выбирает дешевле
>
> На практике результат тот же — если суббота дешевле понедельника, она и выбирается на шаге обычного `selectBestRate`, до того как трюк трогнет dispatch_date.

## Когда триггерится
Условия в [plan/route.ts](../../ss-control-center/src/app/api/shipping/plan/route.ts):

```
productType === "Frozen"
  && dayInfo.dayName !== "Mon"     // не сегодня = понедельник
  && monDeadlineDays >= 3           // Monday + 3 ≤ Delivery By
  && (
       selectedRate === null            // сегодня вообще нет ставок
       || /saturday/i.test(rate.title)  // лучшая ставка с Sat surcharge
     )
```

## Алгоритм (внутри `/api/shipping/plan`)
1. Запоминаем `originalDispatch = order.dispatch_date` (Veeqo).
2. `PUT /orders/{id}` с `dispatch_date = nextMonday T06:59:59Z`.
3. Ждём 800ms — Veeqo асинхронно пересчитывает кэш rates allocation'а.
4. `GET /shipping/rates/{allocationId}` → новый набор ставок.
5. Прогоняем тот же `selectBestRate` с `actualShipDay = nextMonday`,
   `dayName = "Mon"`.
6. Сравниваем цены: если `mondayPrice < todayPrice` → принимаем
   понедельничную ставку, в `actualShipDay` записываем понедельник,
   в `notes` — `Shifted to Mon YYYY-MM-DD: saved $X.XX`.
7. **Всегда** в `finally` восстанавливаем `dispatch_date = originalDispatch`
   (даже если PUT не выполнялся → блок защищён от частичного fail).

Veeqo на стороне модели заказа в `plan` остаётся неизменным.

## Алгоритм (внутри `/api/shipping/buy`)
Когда оператор подтверждает покупку:
1. Если `item.actualShipDay > today` → `PUT /orders/{id}` с
   `dispatch_date = item.actualShipDay T06:59:59Z` (сдвигаем постоянно).
2. Покупаем label (`buyShippingLabel`).
3. В employee note добавляется badge `📅 SHIP ON YYYY-MM-DD`,
   чтобы складской работник знал не отдавать посылку курьеру сегодня.
4. PDF сохраняется в папку `Shipping Labels / MM Month / DD / Channel`
   по `actualShipDay` (т.е. в понедельничную папку).

Шаг 1 non-fatal — если PUT упадёт, Veeqo вернёт label с исходной
датой; складской работник всё равно увидит ship-day badge в note.

## Защитные ограничения
- **dayName !== "Mon"** — если сегодня уже понедельник,
  `getNextMonday(today)` вернёт +7 дней (через неделю). Это слишком
  далеко; такие заказы должны выходить в `stop` и обрабатываться
  вручную.
- **monDeadlineDays >= 3** — иначе понедельник + 3 уже превышает
  дедлайн маркетплейса, никакая ставка не подойдёт.
- **try/catch/finally** — любая ошибка trick'а не валит весь plan;
  откатываемся на сегодняшнюю ставку (если она есть).
- **CRITICAL log** — если восстановление `dispatch_date` провалится,
  это уникальный сценарий "Veeqo в неконсистентном состоянии";
  лог-маркер `CRITICAL: failed to restore dispatch_date` для grep.

## Связанные файлы
- [plan/route.ts](../../ss-control-center/src/app/api/shipping/plan/route.ts) — основной алгоритм
- [buy/route.ts](../../ss-control-center/src/app/api/shipping/buy/route.ts) — применение даты при покупке
- [veeqo/client.ts](../../ss-control-center/src/lib/veeqo/client.ts) — `updateOrderDispatchDate()`

## 🔗 Связи
- **Часть:** [Shipping Labels](shipping-labels.md), [Выбор ставки](shipping-rate-selection.md)
- **Зависит от:** [Frozen Shipping Rules](frozen-shipping-rules.md), [Timezone правила](timezone-rules.md), [Veeqo API](veeqo-api.md)
- **Связан с:** [Weekend распределение](weekend-distribution.md), [Frozen Analytics](frozen-analytics.md)

## История
- 2026-05-14: Реализован полностью (раньше алгоритм лишь помечал
  `stopReason = "Handle manually"`). Триггерится не только при
  отсутствии ставок, но и при Saturday surcharge в лучшей ставке.
