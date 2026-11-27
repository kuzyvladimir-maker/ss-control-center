# 🏷️ Температурная классификация (`FROZEN / CHILLED / DRY`)

> **Полный канон выбора тарифа:** [shipping-rate-selection.md](shipping-rate-selection.md).

## Суть
Каждый SKU относится к одному из **трёх** температурных классов. Класс определяет разрешённое окно транзита, норму льда и допустимость отгрузки на Walmart.

| Класс | Значение | Холодовая цепь |
|---|---|---|
| **`FROZEN`** | Клиент ожидает замороженный товар. | Строгая таблица погоды/кулера (2–5 дн.) + летний пол. |
| **`CHILLED`** | Продаётся охлаждённым; мы замораживаем при −22 °C и кладём лёд, клиент принимает размороженным. | `FROZEN + 1 день` (макс. 5 дн.), кроме экстремальной жары (`A > 30 °C` и `M > 25 °C`). |
| **`DRY`** | Не требует температурного режима. | Без погоды и льда — самый дешёвый тариф в дедлайн. |

## Приоритет определения для одной строки (`decideLineClass`)
Реализовано в `src/lib/shipping/temp-class/resolve-class.ts` (первое совпадение побеждает):
1. **`SkuTemperatureClass`** (ручное значение владельца в Command Center, таблица в Prisma + аудит `SkuTemperatureClassChange`). Тег в Veeqo **никогда не перетирает** ручной класс.
2. **`ProductTypeOverride`** (legacy-таблица `Frozen` / `Dry` по Veeqo `productId`).
3. **Тег продукта в Veeqo** (`parseTempClass`):
   - `frozen` → `FROZEN`
   - `chilled` / `refriger*` / `fridge` / `cold` → `CHILLED`
   - `dry` / `ambient` / `shelf` → `DRY`
4. **Нет сигнала** → **`FROZEN`** (безопасный дефолт; на карточке выставляется флаг `unknown` — *«type unknown → treated as Frozen»*). В боевом режиме `Live` это **не останавливает** заказ, а страхует холодовую цепь до правки оператором.

## Правило для заказа с несколькими строками (Mixed Orders)
- Проверяется **каждая** строка заказа (старый баг «читать только `line_items[0]`» исправлен 2026-10-23).
- Итоговый класс заказа = **самый строгий** среди всех строк: **`FROZEN > CHILLED > DRY`** (`strictestClass`).
- Смешанный заказ (`Frozen + Dry` или `Chilled + Dry`) **не останавливается** — вся коробка едет по самому строгому классу.

## Правила по каналам
- **Walmart:** эффективный класс **всегда принудительно `DRY`** (`FROZEN` и `CHILLED` на Walmart запрещены). Если у какой-либо строки Walmart-заказа есть **реальный** холодовый сигнал (`manual`, `legacy` или `tag` = `FROZEN`/`CHILLED`, не дефолт), выставляется флаг `walmartColdConflict = true` и на карточке показывается предупреждение.
- **Прочие каналы (eBay, TikTok, Shopify, direct):** в legacy-ветке без тега по умолчанию считаются `Dry` (если не переопределено вручную).
- **Режимы `Summer` / `Shadow`:** для обратной совместимости сохраняют legacy-вычисление `productType` по первой строке (`CHILLED`/`refrigerated`-тег засчитывается как `Frozen`, чтобы не вызывать стоп). В боевом **`Live`** закупкой управляет полный 3-классовый резолв.

## Управление в UI и API
- На карточке заказа в `/shipping` есть кликабельный чип `Frozen / Chilled / Dry` (а также вкладка фильтра `Chilled`, диалог Set product type и AI-классификатор).
- API: `GET/POST /api/shipping/temperature-class` (пишет `SkuTemperatureClass` и аудит `SkuTemperatureClassChange`; запись тегов обратно в Veeqo — опциональная, отдельно).

## Связанные файлы
- `ss-control-center/src/lib/shipping/temp-class/classes.ts` — `TempClass`, `parseTempClass`, `strictestClass`, `DEFAULT_CLASS = "FROZEN"`
- `ss-control-center/src/lib/shipping/temp-class/resolve-class.ts` — `decideLineClass`, `decideOrderClass`, `resolveOrderClass`
- `ss-control-center/src/app/api/shipping/temperature-class/route.ts` — API ручной установки класса
- `ss-control-center/prisma/schema.prisma` — `SkuTemperatureClass`, `SkuTemperatureClassChange`, `ProductTypeOverride`

## 🔗 Связи
- **Канон:** [Выбор ставки (канон)](shipping-rate-selection.md)
- **Используется в:** [Shipping Labels](shipping-labels.md)
- **Связано с:** [Frozen Analytics](frozen-analytics.md), [Frozen shipping rules](frozen-shipping-rules.md), [Walmart ограничения](walmart-restrictions.md), [Реализация погодного движка](temp-class-rate-engine-implementation-2026-10-23.md)

## История
- 2026-11-27: Статья обновлена с 2-классовой теговой стоп-логики на актуальную 3-классовую модель (`FROZEN / CHILLED / DRY`, приоритет `SkuTemperatureClass > ProductTypeOverride > Veeqo tag > FROZEN default`, mixed → strictest, Walmart forced `DRY` + `walmartColdConflict`).
- 2026-10-30: `Chilled` добавлен во все диалоги ручной и AI-классификации ([shipping-chilled-manual-class-2026-10-30](shipping-chilled-manual-class-2026-10-30.md)).
- 2026-10-23: Внедрены 3 класса, таблица `SkuTemperatureClass`, проверка всех строк заказа и безопасный дефолт `FROZEN`.
- 2026-04-10: Wiki-статья создана при полной индексации проекта (старая 2-классовая схема по тегам Veeqo).
