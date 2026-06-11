# 🔄 SESSION HANDOFF — читать ПЕРВЫМ при продолжении на любой машине

> **Как пользоваться:** на новой машине скажи Claude: *«прочитай вики и найди
> SESSION-HANDOFF»*. Здесь — что мы делали, где остановились, и план. Обновляется
> в конце каждой сессии.
>
> **Последнее обновление:** 2026-06-10 (вечер, iMac-Claude — подключил **COGS margin floor в репрайсер**
> + аудит платных ключей. Детали — блок «🆕 СЕССИЯ 2026-06-10 (вечер)» ниже). Утром в тот же день
> MacBook-Claude закрыл большую сессию **Shipping Labels** (11 фиксов, таблица `WalmartLabelPurchase`).
> Главная **незаконченная** задача — **COGS / Product Sourcing Engine** (см. «ПРОДОЛЖИТЬ ОТСЮДА»).

## ▶️▶️ ПРОДОЛЖИТЬ ОТСЮДА (2026-06-10 вечер) — что делать дальше
> 🔁 **СМЕНА КУРСА (Владимир, 2026-06-10):** Джеки БОЛЬШЕ НЕ В ЦЕПОЧКЕ. Он был временным мостом для
> теста платных сервисов. Сервисы выбраны и работают — теперь их дёргает **наш движок напрямую**
> (`src/lib/sourcing/retail-fetch.ts`), постоянно обогащая каталог. Никакого агента/человека-посредника.
Состояние консистентно, всё на GitHub (`git pull` сперва). Очередь:
1. **[БЛОКЕР — только Владимир]** Платные ключи почти пусты: **BlueCart 37 кредитов, Unwrangle 0 (триал исчерпан)**.
   Подписки оплачены на дашбордах, но ключи в нашем `.env.local` — старые ТРИАЛЬНЫЕ. Нужно: зайти на дашборды
   (аккаунт `info@salutem.solutions`), взять ПЛАТНЫЕ ключи → в `ss-control-center/.env.local`
   (`BLUECART_API_KEY`, `UNWRANGLE_API_KEY`). Это разблокирует полный прогон каталога — стержневую цель.
2. **[✅ СДЕЛАНО 2026-06-10]** `SkuCost` → **репрайсер margin floor** (`reprice-engine.ts`): больше не гонится
   за Buy Box ниже маржи (`cost / (1−0.15−0.20)`); fallback $1 когда cost нет. Работает на 217 Amazon-costs.
3. **[без оплаты, можно сейчас]** Переделать **COGS-вкладку** экспорта (формат: SKU → название, units,
   cost-per-unit, total, где купить, чистые notes — замечание #11) + показывать ВСЕ costed-SKU, не только 13 пилот.
4. **[ЗАБЛОКИРОВАНО данными]** `/analytics` чистая прибыль — сейчас НЕЛЬЗЯ: `AmazonOrder` без line-items (нет SKU
   на заказе). Нужна ингест-прослойка SP-API getOrderItems → новая модель → бэкафилл. Отдельный под-проект.
5. **[после ключей]** Полный прогон 506 Walmart-SKU (`cogs-enrich-pilot.ts`) на 5 ритейлерах, жёсткий
   first-party фильтр, ≥5 фото + Nutrition+состав, разбор вариаций (Green Giant ×4), лучший источник.
⬇️ детали ниже: «СЕССИЯ 2026-06-10 (вечер)», `cogs-sheet-review-2026-06-08.md`.

---

## 🆕 СЕССИЯ 2026-06-10 (вечер, iMac-Claude) — РЕПРАЙСЕР MARGIN FLOOR + аудит платных ключей
Владимир: **смена курса — Джеки убираем из цепочки**, движок сам дёргает оплаченные сервисы и постоянно
обогащает каталог SKU. Что сделано:

**1. Аудит платных ключей** (живой smoke-test через наши же функции движка `retail-fetch.ts`):
- **BlueCart** ✅ работает, отдаёт Walmart 1P (Del Monte 14.5oz $1.67, `is_marketplace=false`), НО `credits_remaining=37` — почти пусто.
- **Unwrangle** ❌ `credits_remaining=0`, `trialExhausted=true` — сейчас ничего не отдаёт.
- Вывод: ключи в `.env.local` — старые триальные. Платные подписки есть на дашбордах, но НЕ привязаны к этим ключам ⇒ блокер #1 очереди.

**2. `SkuCost` → репрайсер margin floor** (`src/lib/reprice/reprice-engine.ts`) — закрыл старую задачу #2:
- Было: единственный пол `$1.00`. Стало: при наличии `SkuCost` считается `marginFloorPrice = cost / (1 − AMAZON_REFERRAL_PCT 0.15 − TARGET_MARGIN 0.20)` = cost/0.65, и репрайсер НЕ опускает цену ниже.
- Новый исход `skipped_margin_floor` + счётчик `RunResult.skippedFloor` (в Telegram «придержано по марже N»). `loadCostFloors()` батч-грузит свежий cost на страницу SKU.
- Sellerboard cost = голый product cost (без Amazon-комиссии), поэтому формула вычитает referral. Обе константы — это вся модель маржи, легко тюнить. **dryRun по умолчанию** — живьём цены не поменяются без явного запуска.
- Работает на **217 Amazon-costs** уже в БД. Юнит-тест 3 сценария ✅ (above-floor reprices / below-floor blocked / no-cost → $1 legacy). `tsc` чисто.
- ⚠️ В БД висит битый `SkuCost` La Abuela `RizwanX-3877` $0.265 (старый прогон до фикса `extractPackSize`) — почистить при следующем заходе.

**3. Аналитика чистой прибыли — НЕ срослось:** `AmazonOrder` без line-items (только `orderTotal`/`numberOfItems`,
нет SKU). Join заказ→`SkuCost` невозможен без ингеста SP-API `getOrderItems`. Вынесено в под-проект (очередь #4).

---

## 🆕 СЕССИЯ 2026-06-10 (MacBook-Claude) — SHIPPING LABELS: 11 фиксов (всё в main + задеплоено)
Отдельная от COGS сессия. Владимир по скриншотам гонял реальные заказы на `/shipping`, я чинил.
**Всё запушено и на проде. Действий на iMac НЕ требуется**, кроме: после `git pull` сделать
`cd ss-control-center && npx prisma generate` (новая модель `WalmartLabelPurchase`). Таблица в Turso
**уже создана** мной (`scripts/turso-migrate-walmart-label-purchase.mjs`, idempotent) — локальный `.env.local`
смотрит в ТУ ЖЕ Turso, так что миграцию повторять не надо.

**Корень почти всех «странностей» был один: даты с маркетплейсов в UTC-кодировке (конец дня по Pacific,
`T06:59:59Z`), а разные части UI читали их по-разному.** Свели к одному: API нормализует в Pacific-YMD,
UI только рендерит. См. память `project_timezone_canonical` (обновил), `project_frozen_rate_policy` (обновил),
`project_walmart_label_dedupe` (новая).

Что сделано (по коммитам, см. `git log`):
1. **TZ-унификация** — `dashboard` отдаёт `deliverBy` через `utcToPacificYMD` (был сырой UTC → дедлайн на день позже);
   хелперы `daysLate`/`daysUntilDeadline` сравнивают календарные дни (`calDayUTC`). Это и был «рейт нормальный, а ошибка».
2. **Сервис клиента** (Standard/Expedited/NextDay) рядом с Customer Paid Shipping (`delivery_method.name`), ускоренные подсвечены.
3. **Label cost = цена override** (раньше показывал старую алго-цену при ручном выборе).
4. **Спиннер пересчёта** на Label cost/Carrier/Package при правке веса/коробки или Walmart re-quote.
5. **Override → покупка сквозь «stop»** (можно купить вручную выбранный рейт, когда алго остановил; жёлтое предупреждение «may ship late»).
6. **Перф** — параллельный pre-warm рейтов в `plan/route.ts` (было N последовательных вызовов Veeqo → лаг страницы).
7. **Frozen-рейты, 2 правила (Владимир одобрил):** (а) обычный **Ground разрешён**, если влезает в cal-day cap
   (cap уже учитывает погоду: при жаре 3→2 дня); убрано тупое «в среду ground не берём». Исключены только Saver/Economy.
   (б) «не быстрее 2-дней» стало **cost-aware**: дешёвый быстрый рейт берём (раньше брал дороже-и-медленнее).
8. **Walmart pick-rate диалог** — EDD в Pacific + плашка on-time/late считается по видимым датам (был сдвиг на день).
9. **Walmart double-buy** — новая таблица `WalmartLabelPurchase` (durable-запись о покупке): пишется при покупке,
   проверяется в guard'е `/walmart/buy` + в `/walmart/rates` (показ «куплено») + чистится при discard. Закрывает окно,
   где Walmart-lookup ещё не проиндексировал свежую этикетку (eventual consistency) и заказ снова казался «купить».
10. **Никогда не покупать Walmart через Veeqo** без явного переключателя — серверный guard в `/shipping/buy`
    (клиент шлёт `allowWalmartViaVeeqo` только в режиме toggle="veeqo").
11. **Прочие UX-баги:** успешная покупка больше не показывается как «failed» (печать/refresh вынесены в non-fatal,
    helper `errMsg` убил «[object Object]»); Walmart-строки без габаритов показывают честное «Set weight/size»
    вместо фантомного Veeqo-рейта; **новый Walmart-заказ опознаётся сразу** (PO резолвится из Walmart on-demand в
    `dashboard`, не ждём 2ч cron) — иначе он был «не купить ни через Walmart, ни через Veeqo».

⚠️ Если Владимир на iMac покажет новый shipping-баг — контекст выше + три памяти (`project_timezone_canonical`,
`project_frozen_rate_policy`, `project_walmart_label_dedupe`) дают полную картину правил.

---

## 🆕 ПОСЛЕДНЯЯ СЕССИЯ 2026-06-08/09 — разбор таблицы + фиксы движка (всё запушено)
Владимир разобрал Google-таблицу → правки внесены ([cogs-sheet-review-2026-06-08.md](cogs-sheet-review-2026-06-08.md)):
- ✅ **Категории Frozen/Dry** — LLM-аудит всего каталога (`scripts/cogs-category-audit.ts`): применено 207+109,
  охлаждёнка (сыр/масло/корм/Lunchables/дели) → Frozen. Итог: **Dry 674 / Frozen 452.** (Принцип: категория из БД, мозг не гадает.)
- ✅ **Гейт La Abuela $0.26 пофикшен** — `extractPackSize` больше не делит на «N count» (мешок 12-count = базовая единица; делят только «Pack of N / N-pack / case of N»).
- ✅ **is_bundle** — определение исправлено + проверено: Green Giant variety=true (разбор на 4 овоща), La Abuela=false.
- ✅ **Veeqo-фото fallback** в `cogs-identify-walmart.ts` (Walmart API без картинок → берём из Veeqo для vision вариаций).
- ✅ **Габариты убраны** из COGS-вкладки (это shipping + заглушки); вес оставлен (для льда).
- ✅ **Платные ключи BlueCart+Unwrangle** забраны в `ss-control-center/.env.local` (gitignored — НЕ в git).
- ⏳ **A-to-Z прогон из проекта работает** (`scripts/cogs-enrich-pilot.ts`), но триалы исчерпаны → **3/13** (у бакалеи на
  Walmart.com часто нет first-party, только наши STARFITSTORE+реселлеры → гейт режет верно). **БЛОКЕР: нужен платный
  апгрейд мульти-ритейлера (Target/Sam's/Publix).** Задача записана Джеки в `CLAUDE-TO-JACKIE.md` (файловый канал —
  ask_openclaw НЕ использовать, он поднимает копию Джеки без контекста). Ждём апгрейд → потом полный прогон 506 из проекта.
- 📌 Осталось (без оплаты, моя зона): переделать COGS-вкладку (3-я вкладка таблицы) + подключить SkuCost → репрайсер + /analytics.

## 🖥️ ВОСПРОИЗВЕСТИ СЕССИЮ MacBook НА iMac (Claude на iMac — сделай ПЕРВЫМ)
2026-06-08 на **MacBook** построили Stage B движка (в нашем проекте) и прогнали пилот на 13 SKU.
Чтобы ты увидел ТО ЖЕ САМОЕ и Владимир продолжил у тебя:

1. **`git pull`** — заберёт весь код: `src/lib/sourcing/retail-fetch.ts`, `scripts/cogs-enrich-pilot.ts`,
   `scripts/cogs-export-sheet.ts`, `scripts/cogs-identify-walmart.ts` + снапшот результатов
   `docs/sourcing/pilot-enriched.json` + батч мозга `docs/sourcing/brain-walmart-batch.json`.

2. **Ключи платных сервисов НЕ в git** (`.env.local` gitignored). Забери их с бокса Джеки в свой
   `ss-control-center/.env.local` (одной командой):
   ```
   ssh server 'node -e "const b=require(\"/root/.config/sourcing-accounts/bluecart.json\"),u=require(\"/root/.config/sourcing-accounts/unwrangle.json\"),o=require(\"/root/.config/sourcing-accounts/oxylabs.json\");process.stdout.write(`BLUECART_API_KEY=${b.api_key}\nUNWRANGLE_API_KEY=${u.api_key}\nOXYLABS_API_USER=${o.api_user}\nOXYLABS_API_PASSWORD=${o.api_password}\n`)"' >> ss-control-center/.env.local
   ```
   (Базовые creds — Turso/Amazon SP-API/Google OAuth — обычно уже в твоём `.env.local`; если нет —
   `vercel env pull` подтянет их из Vercel. **Секреты НЕ в git намеренно** — это небезопасно.)
   ⚠️ Команда выше требует, чтобы на iMac был настроен SSH-хост `server` (root@104.219.53.204) — тот же
   канал, через который Claude общается с Джеки. Если SSH не настроен — это единственная ручная настройка.

3. **Прогнать** (всё: `cd ss-control-center && npx tsx scripts/<name>.ts`):
   - `cogs-identify-walmart.ts` — мозг (vision) опознаёт 13 SKU → `SkuShippingData.productIdentity`.
   - `cogs-enrich-pilot.ts --no-unwrangle` — мульти-фетч (BlueCart=Walmart 1P), гейты, → `RetailPrice`
     (мульти-оффер) + `SkuCost`. Результат: **4/13 чистых first-party цены**.
   - `cogs-export-sheet.ts` — Google-таблица (или просто открой существующую, ссылка ниже).

4. **ТА САМАЯ Google-таблица** (владелец kuzy.vladimir@gmail.com, доступ по ссылке открыт):
   **https://docs.google.com/spreadsheets/d/15KG8OtehqbPKY2pIMwQsiPMk4IPG8T9SAH9c2ZmtNZ4**
   3 вкладки = 3 таблицы БД (Каталог+Опознание / Цены-все-офферы с фото =IMAGE() / COGS).
   ⚠️ **Владимир открыл её и имеет КРИТИЧЕСКИЕ + СРЕДНИЕ замечания** → продиктует на iMac; примени их.

5. **Где упёрлись:** мульти-ритейлер (Target/Sam's/Publix) = платный тариф (триалы Unwrangle/Oxylabs почти
   пусты; BlueCart покрывает только Walmart). Бесплатно дальше: (а) починить гейт — `RizwanX-3877` La Abuela
   дал битую $0.26/unit (неверный матч проскочил); (б) дописать Oxylabs+Instacart для Publix/BJ's/ALDI.
   Платный полный прогон 506 SKU ждёт решения Владимира по бюджету.

---

## 🪟 Открытые вкладки (рабочие потоки)

### Вкладка 1 — COGS / Product Sourcing Engine (ГЛАВНОЕ, не доделано)
Строим «умный движок-мозг»: по нашему SKU → распознать настоящий товар по **фото+тайтлу** →
понять размер/упаковку/вкус и **сколько единиц в листинге** → найти цену **базовой единицы** в
рознице → хранить **cost-per-unit отдельной колонкой** → COGS листинга. Тот же движок потом
ищет НОВЫЕ товары и собирает все данные для новых листингов.

### Вкладка 2 — Improve Walmart Sales (параллельно)
Рост продаж Walmart через API: Listing Quality score (живой ≈53/100; тянут вниз shipping/reviews/offer),
Buy Box + Item Performance отчёты. Сделано Phase A (Listing Quality трекинг: `src/lib/walmart/listing-quality.ts`,
`persist-listing-quality.ts`, миграция `20260607130000_walmart_listing_quality`, `diag-walmart-growth.ts`) +
Phase B (Buy Box report pipeline + UI). **Phase C (репрайсер Walmart) ОТЛОЖЕН до готовности COGS** —
вот связь между вкладками: COGS-движок кормит Walmart-репрайсер (держать Buy Box на марже ≥20%).
Ориентир: `reference_walmart_ranking_criteria` (память) + `docs/wiki/walmart-growth-listing-quality.md`.

---

## ✅ COGS-движок — что УЖЕ построено (всё на GitHub + прод Turso)

**Схема БД (мигрировано dev + прод):**
- `SkuCost` — дат. себестоимость, раздельно `productCost / packagingCost / iceCost / totalCost / costPerUnit`, idempotent по (sku, source, effectiveDate).
- `RetailPrice` — находки цен от движка, idempotent по (retailer, retailer_product_id); `isBaseUnit`/`unitMismatch` отделяют одиночную единицу от мультипака.
- `SkuShippingData` += `upc`, `productIdentity` (JSON vision-распознавания), `unitsInListing`, `baseUnitDesc`.

**Скрипты (`ss-control-center/scripts/`):**
- `cogs-identify.ts` — 🧠 vision: фото+тайтл → точный товар + число единиц. Читает Amazon SP-API. ДОКАЗАН (увидел Cheez-It Grooves сквозь наш private-label; поймал ошибку вкуса в атрибутах; посчитал «10ct Pack of 3 = 3 коробки»).
- `cogs-identify-walmart.ts` — 🧠 тот же мозг, но вход = **Walmart-листинг** из нашей БД (`WalmartCatalogItem`/`SkuShippingData`). Та же vision-логика+промпт, Amazon-мозг не трогает. Нужен потому, что Amazon-мозг не видит Walmart-SKU.
- `cogs-extract-upc.ts` — UPC из наших листингов (Walmart 514/514, Amazon 404/594).
- `cogs-join-catalog.ts` — джойн каталога × Sellerboard (`docs/cogs-coverage.json`).
- `cogs-seed-sellerboard.ts` — сидинг (217 Amazon costs залито).
- `cogs-ingest-retail.ts` — ингест розничных цен → RetailPrice + SkuCost.
- `cogs-product-structure.ts` — парсер Sellerboard CSV (пак/вкус).

**Данные в проде сейчас:** 217 Amazon-себестоимостей (sellerboard) + 10 розничных; UPC у 918/1109 SKU; vision-идентичности для нескольких демо-SKU.

**Запуск скриптов:** `cd ss-control-center && npx tsx scripts/<name>.ts` (env грузится через dotenv: `.env.local` + `.env`; НЕ через shell-source — Amazon refresh-токены содержат `|`).

---

## 🔑 Ключевые находки (определяют дизайн)

1. **UPC-ловушка.** Walmart-«UPC» в наших листингах = seller-коды мультипаков, ведут на НАШИ ЖЕ
   бандлы (Cheetos Pack of 3 $20.99), а не на штрихкод производителя. ⇒ матчим **по названию к базовой единице**, не по UPC.
2. **Walmart.com забит реселлерскими мультипаками** (Jackie, утро 06-08): даже поиск по названию на
   Walmart.com упирается в мультипаки. Нужен структурный источник с фильтром **pack_size=1 + first-party**.
3. **Sellerboard = только Amazon** (217 из 2837 cost-строк; Walmart — ноль). Walmart COGS только через движок.
4. **Frozen:** храним product/упаковку/лёд раздельно (Sellerboard frozen уже включает упаковку — не дублировать).

## 🛰️ Сервисы скрапинга/цен — ИТОГ (ресерч Jackie, пилоты прогнаны 06-08)

| Сервис | Вывод |
|---|---|
| **BlueCart** (Traject Data) | ⭐ ПОБЕДИТЕЛЬ для COGS — отдаёт **first-party Walmart** цену (`is_marketplace:false`, `sold_by:Walmart.com`, conf 0.95). Напр. Oroweat Keto 20oz **$6.48 1P** (Unwrangle на тот же SKU дал реселлера MiniXpress $12.76). |
| **Unwrangle** | Target/Costco/Sam's; по Walmart часто отдаёт marketplace-продавца (хуже для 1P base). |
| **ScrapeHero** | Покрывает BJ's/Publix/ALDI (нет своего API) — для тех ритейлеров. |
| **Instacart** | Альтернатива для grocery first-party цен (Jackie пробовал). |
| **Free Gemini-grounded search** | Только 35% годных (мультипак-загрязнение); Walmart.com напрямую = CAPTCHA. Годится для матчинга, НЕ для цен. |
| **Decodo** | Универсальный fallback-скрейпер. |

**Оплата:** Jackie подтвердил трату ≤$60 НАПРЯМУЮ в своём Telegram (он Telegram-Jackie, видит слова Владимира сам). Аккаунты BlueCart/Unwrangle/Instacart открыты (trial/≤$10). $ к списанию — он отчитывается в файле ниже.

**Двухсторонняя связь с Jackie:** SSH (`ssh openclaw`, root) + файлы в `/root/.openclaw/workspace/projects/product-sourcing-engine/`:
`CLAUDE-TO-JACKIE.md` (Claude пишет) ↔ `JACKIE-TO-CLAUDE.md` (Jackie пишет, Claude читает по SSH) ↔ `results/*.json` (цены). При делегировании через `ask_openclaw` просить Jackie сперва прочитать эти файлы (мост stateless).

---

## 🔗 СЕССИЯ 2026-06-08 (день, MacBook-Claude) — СОЕДИНИЛ ДВА ЗВЕНА
Диагноз Владимира: пилот Джеки 9/13 был на **сырых тайтлах, БЕЗ мозга** (Stage A и Stage B
тестировались по отдельности, ни разу не в связке). Сделано:
- `cogs-identify-walmart.ts` прогнан на **тех же 13 SKU Джеки → 13/13 опознано.** Мозг закрыл все
  4 провала: Country Oatmeal (линейка), Creamy Mushroom (вкус vs Clam Chowder), La Abuela (бренд vs
  La Banderita), **Green Giant variety → разложен на компоненты** (это снимает открытую развилку ниже).
- Батч резолва → `docs/sourcing/brain-walmart-batch.json` → передан на бокс Джеки + инструкция в
  `CLAUDE-TO-JACKIE.md`: гнать сервисы по запросам МОЗГА (не сырым тайтлам) и вернуть **весь пул инфо**
  (цена + description + key_features + image_urls), не только цену.
- ⏳ **Ждём `results/brain-walmart-results.json` от Джеки** → ingest → сверка recovery vs 9/13.
  (Картинки в кэше пусты → мозг отработал title-only; следующее улучшение — дотянуть Veeqo-фото.)

### 🏭 ДВИЖОК STAGE B ТЕПЕРЬ В НАШЕМ ПРОЕКТЕ (не у Джеки) + пилот, 2026-06-08 (день)
Владимир уточнил: движок ЖИВЁТ У НАС и обогащает НАШУ БД (Джеки/сервисы — лишь инструмент). Цель —
прогнать все **506 Walmart-SKU, проданных с 2025-12-01** (1091 заказ; 410/506=81% уже в каталогах с заголовком,
0 с картинкой, 0 с ценой/описанием), мульти-ритейлерно (Walmart/Target/Sam's/Costco/Publix/BJ's), хранить
**лучшую цену + где купить + несколько офферов** + полное описание + фото. Потребитель — Walmart Growth.
- ✅ **`src/lib/sourcing/retail-fetch.ts`** — фетчеры BlueCart(Walmart 1P)+Unwrangle(Target/Sam's/Costco),
  нормализация, гейты (отсев наших/реселлерских офферов, base-unit, sanity цены, токен-гейт по бренду/вкусу).
  Вызывает платные API ПРЯМО из нашего проекта (ключи в `.env.local`, аккаунты info@salutem.solutions). 20s timeout.
- ✅ **`scripts/cogs-enrich-pilot.ts`** — оркестратор: identity → мульти-фетч → ВСЕ офферы в `RetailPrice`
  (мульти-оффер, вердикт гейта в `matchMethod`) → дешёвый чистый base-unit → `SkuCost`. Держится в бесплатных триалах.
- ✅ **Пилот 13 SKU (BlueCart): 4/13 чистых first-party цены** (Arnold Whole Grains $3.98, Del Monte $1.67,
  Sara Lee Brioche $3.86 = совпало с Джеки, La Abuela $0.26 ⚠️БИТАЯ — гейт пропустил, чинить). **9/13 на Walmart
  1P нет** (только наши STARFITSTORE + реселлеры + $0/$88.99) → НАШ движок воспроизвёл вывод Джеки: **нужны другие ритейлеры.**
- ✅ **`scripts/cogs-export-sheet.ts`** → Google-таблица для Владимира (3 вкладки = 3 таблицы БД, фото через =IMAGE()):
  https://docs.google.com/spreadsheets/d/15KG8OtehqbPKY2pIMwQsiPMk4IPG8T9SAH9c2ZmtNZ4
- ⛔ **РАЗВИЛКА ПО ДЕНЬГАМ:** мульти-ритейлер (Target/Sam's/Publix) = платный тариф (триалы Unwrangle/Oxylabs почти
  пусты, BlueCart=Walmart-only). Полный прогон 506 SKU ждёт решения Владимира по бюджету.

## ▶️ ПЛАН / где остановились — что делать дальше

> ⚠️ ВАЖНО (уточнение Владимира 06-08): **ДВИЖОК НАШ и обогащает НАШУ БД** (`cogs-enrich-pilot.ts`).
> Прогон Джеки по `brain-walmart-batch.json` (шаг 1) — лишь ПОБОЧНАЯ дешёвая проверка «мозг vs сырой
> тайтл», НЕ основной путь сбора. Основной путь = наш Stage B (см. блок «ДВИЖОК STAGE B В НАШЕМ ПРОЕКТЕ»).

1. **[Jackie, опционально]** Прогнать сервисы по **brain-walmart-batch.json** (запросы мозга, не сырые тайтлы)
   → `results/brain-walmart-results.json`. Только как сравнение recovery vs его сырой-тайтл 9/13. Не блокирует нас.
2. **[Claude]** Забрать `results/*.json` по SSH → `npx tsx scripts/cogs-ingest-retail.ts <file>` → RetailPrice + SkuCost. Сверить с Sellerboard (answer key для Amazon).
3. **[Claude]** Прогнать `cogs-identify.ts` пачкой по всем Amazon-SKU (есть фото через SP-API) → заполнить productIdentity/unitsInListing для всего каталога.
4. **[Claude]** Подключить `SkuCost` → **репрайсер** (margin floor вместо $1, `src/lib/reprice/reprice-engine.ts`) и → **/analytics** (чистая прибыль).
5. **[масштаб]** Прогнать BlueCart/Unwrangle/ScrapeHero по всем ~1100 проданным SKU (разово, без месячных подписок) → полный COGS.

## 📌 Открытые решения
- Цены брать с Walmart 1P (BlueCart) или с реального источника закупки (Sam's/BJ's/grocery)? — для frozen и для точности скорее источник закупки.
- ~~Вариативные наборы (Green Giant 8-pack variety) — покомпонентно или пак за единицу?~~ ✅ РЕШЕНО: мозг
  раскладывает на компоненты (`components[]`), COGS = Σ(цена компонента × qty). Джеки прайсит каждый компонент.

## 📋 РАЗБОР ТАБЛИЦЫ ВЛАДИМИРОМ (2026-06-08) — чек-лист правок
→ **[cogs-sheet-review-2026-06-08.md](cogs-sheet-review-2026-06-08.md)** — 11 замечаний по 3 вкладкам + диагноз/фиксы.
ГЛАВНОЕ: движок НЕ выдумывает category/dims/weight (берём из `SkuShippingData`); is_bundle инвертирован (баг);
жёсткий first-party фильтр (отсев реселлеров); дотянуть фото (Veeqo) для разбора вариаций; ≥5 фото + полный контент;
переделать COGS-вкладку; цены на 5 ритейлерах (Walmart/Target/BJ's/Sam's/Publix) + лучший источник.

## 🔗 Связанные документы
[Build Plan](product-sourcing-engine-build-plan.md) · [Engine](product-sourcing-engine.md) · [COGS Agent](cogs-true-cost-agent.md) · [Walmart Growth](walmart-growth-listing-quality.md). Память: `project_product_sourcing_engine`, `project_sku_unit_economics`, `project_walmart_growth_levers`.
