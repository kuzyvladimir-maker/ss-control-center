# 🎯 Выбор тарифа и покупка этикеток (Shipping Rate Selection — Канон)

## 1. Назначение и статус

Этот документ — **единственный канонический источник истины** для алгоритмов выбора тарифа доставки, сбора входных фактов и механики покупки/переопределения этикеток в модуле `/shipping`.

Если другие заметки в `docs/wiki/`, старые `MASTER_PROMPT_v3.*` или `N8N_SHIPPING_ARCHITECTURE_*` противоречат этому документу — **прав этот канон** (сверен с кодом и решениями владельца на **2026-11-27**).

---

## 2. Профили движка (`Summer / Shadow / Live`)

Температурно-погодный движок выбора тарифа (`src/lib/shipping/temp-class/`) управляется настройкой `Setting.key = "shipping_rate_profile"` (кэш 60 с, читается через `getRateProfile()`). Переключатель **Summer / Shadow / Live** вынесен в верхнюю командную строку `/shipping` (`GET|PUT /api/shipping/rate-profile`).

| Профиль | Поведение | Когда использовать |
|---|---|---|
| **`live`** *(текущий прод)* | Покупка идёт по температурно-погодному движку (`FROZEN / CHILLED / DRY`, погода A/M, кулер, доп. лёд, летний пол). Работает для Amazon `FROZEN`/`CHILLED`; при `noForecast` или пропуске движка падает на `summer`. | Штатный боевой режим. |
| **`shadow`** *(дефолт, если строка в `Setting` не задана)* | Движок рассчитывает свой выбор и потенциальную экономию и показывает их на карточке, но **в план и покупку идёт `summer` (v3.5)**. | Наблюдение / сравнение без влияния на покупки. |
| **`summer`** *(откат в 1 клик)* | Температурный движок полностью выключен — работает чистый **Master Prompt v3.5** (`selectBestRate`: фикс 3 дн. / 2 дн. при `high`/`critical` + доплата до $3 за ускорение). Git-снимок: `shipping-frozen-summer-profile-2026-10-23`. | Экстренный откат или жаркий сезон без погодной таблицы. |

---

## 3. Факты, которые система собирает перед выбором тарифа

Перед вызовом алгоритма выбора тарифа `/api/shipping/plan` собирает 5 групп фактов.

### 3.1. Канал и статус готовности
- **Фильтр заказов:** `status !== "shipped"` (доверие статусу Veeqo, а не append-only заметке `"Label Purchased"`), `isProcurementPlaced(order)` (тег `Placed` или все строки закуплены в notes; для `shopify` пропускается — товар лежит на нашем складе), `dispatch_date` = целевой день отгрузки (в полном проходе).
- **Каналы:**
  - `amazon` (и Veeqo-бакет `"Merged Orders"` — всегда Amazon) → Veeqo + Amazon Buy Shipping V2.
  - `walmart` → отдельный контур **Ship with Walmart (SWW)** (`/api/shipping/walmart/*`). В выходные (`Sat`/`Sun`) Walmart-заказы в план не попадают (Veeqo/SWW отправляет Mark as Shipped). Покупка Walmart через Veeqo заблокирована на сервере, пока оператор явно не переключит `allowWalmartViaVeeqo`.
  - `shopify` (NAN Health) → котировка и покупка по умолчанию через Shopify (снапшоты `NanRateSnapshot` / `/api/shipping/nan-rates` + `/api/shipping/nan-buy`), покупка через Veeqo заблокирована без `Setting.nan_buy_via_veeqo = "true"`.
  - Прочие (`ebay`, `tiktok`, `etsy`, `direct`) → Veeqo allocation rates, дефолтный тип `Dry` (упаковка берётся из Veeqo `allocation_package`, если нет в нашей БД).

### 3.2. Даты, таймзоны и 15:00 ET cutoff (`dates.ts`, `delivery-by.ts`)
- **Две таймзоны:**
  - **Pacific (`America/Los_Angeles`)** — все входящие дедлайны маркетплейсов и Veeqo (`dispatch_date`, `due_date`, `delivery_promise_date` / EDD). Используются `veeqoDateToLocal` / `utcToPacificYMD` / `todayPacific()`.
  - **Eastern (`America/New_York`)** — локальное «сегодня» оператора (`todayNY()`), cutoff 15:00 ET, папки Drive.
- **Двухдатная модель на каждый заказ:**
  - `labelDate` (`computeLabelDate(shipBy)`) — дата, которую видит Amazon на этикетке (влияет на LSR). Если `shipBy <= today`, всегда `today`; если `shipBy > today` и сейчас `>= 15:00 ET` (`CUTOFF_HOUR_NY = 15`), переносится на `nextBusinessDay` (с учётом выходных и федеральных праздников США `public`/`bank`).
  - `physicalShipDate` — день, когда коробка реально уходит со склада. Совпадает с `labelDate`, кроме случаев автоматического Monday-shift или ручного выбора даты оператором (`shipDateTrickApplied = true`).
- **Дедлайн доставки (`resolveDeliveryBy`):**
  - Для Amazon и Walmart (`enforcedDeadline = true`) — строго `due_date` из Veeqo в Pacific TZ.
  - Для прочих каналов (Shopify, eBay, TikTok и т. п.) — если `due_date` отсутствует или `<= shipDay` (Shopify пишет туда ship-by), берётся окно `max(dispatch_date, shipDay) + 10 дней` (`NO_PROMISE_WINDOW_DAYS = 10`).

### 3.3. Температурный класс (3-уровневый, `resolve-class.ts`)
Приоритет определения для **каждой строки заказа** (первое совпадение побеждает):
1. **`SkuTemperatureClass`** (ручное значение владельца в Command Center) — наивысший приоритет, тег Veeqo никогда не перетирает его.
2. **`ProductTypeOverride`** (legacy-таблица `Frozen` / `Dry` по Veeqo `productId`).
3. **Тег продукта в Veeqo:** `frozen` → `FROZEN`; `chilled` / `refriger*` / `fridge` / `cold` → `CHILLED`; `dry` / `ambient` / `shelf` → `DRY`.
4. **Нет сигнала** → **`FROZEN`** (безопасный дефолт; на карточке помечается `unknown` / «type unknown → treated as Frozen»).

**Класс заказа** = **самый строгий** среди всех строк: `FROZEN > CHILLED > DRY`. Смешанный заказ (`Frozen + Dry`) больше **не останавливается** — едет по самому строгому холодовому классу.

**Walmart:** эффективный класс всегда принудительно `DRY`. Если у строки на Walmart-заказе есть *реальный* холодовый сигнал (`manual`/`legacy`/`tag` = `FROZEN` или `CHILLED`), выставляется флаг `walmartColdConflict = true` (предупреждение на карточке).

### 3.4. Упаковка и размер кулера (`box-presets.ts`, `ice.ts`, `package-history.ts`)
- **Single-line `qty=1`:** `SkuShippingData` (БД Turso) → при неполных данных на Amazon автозаполнение из истории отправленных заказов (`findShippedPackage`).
- **Multi-line или `qty>1`:** `PackingProfile` по `signature` состава → автозаполнение из истории.
- **Кулеры (`BOX_PRESETS` + `coolerSizeFromBox`):** принимаются и имена пресетов (`XS`/`S`/`M`/`L`/`XL`), и габариты `LxWxH` (в любой ориентации, точное совпадение или минимальный кулер, куда влезает коробка).

| Кулер | Габариты (in) | База льда (шт) | Макс. доп. лёд (шт) |
|---|---|---|---|
| **XS** | `11×6×8` | 3 | `0` |
| **S** | `12×12×10` | 5 | `0` |
| **M** | `13×13×15` | 9 | `+2` |
| **L** | `18×13×14` | 11 | `+1` |
| **XL** | `24×13×16` | 19 | `+4` |

Dry-пресеты: `5×5×5`, `6×6×6`, `7×7×6`, `10×8×6`, `12×12×6`, `12×12×8`.
Перед котировкой наши габариты и вес всегда пушатся в Veeqo (`updateAllocationPackage`), а адрес получателя нормализуется (`normalizeShipToName`).

### 3.5. Погода (A / M) и `FrozenRiskAlert` (`weather.ts`, `rate-selection.ts`)
- **Open-Meteo** (бесплатный прогноз, кэш 3 часа по округлённым координатам и диапазону дат):
  - **`A` (`originMaxC`)** — максимум дневной температуры (°C) в **Clearwater, FL 33765** (`27.9659, -82.7637`) за `[shipDay, shipDay + 1]` (первые ~36 ч пути).
  - **`M` (`routeMaxC`)** — максимум дневных температур (°C) в **середине маршрута** (midpoint Clearwater ↔ destZip) и в **точке назначения** за `[shipDay + 1, shipDay + 5]`.
  - Если прогноз недоступен или ZIP не геокодирован → `originMaxC = null` / `routeMaxC = null` → `allowedDays = NaN` (`noForecast = true`) → откат заказа на `summer` (v3.5).
- **`FrozenRiskAlert` (pending):** для каждого заказа выбирается максимальный уровень риска (`ok < low < medium < high < critical`). Функция `frozenMaxCalDays(riskLevel)` возвращает **`2` дня** для `high` **и** `critical`, иначе **`3` дня**.

---

## 4. Таблица разрешённых дней и доп. льда (`days-table.ts`)

### 4.1. Базовая таблица для `FROZEN` (при Clearwater `A ≤ 25 °C`)

Считаются **календарные дни** (`EDD − shipDay`, включая выходные). В ячейках с доп. льдом указан вариант с полным доп. льдом кулера (`ICE_EXTRA_CAPACITY`: `M +2`, `L +1`, `XL +4`); если кулер не вмещает доп. лёд или не выполнено условие по `A`, берётся значение без льда.

| Полоса маршрута `M` | `XS` / `S` | `M` | `L` | `XL` |
|---|---|---|---|---|
| **HOT** (`M > 20 °C`) | 2 дн. | 2 дн. | 2 дн. | 2 дн. |
| **WARM** (`10 < M ≤ 20 °C`) | 2 дн. | 3 дн. *(+2 льда)* | 3 дн. *(+1 лёд)* | 3 дн. *(+4 льда)* |
| **COOL** (`0 < M ≤ 10 °C`) | 3 дн. | 4 дн. *(+2 льда)* | 3 дн. | 4 дн. *(+4 льда)* |
| **COLD** (`−5 < M ≤ 0 °C`) | 3 дн. | 4 дн.; **5 дн. *(+2)* если `A < 15 °C`** | 4 дн. | 5 дн. *(+4 льда)* |
| **FRIGID** (`M ≤ −5 °C`) | 3 дн. | 4 дн.; **5 дн. *(+2)* если `A < 15 °C`** | 4 дн. | 5 дн. *(+4 льда)* |

### 4.2. Оверрайды и порядок применения (внутри `allowedDays`)
Применяются последовательно поверх таблицы `FROZEN`:
1. **Жаркий Clearwater (`A > 25 °C`):** потолок `2` дня, если `M > 10 °C`, иначе `3` дня. Если потолок срезал дни — `extraIce` сбрасывается в `0`.
2. **Потолок для `XS` / `S`:** для `FROZEN` никогда больше `3` дней (`XS_S_CAP = 3`).
3. **Инцидент по SKU (`hasIncident`):** `−1 день` (минимум 1). *Статус на 2026-11-27:* реализовано в `days-table.ts` и покрыто тестами, но **намеренно не подключено** в `plan/route.ts` (подтверждено владельцем).
4. **Летний пол (`summerCapDays`):** `3` дня (или `2` дня при `FrozenRiskAlert = high | critical`). Если таблица погоды дала меньше `summerCapDays`, окно поднимается до `summerCapDays` (с `extraIce = 0`). **Правило владельца:** зимний/погодный движок может *расширять* окно и удешевлять доставку, но никогда не быть строже летнего правила.
5. **Класс `CHILLED`:** к итоговому `FROZEN`-лимиту (после шагов 1–4) добавляется **`+1 день`**, потолок **`5` дней** (`CHILLED_CAP = 5`). Исключение: экстремальная жара на обоих концах (`A > 30 °C` **и** `M > 25 °C`) — остаётся `FROZEN`-лимит без `+1`. Жалоба «приехало размороженным» для `CHILLED` инцидентом не считается.
6. **Класс `DRY`:** `allowedDays = Infinity`, `extraIce = 0`, погода не запрашивается.

> **Когда реально добавляется доп. лёд:** только если выбранный тариф действительно использует максимальный день окна (`pickedDays >= allowedDays && extraIce > 0`). Если самый дешёвый тариф и так едет быстрее — доп. лёд = `0`.

---

## 5. Правила выбора тарифа по каналам и режимам

### 5.1. Amazon `DRY` (и прочие Veeqo-каналы `DRY`)
- Фильтр: `EDD <= deliveryBy` и `price > 0`.
- Выбор: **строго самый дешёвый тариф**, успевающий в дедлайн. Никаких запретов по перевозчикам или времени суток.

### 5.2. Amazon `FROZEN` / `CHILLED` — режим `Live` (`selectTempAwareRate`, текущий прод)
1. **Фильтры:**
   - `EDD <= deliveryBy` (Pacific TZ);
   - `calDays(EDD − shipDay) <= allowedDays` (из таблицы погоды + летний пол);
   - **Next Day / Overnight / Priority Mail Express никогда не покупаются автоматически** (`isNextDay` regex: `/next day|overnight|priority mail express/i`). Оператор может выбрать их вручную в диалоге.
   - Увеличение размера кулера (upsize) **не предлагается** (136/136 исторических кейсов оказались на $10–16 дороже).
2. **Внутри одного дня:** берётся **самый дешёвый** валидный тариф (**премия за скорость = `$0`**, `SPEED_TOLERANCE_USD = 0`, решение владельца 2026-10-26). Более быстрый тариф выигрывает только при точном совпадении цены (`<= +$0.005`), затем более ранний EDD.
3. **Пропуск движка (`engineSkip`):** если заказ не Amazon, нет коробки, коробка не распознана как кулер, нет ZIP, 0 ставок или `noForecast` — заказ считается по `summer` (v3.5).

### 5.3. Amazon `FROZEN` — режим `Summer` / `Shadow` (`selectBestRate`, Master Prompt v3.5)
1. **Фильтры:** `EDD <= deliveryBy` и `calDays <= frozenMaxCalDays(riskLevel)` (`2` дня при `high`/`critical`, иначе `3` дня). Никаких запретов по дням недели или перевозчикам.
2. **Выбор:** находится минимальная цена `cheapest`; из всех тарифов в диапазоне `price <= cheapest + $3` (`FROZEN_SPEED_TOLERANCE_USD = 3`, **абсолютные доллары**, не проценты) выбирается тариф с минимальным `calDays`, затем более ранним EDD, затем минимальной ценой.

### 5.4. Monday-shift (Ship Date Trick) и защита от `anchorHonored = false`
Применяется к Amazon `FROZEN`/`CHILLED` в **обоих** режимах (`Live` и `Summer`), если сегодня не понедельник (`dayName !== "Mon"` и `effectiveShipDay` не понедельник), оператор не задал `shipDateOverride`, и `nextMonday` хотя бы на 1 день раньше `deliveryBy` (`monDeadlineDays >= 1`).

1. **Как котируется понедельник:** через новый Rate Shopping API `POST /shipping/api/v1/rates` (`getRatesForLaterShipDay`, без мутации `dispatch_date` и без задержек `800ms`). В `Live` для понедельника заново запрашивается погода и прогоняется `selectTempAwareRate` от понедельника; в `Summer` — `selectBestRate`.
2. **Проверка `anchorHonored` / `quoteAnchorDay`:** `getRatesForLaterShipDay` сравнивает EDD общих сервисов между `baseYmd` и `laterYmd` (учитывая `pickupGapBusinessDays`, чтобы Sun→Mon = 0 не давало ложной тревоги).
   - Если Veeqo **проигнорировал** `preferred_shipment_date` (`anchorHonored = false`), EDD возвращаются **без сдвига** (правило владельца: дату перевозчика не двигаем), с полем `quoteAnchorDay = effectiveBusinessDay(baseYmd)`.
   - Для **автоматического Monday-shift** при `anchorHonored = false` сдвиг **запрещён** (отгружаем сегодня, чтобы не получить ложный «1-дневный» транзит).
   - Если `quoteAnchorDay` возник на основном шаге (выходной/ручная дата), транзит измеряется от `quoteAnchorDay`, а дедлайн поджимается на разницу дней — с 2026-11-27 это единообразно проброшено и в `Summer`, и в `Live`.
3. **Сравнение «Сегодня vs Понедельник» (`chooseTodayOrMonday`):** берём понедельник, если выполняется **любое** из 3 условий:
   - сегодня нет ни одного валидного тарифа (`!todayPick`), **ИЛИ**
   - понедельник **быстрее** в транзите (`mondayTransit < todayTransit`) **и** дороже не более чем на `$3` (`mondayPrice <= todayPrice + $3`), **ИЛИ**
   - понедельник **более чем на 15% дешевле** (`mondayPrice < todayPrice * 0.85`, `MONDAY_SHIFT_MIN_SAVING_PCT = 0.15`), даже если на 1 день дольше (в пределах разрешённого окна).
   - Иначе отгружаем сегодня.

### 5.5. Walmart (Ship with Walmart — `walmart-rate-selection.ts`)
- Только `DRY`. Котировка через Walmart API (`estimateShippingRates`), дата отгрузки сдвигается на `effectiveBusinessDay`.
- `selectBestWalmartRate`: из тарифов с `amount > 0` сначала фильтруются те, у кого `deliveryPromiseFulfilled === true`; если таких нет — берётся весь прайс-пул (лучше доставить с опозданием, чем не отправить, оператор может сменить вручную). Из пула берётся **самый дешёвый**.

### 5.6. NAN Health (Shopify — `nan-rates.ts`, `nan-shopify-buy.ts`)
- Котировки приходят от серверного сборщика (`scripts/server/nan_rates_http.py`) в таблицу `NanRateSnapshot` (`/api/shipping/nan-rates`). Сортировка от дешёвого к дорогому (Media Mail в конце); снапшот старше 30 мин помечается «устарел».
- Покупка по умолчанию в Shopify (через кнопку «Купить в Shopify» или мутацию `shippingLabelPurchase`, когда настроены env-переменные; FedEx в мутации Shopify не поддерживается — остаётся покупка в админке Shopify). Покупка через Veeqo заблокирована без `Setting.nan_buy_via_veeqo = "true"`.

### 5.7. Merged Orders (`/api/shipping/merge/rates`, `/api/shipping/merge/buy`)
- **Котировка:** по объединённым весу и коробке группы. Дедлайн группы = **самый ранний** `due_date` среди всех участников; риск = **худший** pending `FrozenRiskAlert` среди всех участников.
- **Алгоритм выбора (Amazon):** используется `selectBestRate` (v3.5) + `chooseTodayOrMonday` (для Frozen); для Walmart — SWW.
- **Покупка:** одна реальная этикетка на primary-заказ (Amazon через Veeqo с пустым ретраем пула и `matchLiveRate`, Walmart через SWW), затем трек-номер рассылается на sibling-заказы (`createManualShipment` / Walmart ship-confirm). Подробно: `docs/wiki/shipping-labels.md` и комментарии в `merge/buy/route.ts`.

---

## 6. Вес FedEx One Rate (`+20%`) и доп. льда (`+1 lb/шт`)

- **FedEx One Rate = `+20%` (`×1.20`)** — единственный канонический множитель (подтверждён владельцем 2026-11-27; старый коэффициент `×1.25` и колонка `K` из Google Sheets **отменены**).
  - Применяется, когда название выбранного тарифа содержит `"one rate"` (case-insensitive). На карточке и в каталоге остаётся базовый вес; увеличенный вес `weight × 1.20` уходит в Veeqo (`updateAllocationPackage`) перед котировкой/покупкой.
- **Доп. лёд = `+1 lb` за каждую добавленную штуку** (`ICE_WEIGHT_PER_PIECE_LB = 1`, себестоимость `$0.10/шт`). Базовый лёд уже заложен в каталожный вес SKU; к весу этикетки добавляется только `liveIceExtra × 1 lb`.
- **Согласование веса между планом и покупкой (2026-11-27):** когда в `plan/route.ts` выбран тариф с `liveIceExtra > 0` или **FedEx One Rate (`×1.20`)**, план перекотирует скорректированный вес, чтобы цена на карточке совпадала с живой перекотировкой при покупке и не срабатывал ценовой порог `max($1, 5%)`.
- **Складская заметка:** план пишет маркер `[ice +N]` в `notes`; при покупке `/api/shipping/buy` дописывает `"ADD N EXTRA ICE"` в employee note Veeqo.

---

## 7. Механика ручного выбора (`PickRateDialog`) и покупки (`/api/shipping/buy`)

### 7.1. Два API Veeqo и почему после 11:00 ET пропадал FedEx
У Veeqo два разных эндпоинта ставок:
1. **Rate Shopping API (`POST /shipping/api/v1/rates`)** — принимает `preferred_shipment_date` (используется для Frozen-плана, Monday-shift и диалога при выборе даты). Возвращает свой `rate_id` и **не** возвращает `remote_shipment_id`. После **11:00 ET (`16:00Z`)** для `shipDate = today` этот API перестаёт возвращать FedEx.
2. **Allocation Pool (`GET /shipping/rates/{allocationId}`)** — не принимает дату (привязан к `order.dispatch_date`), но возвращает `remote_shipment_id` и `shipping_service_options` (VAS), нужные для `POST /shipping/shipments`, и продолжает отдавать FedEx после 11:00 ET.

**Решение (2026-11-20 / 2026-11-27):** для `shipDate = today` и `/api/shipping/rates`, и `/api/shipping/plan` дозагружают Allocation Pool и добавляют отсутствующие сервисы (FedEx) через `mergeMissingRates` (ключ `carrier + normalized title`; при совпадении выигрывает строка из date-anchored котировки).

### 7.2. Ручной выбор (`buy-override.ts`) и сохранение override при ошибке
- Когда оператор выбирает тариф или дату в `PickRateDialog` / inline-пикере, клиент передаёт `overrides[itemId]` в `/api/shipping/buy`.
- `applyBuyOverride()` подменяет не только идентификаторы сервиса, но и **`price`** (`ov.price ?? parseFloat(ov.totalNetCharge) ?? item.price`), **`edd`** (`ov.edd ?? item.edd`) и **`physicalShipDate` / `actualShipDay`**. Благодаря этому ценовой порог перекотировки сравнивает живую цену с ценой *выбранного оператором* тарифа, а не алгоритма.
- Ручной override позволяет купить даже заказ со статусом `stop` (оператор осознанно берёт ответственность за опоздание/альтернативу).
- **Сохранение override при ошибке (2026-11-27):** при массовой покупке (`buySelected`) если строка завершилась ошибкой, её `rateOverrides` **сохраняется** (а не сбрасывается), чтобы оператор мог повторить покупку без повторного выбора тарифа.

### 7.3. Последовательность покупки (`/api/shipping/buy`)
Для каждой строки (пул параллельности `BUY_CONCURRENCY = 4`):
1. **Охранные проверки:** блокировка NAN Health без флага `nan_buy_via_veeqo`; блокировка Walmart без `allowWalmartViaVeeqo`; проверка наличия обязательных полей (кроме `remoteShipmentId` — он берётся из живой перекотировки).
2. **Пуш пакета (`updateAllocationPackage`):** пушатся вес (с учётом `+liveIceExtra` и `×1.20` для FedEx One Rate) и габариты из `resolveBoxDimensions`. Если пуш упал — **ABORT**, этикетка не покупается (защита от неверных габаритов).
3. **Dual-date dance (если `physicalShipDate !== labelDate`):**
   - Шаг 1: `PUT dispatch_date = physicalShipDate T06:59:59Z`, чтобы Allocation Pool перегенерировался под физический день отгрузки.
   - Шаг 2: живая перекотировка `GET /shipping/rates/{allocationId}`.
   - Шаг 3: `PUT dispatch_date = labelDate T06:59:59Z` **ДО** `POST /shipping/shipments`, чтобы Amazon получил сегодняшнюю дату на этикетке и не начислил Late Shipment.
4. **Ретрай пустого пула (2026-11-27):** Veeqo периодически возвращает `HTTP 200 { available: [] }` (`liveRatesCount = 0`). В `buy/route.ts`, `merge/buy/route.ts`, `rates/route.ts` и `plan/route.ts` выполняется автоматический **ретрай GET-котировки** с коротким backoff и диагностикой `unavailable`/ошибки. (Касается **только** чтения ставок!)
5. **Сопоставление живой ставки (`matchLiveRate` в `requote-match.ts`):**
   - Tier 1 (`id`): точное совпадение `serviceType === live.name`.
   - Tier 2 (`title`): тот же `sub_carrier_id` + нормализованный `title` (без `®™©`, пробелов, регистра).
   - Tier 3 (`base`): тот же `sub_carrier_id` + базовый `title` без суффикса вида `(Saturday)`, **при условии `live.edd <= planned.edd`** (нельзя тихо купить более медленную доставку).
   - Для Tier 2 и Tier 3 действует **ценовой страж**: `livePrice <= plannedPrice + max($1, 5% от plannedPrice)`. При превышении или отсутствии совпадения покупка **отменяется** (fail-closed) с выводом до 3 ближайших альтернатив.
   - Если `trickApplies === false`, но ставка не найдена в пуле — делается одна попытка временно переякорить `dispatch_date` на `physicalShipDate` и перекотировать (с обязательным восстановлением при отмене).
   - **Никогда не матчить по `remote_shipment_id`** — он одинаковый для всех тарифов внутри одной allocation.
6. **Извлечение VAS (`extractVasFromRate`):** читается строго из `freshRate.shipping_service_options` (`null` → не слать VAS-поля вообще; массив → `NO_*` если есть, иначе самый дешёвый, например `DELIVERY_CONFIRMATION` для USPS Ground Advantage).
7. **Покупка — СТРОГО 1 POST, 0 RETRY:** один вызов `POST /shipping/shipments` (`buyShippingLabel`). При таймауте, 429 или неизвестном исходе **никогда не повторять** — только читать состояние через GET.
8. **После покупки:** извлечение трека (`pickTrackingString`), скачивание PDF по `shipment.id` (с проверкой magic bytes `%PDF-`), 3-слойное сохранение PDF (Google Drive → локальный диск в dev → proxy `/api/shipping/label-pdf`), запись employee note (`Label Purchased`, `📅 SHIP ON YYYY-MM-DD` при сдвиге, `ADD N EXTRA ICE` при доп. льде), аудит в `logs/shipping-buy.jsonl`, отчёт в `BuyReportDialog`.

---

## 8. Отменённые правила (НЕ возвращать в код и документацию)

Следующие правила из старых версий (`MASTER_PROMPT v3.1–v3.4`, n8n) **официально отменены** решениями владельца:

| Старое правило | Статус | Что действует сейчас |
|---|---|---|
| **Проверка бюджета (`budgetMax`, 10%/15%/50% лимиты)** | **Отменено** (2026-11-27) | `budgetMax: null`. Выбор идёт от дедлайна, холодовой цепи и компромисса цена/скорость. См. [budget-check-algorithm.md](budget-check-algorithm.md). |
| **Предпочтение UPS при разнице ≤10%** | **Отменено** (2026-05-14) | Все перевозчики равны; оператор сам видит альтернативы. |
| **USPS cutoff после 12:00 ET** | **Отменено** (2026-05-14) | Не фильтруется алгоритмом. |
| **Среда — запрет Ground; Пятница — запрет FedEx Express** | **Отменено** (2026-06-12, v3.5) | Заменено прямым фильтром по `calDays <= allowedDays` и `EDD <= deliveryBy`. |
| **Запрет Ground Saver / Ground Economy / tender-to-USPS для Frozen** | **Отменено** (2026-06-12, v3.5) | Допускается любой сервис, если он укладывается в `EDD <= deliveryBy` и `calDays <= allowedDays`. |
| **Правило «≤$0.50 → раньше EDD» и процентная полоса ~10%** | **Отменено** (2026-06-12 / 2026-10-26) | В `Live`: `$0` премия за скорость (быстрее только при равной цене). В `Summer`: абсолютный порог `$3`. |
| **Коэффициент FedEx One Rate `×1.25` (колонка K в Google Sheets)** | **Отменено** (2026-06-09, закреплено 2026-11-27) | Единый коэффициент **`+20%` (`×1.20`)**. |
| **Фиксированные «всегда 3 дня» для Frozen** | **Заменено** (2026-06-09 / 2026-10-23) | В `Live`: таблица погоды + летний пол (3 дн. / 2 дн. при `high`/`critical`). `CHILLED`: `+1` день до 5. |
| **Mixed orders (Frozen+Dry) → СТОП; Без тега → СТОП** | **Отменено** (2026-10-23) | В `Live`: побеждает самый строгий класс (`FROZEN > CHILLED > DRY`); без сигнала → `FROZEN` (safe default) с пометкой `unknown`. |
| **Ship Date Trick через `PUT dispatch_date → 800ms → GET`** | **Заменено** (v3.5) | В плане используется `POST /shipping/api/v1/rates` (`getRatesForLaterShipDay` с проверкой `anchorHonored`). |
| **n8n Weekend Distribution (50/50 Пн/Вт)** | **Архив** | Модуль перенесён в Next.js `/shipping`. |

---

## 9. Карта файлов кода и связей Wiki-Brain

### Файлы кода (`ss-control-center/src/`)
- `lib/shipping/rate-selection.ts` — `selectBestRate` (Summer v3.5), `frozenMaxCalDays` (`high`/`critical` → 2 дн.), `chooseTodayOrMonday` (`$3` / `>15%`).
- `lib/shipping/temp-class/classes.ts`, `resolve-class.ts` — 3 класса `FROZEN/CHILLED/DRY`, приоритет резолва, Walmart conflict.
- `lib/shipping/temp-class/days-table.ts` — таблица дней/льда, оверрайды, летний пол `summerCapDays`, `CHILLED +1`.
- `lib/shipping/temp-class/pick-rate.ts` — `selectTempAwareRate` (`SPEED_TOLERANCE_USD = 0`, запрет Next Day).
- `lib/shipping/temp-class/ice.ts`, `weather.ts`, `profile.ts`, `shadow.ts` — кулеры/лёд, Open-Meteo A/M, профиль `shipping_rate_profile`.
- `lib/shipping/dates.ts`, `delivery-by.ts`, `box-presets.ts` — TZ (PT/ET), 15:00 ET cutoff, `resolveDeliveryBy`, пресеты коробок.
- `lib/shipping/walmart-rate-selection.ts` — `selectBestWalmartRate` (SWW).
- `lib/shipping/nan-rates.ts`, `nan-shopify-buy.ts` — NAN Health (Shopify).
- `lib/shipping/requote-match.ts`, `buy-override.ts`, `rate-pool-merge.ts` — сопоставление при покупке, ручной override, мердж Allocation Pool.
- `lib/veeqo/client.ts` — `getRatesForShipDate`, `getRatesForLaterShipDay`, `getShippingRates`, `extractVasFromRate`, `buyShippingLabel`.
- `app/api/shipping/plan/route.ts`, `buy/route.ts`, `rates/route.ts`, `merge/rates/route.ts`, `merge/buy/route.ts` — серверные маршруты.

### 🔗 Связи Wiki-Brain
- **Часть:** [Shipping Labels](shipping-labels.md)
- **Детали подсистем:** [Frozen/Dry/Chilled классификация](frozen-dry-classification.md), [Ship Date Trick](ship-date-trick.md), [Frozen Shipping Rules](frozen-shipping-rules.md), [Carrier Selection Rules](carrier-selection-rules.md), [Frozen Risk Cap](shipping-frozen-risk-cap.md), [NAN Health rates](shipping-nan-health-rate-snapshots.md)
- **Архив / история:** [Budget Check (отменено)](budget-check-algorithm.md), [Weekend Distribution (архив n8n)](weekend-distribution.md), [Дизайн-док погодного движка 2026-10-23](frozen-weather-rate-selection-plan-2026-10-23.md), [Реализация погодного движка 2026-10-23](temp-class-rate-engine-implementation-2026-10-23.md)
- **Инциденты и квирки:** [Veeqo API quirks](veeqo-api-quirks.md), [Timezone правила](timezone-rules.md), [Manual override requote price](shipping-manual-override-requote-price-2026-11-20.md), [Pick rate missing FedEx today](shipping-pick-rate-missing-fedex-today-2026-11-20.md)

### История
- 2026-04-10: Первичная статья (n8n / MASTER_PROMPT v3.1).
- 2026-05-14: Удалены 12:00 ET USPS cutoff и ≤10% UPS; реализован автоматический Ship Date Trick.
- 2026-06-09 / 2026-06-12: Master Prompt v3.5 (убраны запреты по дням/перевозчикам, `high`+`critical` → 2 дн., FedEx One Rate +20%, `$3` / `>15%` для Monday-shift).
- 2026-10-23 / 2026-10-26: Внедрён температурно-погодный движок `FROZEN/CHILLED/DRY`, переключатель `Summer/Shadow/Live` (прод в `live`), премия за скорость в `Live` обнулена (`$0`), добавлен летний пол `summerCapDays`.
- 2026-11-27: Полная унификация документации в единый канон; закреплены решения владельца (FedEx One Rate `+20%`, отмена `budgetMax`, сохранение текущих правил `Live`, `hasIncident` не подключён в `plan`) и фиксы надёжности (ретрай пустого пула Veeqo, мердж FedEx после 11:00 ET в `plan` и `rates`, `quoteAnchorDay` в `Live`, перекотировка веса льда/One Rate в плане, сохранение `rateOverrides` при ошибке `buySelected`, `matchLiveRate` + ретрай в `merge/buy`).
