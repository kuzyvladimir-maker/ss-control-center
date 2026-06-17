# 🟦 ChannelMAX — база знаний (как мы с ним работаем)

ChannelMAX (`selling.channelmax.net`, версия UI 2.0.7) — Amazon-репрайсер, которым
управляются цены аккаунта **salutem** (store1). **У нас полуавтоматический режим:**
SS Control Center **готовит flat-file**, Vladimir (или агент Jackie через браузер)
**загружает** его в ChannelMAX. У сервиса **нет публичного API** — только File Uploader.

> Связано: [[uncrustables-pricing-model]], [[pricing-module]]. Скрипт-генератор:
> `scripts/channelmax-export.ts`. Первый успешный аплоад: TaskID 327780,
> 156 SKU updated, 2026-06-16.

---

## 1. Как загружать (File Uploader)
Меню **Inventory → File Uploader → Upload a New File**:
1. **Analyze New File** → выбрать `.txt` → файл анализируется, показывает
   `Rec# / Col# / CMaxCol#` и маппинг колонок + sample из первых 3 строк.
2. Галочки (по умолчанию все ВЫКЛ — так и надо для обновления Min/Max):
   - `Dont touch SKUs already in CMax` — пропустить уже существующие SKU. **ВЫКЛ**
     (нам нужно обновлять существующие).
   - `Validate Only, dont upload to CMax` — сухой прогон без записи. Вкл для проверки.
   - `Dont Skip Zero Qty` / `Match SKU to Amazon and get ASIN` / `Update child SKU qty
     for Master SKU` — нам обычно не нужны.
   - `Put new SKUs in this folder` — имя папки для новых SKU.
3. **Upload File Content To ChannelMAX**. Результат: `Processed / Error / Inserted /
   Updated / No Change`.
- **Лимит 2500 SKU за один аплоад.** Формат — **tab-delimited `.txt`** (CRLF ок).
  Есть заголовочная строка с именами колонок (ChannelMAX сам мапит).
- Вкладки: **Logs** (история по TaskID), **Purge All SKUs in ChannelMAX** (опасно —
  чистит всё), **Recently Uploaded Files**.

## 2. Колонки файла (verbatim имена)
| Колонка | Обяз. | Что значит |
|---------|-------|-----------|
| `SKU` | ✅ | seller-sku |
| `SellingVenue` | ✅ | `AmazonUS` (или AmazonUK/AmazonDE…) |
| `MinSellingPrice` | для репрайса | **floor** — ниже не опускать. **Пока Min не задан (≠0), ChannelMAX SKU НЕ репрайсит** |
| `MaxSellingPrice` | ✅ | **ceiling** — выше не поднимать. При авто-импорте из Amazon сюда пишется текущая цена, а Min=0 |
| `ASIN` | опц. | помогает матчингу |
| `Quantity` | опц. | сток |
| `PurchasePrice` | опц. | себестоимость (для Min-Max калькулятора/маржи) |
| `RepricingModelID` | опц. | какая модель репрайсинга применяется к SKU |
| `FolderID` | опц. | числовой ID папки или `Trash` |
| `InventoryProfileID` | опц. | профиль инвентаря |

## 3. Min/Max vs Floor/Ceiling vs проценты
- **Min/Max** — то, что ты вводишь per-SKU (наш жёсткий коридор).
- **Floor rule #35 / Ceiling rule #42** (Settings → Repricing → Repricing Model →
  **Floor/Ceiling** tab) могут накинуть markup **в процентах** поверх Min/Max:
  правила #35(a)/#42(a). Пример: Floor = 125% от Min ($10→$12.50),
  Ceiling = 150% от Max ($20→$30). Это и есть «проценты от цены».
- **Min-Max Calculator** (панель на странице Repricing) — выводит Min/Max из
  `product cost + markup`.
- **Наш подход:** мы считаем **точный Min/Max per-SKU** в SS-CC (у каждого пак-сайза
  своя себестоимость), поэтому проценты-правила держим нейтральными (100%), чтобы
  ChannelMAX не искажал наши значения. Если захотим единый запас — включим #35/#42.

## 4. Модели и стратегии репрайсинга
- Поддерживает **rule-based + algorithmic + гибрид**.
- **Algorithmic** использует BuyBox, BuyBox Rotation, SalesRank, Sales Velocity +
  sales target.
- **Дефолт FBA:** матчить самого дешёвого FBA-конкурента и Amazon.
  **Дефолт nonFBA:** опускать на 1¢ против FBA/Amazon, матчить дешёвого nonFBA.
  Если один ASIN продаётся и FBA, и nonFBA — держит nonFBA на 1¢ выше своего FBA.
- **Target Buybox 100%** (Settings → Repricing Model) — авто-опускать цену пока не
  выиграешь Buy Box или не упрёшься в floor.
- Против **своих** листингов не репрайсит. Если ты featured — репрайсит только против
  Buybox-eligible продавцов.
- **Seller-specific** (Settings → Repricing → Repricing Model → **Seller** tab): по
  merchant ID конкурента задать `Raise By / Lower By / Match / Ignore`.

### ⚠️ Наша стратегия для уникальных frozen-бандлов
Большинство наших Uncrustable/Salutem-бандлов **без конкурентов**. Для таких нам надо,
чтобы цена **сидела на Max = target** (наши ~70%), а НЕ гналась вниз за Buy Box.
→ `Target Buybox 100%` для них должен быть **ВЫКЛ**; алгоритм без конкурентов
максимизирует к Max — это и нужно. Лучше всего вынести их в отдельную **папку** с
отдельным **RepricingModelID**, настроенным консервативно.

## 5. Папки и назначение моделей
- **Папки** организуют SKU (по имени поставщика создаётся авто-папка).
- **Mass Update** (Actions → Mass Update): отметить SKU → задать `Repricing Model`
  и/или `Folder` пачкой.
- Репрайсер можно ограничить одной папкой: Settings → Repricing → **Schedules**.

## 6. Онбординг / активация репрайсера
1. **Download Inventory:** Repricing → Actions → Download Inventory → шаблон → Download.
2. **Задать Min/Max** (через файл или вручную).
3. **Включить:** Settings → Repricing → Repricing Model → **Default** → `Enable = YES`.
4. Активировать репрайсер (см. «How do I activate the repricer»).

## 7. Наш рабочий процесс (полуавтомат)
1. SS-CC считает Min (floor) / Max (target) по cost-модели → `scripts/channelmax-export.ts`
   → `data/channelmax-*-minmax.txt`.
2. Загрузка: **Vladimir вручную** через File Uploader, **или агент Jackie** через
   браузер (можно автоматизировать клики Analyze→Upload).
3. Меняем рамки/наценку → перегенерируем файл → перезаливаем (Updated, не Inserted).
- Будущее: кнопка «Download ChannelMAX file» в Pricing-вкладке; добавить колонки
  `FolderID` + `RepricingModelID`, когда узнаем ID нашей модели/папки.

## 8. Чего ещё не хватает (нужны скриншоты из аккаунта)
Публичная дока не покрывает **наши конкретные настройки**. Чтобы дорулить, полезны
скрины:
- **Settings → Repricing → Repricing Model → Default** (какая модель активна,
  Enable, Target Buybox вкл/выкл, Floor/Ceiling tab с правилами #35/#42 и их %).
- Полный список **правил (#1…#42)** на странице модели.
- **Min-Max Calculator** панель (какие поля: cost, markup, ROI).
- Список **папок** и **RepricingModelID** (чтобы прописывать их в файле).
- **Repricing → Download Inventory** шаблон (точные имена колонок их экспорта).
- **Schedules** (как часто и для каких папок крутится репрайсер).

## 9. Конфиг аккаунта salutem (по скриншотам 2026-06-16)
**Один ChannelMAX-логин `salutem` управляет всеми Amazon-аккаунтами + Walmart.**
SV Defaults (Calculator): markup **70%**, ShipCost **$2/lb**, VAT **$1.8** на venues:
- `300 AmznUS [Salutem Solutions]`, `320 AmznUS2 [AMZ Com]`, `330 AmznUS3 [STARFIT]`,
  `340 AmznUS4 [Retailer Distributor]`, `350 AmznUS5 [KVV]` (350 markup 10%),
  `500 Walmart US` (10%).
- → Через flat-file (с нужным `SellingVenue`) можно переоценивать **все** аккаунты,
  включая те, куда SP-API не достаёт. Наш текущий файл `SellingVenue=AmazonUS` → venue 300 (Salutem).

**Repricing Models:** `35218 Default` (863 SKU), `59149 never sold` (3527), `35219 Manual`,
`35920 for FBA`, `59021 Manual min/max` (299). Наши Uncrustables сейчас в Default.

**Default [35218] — реальные настройки и проблемы:**
- Home: Enable=YES, CMAX Algorithmic=YES. NonFBA listings: Lower By $0.10 vs FBA/NonFBA/Amazon.
- **Floor/Ceiling:** floor 35(a)=100% of Cost-Min (= наш Min, ок). **Ceiling 42(a)=110% of
  Retail-Max** → наш Max НЕ жёсткий, цена может уйти на +10%. 35(b) если Min пуст → 77% of Max.
- **If floor calculated:** 48(a) Add Actual Shipping=YES, 48(f) Add Amazon commission=YES,
  36(a) Overwrite Floor From Category=YES → к нашему Min ДОБАВЛЯЕТ shipping+15%+markup = двойной счёт.
- **Misc:** My Own Catalogs (nonFBA)→Maximize BuyBox (хорошо для уникальных); MAP feed=YES.
- **Sales Velocity=YES:** не продал 1шт/24ч → −$0.10; продал 2/24ч → +$0.10. **Перемалывает
  медленные frozen вниз к floor** — главная причина сползания цен.
- Seller: 53(a) Never Ignore BuyBox=YES, без seller-specific правил.
- Time-Variant / Custom-Code — пусто (доступны: время-зависимые цены, кастомный код с 30+ макросами).

### ✅ Стратегия (ОБНОВЛЕНО по выгрузке инвентаря 2026-06-16)
**НЕ создаём «Frozen Fixed» и НЕ фиксируем цену** (ранний неверный вывод). Цель Vladimir —
**продажи**: его модель «never sold» намеренно роняет цену непродающихся листингов до
конкурентного уровня (до ~30-35% наценки), а на удерживающих Buy Box — растит. Это верно.

**Реальная проблема (из выгрузки `cmax_salutem_InventoryDownload`, 283 Uncrustable):**
- 234 уже в модели **«never sold»**; **PurchaseCost задан лишь у 4 из 283** → CMax не
  знает себестоимость; **MyFloor > заданного Min (~+18%)** из-за надстроек 48a/48f/36a;
  **IGotBuybox=Y у 0**; 165 конкурентных. Пример 60шт: Min=$160, **MyFloor=$188**, наш
  target=$154, реальное дно=$133 → floor задран ВЫШЕ нормальной цены, листинг физически
  не может упасть до конкурентной → не продаётся. Алгоритм-вниз упёрся в задранное дно.

**Решение (служит цели «продажи» ЕГО способом) — РЕАЛИЗОВАНО 2026-06-16:**
1. Скормить CMax правильные данные на все 283 (3 venue: AmznUS/AmznUS3/AmznUS4):
   `MinSellingPrice` = наш floor (landed×1.3), `MaxSellingPrice` = target,
   **`PurchaseCost`** = наш landed cost. + синхронно опущен Amazon
   `minimum_seller_allowed_price` до floor (57 store1, чтобы не ушли в Inactive).
2. **Переселить наши SKU в существующую модель «Manual min/max» [59021]** — она УЖЕ
   чистая: 35(a)=100% Cost-Min, 42(a)=100% Retail-Max, **вкладка If-floor-calculated
   вся ВЫКЛ** (48a/48f/36a=No) → MyFloor=наш Min без раздувания; при этом конкурирует
   вниз (NonFBA Lower By $0.20/$0.10). НЕ клонировать «never sold» (там 3527 чужих SKU
   с надстройками floor — не трогать). Переселение = колонка `RepricingModelID=59021`
   в файле (или Mass Update).
3. Дальше алгоритм 59021 сам уронит цену до конкурентной → продажи.
- Файл: `scripts/channelmax-export-corrected.ts` → `data/channelmax-uncrustables-corrected.txt`
  (колонки SKU/ASIN/SellingVenue/Min/Max/PurchaseCost/**RepricingModelID=59021**).
- Сегментация по продажам (Veeqo) → раскладка по моделям остаётся опцией на будущее.

**Модели (подтверждено скринами):** `Default [35218]` ceiling 42a=**110%**, Sales Velocity ON,
floor-надстройки ON. `never sold [59149]` 42a=100%, floor-надстройки **ON** (раздувают).
`Manual min/max [59021]` 42a=100%, floor-надстройки **OFF** ← **наш целевой, чистый**.

### Полезные колонки выгрузки инвентаря (75 шт)
SKU, ASIN, ItemName, AmazonPrice, MinSellingPrice, MaxSellingPrice, **MyFloor, MyCeiling,
MyPrice, PurchaseCost**, CommissionAmt, FBATotalFee, ActualShippingCost, ItemWight,
**RepricingModelName, FolderName**, CompetitorCount, IsSelling, IGotBuybox, SalesRank, MAP.
Folder→venue: `AmznUS-InvImp`=Salutem, `AmznUS4-InvImp`=Retailer, `AmznUS3-InvImp`=STARFIT.
Анализатор: `scripts/cmax-inventory-analysis.ts`.

## Источники
- [Inventory File Upload](https://channelmax.zendesk.com/hc/en-us/articles/4408231674011-Inventory-File-Upload)
- [Getting Started — Repricing](https://channelmax.zendesk.com/hc/en-us/articles/4408239842075-Getting-Started-Guide-for-ChannelMAX-Repricing)
- [Repricer Onboarding Guide](https://channelmax.zendesk.com/hc/en-us/articles/32962743196059-ChannelMAX-Repricer-Onboarding-Guide)
- [Floor/Ceiling/Min/Max](https://channelmax.zendesk.com/hc/en-us/articles/32220478772635-Difference-between-Floor-Ceiling-Min-Max-Price-in-ChannelMAX-Repricing)
- [Min-Max Calculator](https://channelmax.zendesk.com/hc/en-us/articles/32444847357083-ChannelMAX-Min-Max-Calculator)
- [Create new repricing model & assign SKUs](https://channelmax.zendesk.com/hc/en-us/articles/4408231700123-Create-new-repricing-model-and-assign-SKUs-to-a-repricing-model)
- [Seller Specific Repricing Strategy](https://channelmax.zendesk.com/hc/en-us/articles/4411234214299-ChannelMAX-Seller-Specific-Repricing-Strategy)
- [Mass Update](https://channelmax.zendesk.com/hc/en-us/articles/4408239844507-Mass-Update)
- [FAQ on Repricing](https://channelmax.zendesk.com/hc/en-us/articles/4408231680539-Frequently-Asked-Questions-on-Repricing)
- [Repricer](https://www.channelmax.net/repricer)

## История
- 2026-06-16: база знаний создана; первый аплоад Min/Max (156 SKU, TaskID 327780).
