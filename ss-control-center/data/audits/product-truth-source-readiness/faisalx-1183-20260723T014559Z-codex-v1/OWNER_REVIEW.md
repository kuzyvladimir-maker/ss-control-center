# Product Truth source review — FaisalX-1183

Дата проверки: 2026-07-23  
Режим: READ ONLY  
Walmart listing writes: 0  
Amazon/Walmart report-create calls: 0

## Что уже доказано

- `FaisalX-1183` — опубликованный Walmart SKU с товаром **Pepperidge Farm Butter Hot Dog Buns, 8-count, Pack of 6**.
- Текущая legacy Product Truth привязка ошибочна: она указывает на **Pepperidge Farm Chessmen Butter Cookies**. Эту запись нельзя переносить в canonical Product Truth.
- Найден точный content-candidate: **Pepperidge Farm Bakery Classics Top Sliced Butter Hot Dog Buns, 14 oz / 8-count**, UPC `014100050162`. У него есть восемь изображений и direct Target offer, но canonical identity ещё не утверждена.
- Предложенная MAIN-картинка из шести точных упаковок уже визуально одобрена владельцем. В Walmart она пока не отправлялась.
- Product Truth schema v3 активирована: 8/8 migrations применены и сертифицированы. Business-data backfill ещё не выполнялся.
- Новый bounded GET-only probe от 2026-07-23 вернул HTTP 200. Его первая страница полностью покрывает последние 24 часа; все десять записей — ITEM v2. Свежего API-visible ITEM v6 за это окно нет. Report-create calls = 0.

## Состояние магазинов и отчётов

| Канал / scope | Магазин | Фактическое состояние | Рекомендация |
|---|---|---|---|
| Amazon `store1` | Salutem Solutions | SP-API работает; свежий полный report, 1 563 строки | `CONNECTED` + `IN_SCOPE` |
| Amazon `store2` | Vladimir Personal | Последний заказ 2026-05-18; SP-API отвечает 403; seller ID отсутствует | Владелец должен подтвердить: это действующий магазин или старое отключённое подключение |
| Amazon `store3` | AMZ Commerce | SP-API работает; свежий полный report, 514 строк | `CONNECTED` + `IN_SCOPE` |
| Amazon `store4` | Sirius International | Последний заказ 2026-05-11; credentials и seller ID отсутствуют | Владелец должен подтвердить: это действующий магазин или старое отключённое подключение |
| Amazon `store5` | Retailer Distributor | Credentials есть, но US participation отсутствует; свежий report пуст; последнее состояние `DEACTIVATED` | `CONNECTED` + `EXCLUDED_OWNER_CONFIRMED` |
| Walmart `store1` | SIRIUS TRADING INTERNATIONAL LLC | Подключён и активен | `CONNECTED` + `IN_SCOPE`; нужен свежий ITEM v6 report |

Точные Amazon report bytes уже сохранены для `store1`, `store3` и `store5`; создавать их повторно не нужно.

Walmart list endpoint игнорирует запрошенный `reportVersion=v6` и возвращает ITEM v2. Поэтому версия проверена по каждой фактической строке ответа, а не по query-параметру.

## Единственное оставшееся решение владельца

Если `Vladimir Personal` и `Sirius International` больше не являются действующими подключёнными Amazon-магазинами, ответьте одной фразой:

> Подтверждаю: Amazon store2 Vladimir Personal и store4 Sirius International сейчас не подключены; Amazon store5 Retailer Distributor исключить как deactivated без US participation. Amazon store1 и store3, а также Walmart store1 оставить в Phase 1. Разрешаю один новый zero-retry запрос Walmart ITEM v6 только для read-only Product Truth intake; листинги не изменять.

Если хотя бы один из `store2`/`store4` всё ещё действующий, вместо этой фразы нужно назвать его. Тогда сначала восстанавливаются его credentials и берётся свежий полный Amazon report; исключать действующий магазин нельзя.

## Что произойдёт после подтверждения

1. Будет сформирован owner-bound connected-store census.
2. Будет сделана одна попытка получить свежий Walmart ITEM v6; никакого автоматического retry.
3. Из точных report bytes будет собран Phase 1 manifest.
4. Будет подготовлен отдельный exact backfill plan; на этом шаге production business-data ещё не меняются.
5. Перед исправлением `FaisalX-1183` владелец увидит финальный diff. Walmart publish возможен только после точной команды `Загружай FaisalX-1183`.
