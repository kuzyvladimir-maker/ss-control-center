# 🔄 SESSION HANDOFF — читать ПЕРВЫМ при продолжении на любой машине

> **Как пользоваться:** на новой машине скажи Claude: *«прочитай вики и найди
> SESSION-HANDOFF»*. Здесь — что мы делали, где остановились, и план. Обновляется
> в конце каждой сессии.
>
> **Последнее обновление:** 2026-06-09 (MacBook-Claude — синк-чекпойнт: спулил работу iMac, перечитал
> обменник + разбор таблицы, всё консистентно, нового кода НЕ писал). Владимир уехал домой → **продолжает на iMac.**
> Главная незаконченная задача — **COGS / Product Sourcing Engine.**

## ▶️▶️ ПРОДОЛЖИТЬ ОТСЮДА (Claude на iMac, 2026-06-09) — что делать дальше
Состояние консистентно, всё на GitHub (`git pull` сперва). Бюджет на мульти-ритейлер **Владимир ОДОБРИЛ**
(см. `cogs-sheet-review-2026-06-08.md` §БЮДЖЕТ). Очередь (по приоритету):
1. **[без оплаты, делать сейчас]** Переделать **COGS-вкладку** экспорта (понятный формат: SKU → название,
   units, cost-per-unit, total, источник, где купить, чистые notes — см. замечание #11) + вкладка вариаций.
2. **[без оплаты]** Подключить `SkuCost` → **репрайсер** (`src/lib/reprice/reprice-engine.ts`, margin floor
   вместо $1) и → **/analytics** (чистая прибыль). Это и есть смысл COGS для бизнеса.
3. **[ждёт Джеки → платный апгрейд]** Полный прогон 506 Walmart-SKU из проекта (`cogs-enrich-pilot.ts`)
   на 5 ритейлерах (Walmart/Target/BJ's/Sam's/Publix), жёсткий first-party фильтр, ≥5 фото + Nutrition+состав,
   разбор вариаций (Green Giant ×4), лучший источник. Задача Джеки записана в `CLAUDE-TO-JACKIE.md`.
⬇️ детали ниже: «ПОСЛЕДНЯЯ СЕССИЯ», «ВОСПРОИЗВЕСТИ НА iMac», `cogs-sheet-review-2026-06-08.md`.

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
