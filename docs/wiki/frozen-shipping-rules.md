# 🧊 Frozen Shipping Rules

> **Полный канон алгоритма, таблица погоды/кулеров и оверрайды:** [shipping-rate-selection.md](shipping-rate-selection.md).

## Суть
Бизнес-правила доставки скоропортящихся товаров (`FROZEN` и `CHILLED`) и правила клиентского сервиса (CS) по пищевой безопасности.

## Правила доставки (актуальные на 2026-11-27)
- **Два холодовых класса:**
  - **`FROZEN`** — клиент ожидает замороженный товар. Строгое окно транзита.
  - **`CHILLED`** — продаётся охлаждённым; мы всё равно замораживаем при −22 °C и кладём лёд, но клиент принимает размороженным → лимит **`FROZEN + 1 день` (максимум 5 дней)**, кроме экстремальной жары (`A > 30 °C` и `M > 25 °C`).
- **Окно транзита в боевом режиме `Live` (не фиксированные 3 дня):**
  - Определяется по **таблице погоды и кулера** (`days-table.ts`): от **2 до 5 календарных дней** в зависимости от `A` (макс. в Clearwater за 2 дня), `M` (макс. по маршруту midpoint + destZip за 5 дней) и размера кулера (`XS`/`S`/`M`/`L`/`XL`).
  - **Кулеры и лёд:** база `XS 3 / S 5 / M 9 / L 11 / XL 19`; доп. лёд `XS 0 / S 0 / M +2 / L +1 / XL +4` (`+1 lb/шт` к весу этикетки, маркер `[ice +N]` → `"ADD N EXTRA ICE"`). Для `XS`/`S` в `FROZEN` — максимум 3 дня.
  - **Летний пол (`summerCapDays`):** погодная таблица может расширять окно в холодную погоду, но никогда не делает его строже летнего правила (`3` дня в норме, `2` дня при `FrozenRiskAlert = high | critical`).
  - Внутри разрешённого окна берётся **самый дешёвый** тариф (`$0` премия за скорость); Next Day никогда не покупается автоматически.
- **Откат `Summer` (Master Prompt v3.5):** фиксированный потолок **3 календарных дня** (или **2 дня** при `FrozenRiskAlert = high | critical`), с порогом `≤ +$3` за ускорение.
- **Нет запретов по дням недели или перевозчикам:** старые баны «Среда без Ground», «Пятница без FedEx Express» и «без Ground Saver/Economy» **отменены** (v3.5) — фильтрация идёт напрямую по `calDays <= allowedDays` и `EDD <= deliveryBy`.
- **Ship Date Trick (Monday-shift):** автоматическое сравнение «Сегодня vs Понедельник» через `POST /shipping/api/v1/rates` (`getRatesForLaterShipDay` с проверкой `anchorHonored`). См. [Ship Date Trick](ship-date-trick.md).
- **Только Amazon:** замороженные и охлаждённые товары на Walmart **запрещены** (Walmart принудительно `DRY`, холодовый SKU помечается `walmartColdConflict`).

## Правила CS (Customer Service) — неизменны
- **Не спорить** о безопасности еды с клиентом.
- **Не утверждать**, что товар безопасен при жалобе на spoilage.
- **Не просить вернуть** frozen/chilled товары (food safety).
- **Food safety risk** = автоматически **HIGH priority**.
- Для `CHILLED` жалоба «приехало размороженным» (без порчи/нагрева) не считается инцидентом.

## Nearby States
- «Nearby states» для shipping = **Florida only**.

## 🔗 Связи
- **Канон:** [Выбор ставки (канон)](shipping-rate-selection.md)
- **Используется в:** [Shipping Labels](shipping-labels.md), [Customer Hub](customer-hub.md), [Decision Engine](customer-hub-decision-engine.md)
- **Связан с:** [Frozen Analytics](frozen-analytics.md), [Frozen Risk Cap](shipping-frozen-risk-cap.md), [Frozen/Dry/Chilled классификация](frozen-dry-classification.md), [Ship Date Trick](ship-date-trick.md)

## История
- 2026-11-27: Убраны устаревшие запреты (Среда Ground, Пятница FedEx Express) и фиксированные «всегда 3 дня»; правила синхронизированы с боевым режимом `Live`, `CHILLED` и откатом `Summer` v3.5; CS-правила сохранены без изменений.
- 2026-04-10: Wiki-статья создана при полной индексации проекта.
