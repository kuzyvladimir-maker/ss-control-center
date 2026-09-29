# Uncrustables: как создавались листинги и картинки — полное руководство для агента

> **Для кого:** агент нового маркетплейса Владимира (без доступа к нашим чатам и базе).
> **Составлено:** 2026-09-29 из боевого конвейера batch-200 (10–13 августа 2026, 200 листингов
> на Amazon store1) и ремонта листинга B0H776M5B5 (2026-09-15).
> **Где лежит оригинал:** репозиторий GitHub `kuzyvladimir-maker/ss-control-center` (публичный),
> файл `docs/wiki/uncrustables-listing-and-image-guide-for-agents.md`; на MacBook Pro Владимира —
> `/Users/amazon/ss-control-center/docs/wiki/uncrustables-listing-and-image-guide-for-agents.md`.
> Короткая версия принципов: [frozen-main-image-portable-playbook.md](https://github.com/kuzyvladimir-maker/ss-control-center/blob/main/docs/wiki/frozen-main-image-portable-playbook.md).

Как читать: §1 — где лежат референсные картинки, §2 — как рождается листинг (рецепт, текст, цена),
§3 — как рождается картинка, §4 — проверка, §5 — публикация, §6 — грабли, §7 — что нельзя перенести
как есть. Все ссылки на код и картинки ведут в публичный репозиторий (ветка `main`).

---

## 1. Референсные картинки

Базовый адрес для файлов из репозитория: `https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/` + путь.

### 1.1 Якорь сцены (первый референс для КАЖДОЙ генерации)

Owner-approved кадр: белый пенопластовый кулер с логотипом Salutem, ровно четыре гель-пака
(два внутри, два снаружи спереди справа), фрост без льда, ракурс 3/4, крышка сзади.
Модель копирует с него кулер, логотип, гели, свет и композицию, но **не товары**.

- [ref-uncrustables.png](https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/public/bundle-factory/frozen-refs/ref-uncrustables.png)
  — SHA-256 `9c45164a56e3cda1e9e0c2590e7d75d94e6320af012b841bc9e5b73594a1fd33`
- Продакшен-копия в облаке: `https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/prod/frozen-refs/anchor-uncrustables.png`
- Запасной пример (круассаны Jimmy Dean, не для Uncrustables):
  [ref-jimmy-dean.png](https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/public/bundle-factory/frozen-refs/ref-jimmy-dean.png),
  SHA-256 `d6387696c6a8e100a838c284bf73533bd3f3682a470ce48ac714e9511dae4900`
- Описание: [frozen-refs/README.md](https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/public/bundle-factory/frozen-refs/README.md)

Правило: скачанные байты якоря обязаны совпасть с SHA-256. Нет файла или хэш другой — генерация
запрещена. «Похожая» картинка не заменяет якорь.

### 1.2 Три утверждённых образца результата (как должен выглядеть итог)

Эталонные рендеры GPT Image 2, одобренные владельцем 2026-07-17–18. Один на каждый класс:

| Класс | Файл | SHA-256 |
|---|---|---|
| Один вкус, коробки | [01c-…four-gel-packs.png](https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/data/audits/uncrustables-gpt-image-2-previews-20260718/01c-retail-boxes-single-pb-24-four-gel-packs.png) | `4cdd7bec9ab5c1d5f97b5746d7569a4ffc891a36b8d1fb159168176f06e19076` |
| Микс вкусов, коробки | [02b-…four-gel-packs.png](https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/data/audits/uncrustables-gpt-image-2-previews-20260718/02b-retail-boxes-mix-pb-blackberry-24-four-gel-packs.png) | `9d0294242508529022a0e2b1cdd2df0adce469ef9dbb8bd2dd7d448031ea839d` |
| Индивидуальные упаковки | [03-individual-wraps…png](https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/data/audits/uncrustables-gpt-image-2-previews-20260718/03-individual-wraps-mix-hazelnut-berry-24.png) | `d2f7ffdd0a3e411725a3dc1dac013f9f5f50c1e6dd9d34164c12cbe5cacc722f` |

Манифест превью (промпты, референсы, хэши): [preview-manifest.json](https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/data/audits/uncrustables-gpt-image-2-previews-20260718/preview-manifest.json).

### 1.3 Эталоны упаковки (по одному на каждый вкус и размер коробки)

Это реальные фото лицевой стороны розничных коробок (источник — карточки ретейлера), проверенные
по SHA-256 и внесённые в реестр подлинности. В рендер каждый эталон идёт как референс №2, №3…
(не больше 6 референсов вместе с якорем). Реестр:
[v1](https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/src/lib/bundle-factory/audit/data/uncrustables-authenticity-registry-v1.json) ·
[v2-extension](https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/src/lib/bundle-factory/audit/data/uncrustables-authenticity-registry-v2-extension.json) ·
[v3-extension](https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/src/lib/bundle-factory/audit/data/uncrustables-authenticity-registry-v3-extension.json).
Совпадение названия или URL без совпадения байтов по SHA не считается подтверждением.

| Реестр | Вкус (flavor_id) | Тип | Счёт в коробке | Картинка | SHA-256 (начало) |
|---|---|---|---|---|---|
| v1 | peanut-butter | retail-carton | 4 | нет в репозитории (см. §1.4) | `19af7bad5c0f6654…` |
| v1 | peanut-butter-blackberry | retail-carton | 4 | нет в репозитории (см. §1.4) | `305a6ffab3b3a330…` |
| v1 | chocolate-hazelnut | retail-carton | 4 | нет в репозитории (см. §1.4) | `4d42bd45bb25aa1b…` |
| v1 | chocolate-hazelnut | individual-wrapper | 1 | нет в репозитории (см. §1.4) | `846005feea2a4310…` |
| v1 | morning-protein-mixed-berry | retail-carton | 8 | нет в репозитории (см. §1.4) | `177f2e781d838ff4…` |
| v1 | morning-protein-mixed-berry | individual-wrapper | 1 | нет в репозитории (см. §1.4) | `846005feea2a4310…` |
| v2-extension | peanut-butter-and-strawberry-jam | retail-carton | 4 | нет в репозитории (см. §1.4) | `6ec1287fa7f5ddfa…` |
| v2-extension | peanut-butter-and-grape-jelly | retail-carton | 4 | нет в репозитории (см. §1.4) | `ce7b6466391e77af…` |
| v2-extension | peanut-butter-and-raspberry-spread | retail-carton | 4 | нет в репозитории (см. §1.4) | `ec18c8cf6fef595c…` |
| v2-extension | peanut-butter-and-honey-spread | retail-carton | 10 | нет в репозитории (см. §1.4) | `c1e65e50ed643f2c…` |
| v2-extension | peanut-butter-and-chocolate-flavored-spread | retail-carton | 10 | нет в репозитории (см. §1.4) | `837c61b9d078b617…` |
| v2-extension | peanut-butter-and-strawberry-jam-protein | retail-carton | 8 | нет в репозитории (см. §1.4) | `866c1a1f32d8801f…` |
| v2-extension | whole-wheat-peanut-butter-and-strawberry-jam | retail-carton | 4 | нет в репозитории (см. §1.4) | `467c42745d30b082…` |
| v2-extension | peanut-butter-and-apple-cinnamon-jelly-protein | retail-carton | 8 | нет в репозитории (см. §1.4) | `641f7cb6484dc3b0…` |
| v2-extension | whole-wheat-peanut-butter-and-grape-jelly | retail-carton | 4 | нет в репозитории (см. §1.4) | `806cb10ae5156efd…` |
| v2-extension | peanut-butter-and-blueberry | retail-carton | 8 | нет в репозитории (см. §1.4) | `52060c93abe80c3d…` |
| v2-extension | peanut-butter-and-mixed-berry-spread | retail-carton | 4 | нет в репозитории (см. §1.4) | `12923576c5011c33…` |
| v3-extension | peanut-butter-and-strawberry-jam | retail-carton | 15 | нет в репозитории (см. §1.4) | `a69b36f33369cfc2…` |
| v3-extension | peanut-butter-and-strawberry-jam | retail-carton | 24 | нет в репозитории (см. §1.4) | `ffd5cab863404dc6…` |
| v3-extension | peanut-butter-and-strawberry-jam | retail-carton | 10 | нет в репозитории (см. §1.4) | `d9b47a0e67fd69e5…` |
| v3-extension | peanut-butter-and-grape-jelly | retail-carton | 10 | нет в репозитории (см. §1.4) | `3fa3d74b65036237…` |
| v3-extension | peanut-butter-and-grape-jelly | retail-carton | 15 | нет в репозитории (см. §1.4) | `3820df0ef3b6a5f7…` |
| v3-extension | peanut-butter-and-grape-jelly | retail-carton | 18 | нет в репозитории (см. §1.4) | `2eb47c4b5fa22ffc…` |
| v3-extension | peanut-butter-and-grape-jelly | retail-carton | 24 | нет в репозитории (см. §1.4) | `33069a347d064c7a…` |
| v3-extension | peanut-butter-and-raspberry-spread | retail-carton | 15 | нет в репозитории (см. §1.4) | `1a315b6f3e59c212…` |
| v3-extension | peanut-butter-and-raspberry-spread | retail-carton | 10 | нет в репозитории (см. §1.4) | `4e33a577afa9a410…` |
| v3-extension | peanut-butter-and-honey-spread | retail-carton | 4 | нет в репозитории (см. §1.4) | `42b4f40b75fd85bd…` |
| v3-extension | peanut-butter-and-chocolate-flavored-spread | retail-carton | 4 | нет в репозитории (см. §1.4) | `3fcc01471ef1ac1c…` |
| v3-extension | chocolate-hazelnut | retail-carton | 10 | нет в репозитории (см. §1.4) | `ac4a462caab23c3e…` |
| v3-extension | chocolate-hazelnut | retail-carton | 15 | нет в репозитории (см. §1.4) | `740ab60add4b3c9d…` |

### 1.4 Что НЕ удалось приложить (честно)

- 15 эталонов из v3-extension (коробки 10/15/18/24 шт., собраны 2026-08-15 по обзору владельца,
  папка `data/audits/uncrustables-owner-art-review-20260815/`) **не лежат в git и на этом
  MacBook Pro не найдены**. В реестре есть их SHA-256, но самих файлов у меня нет; их нужно
  восстановить из ретейлерных карточек и сверить по хэшу.
- Эталоны — фото чужого товара (упаковка Smucker's) с сайтов ретейлеров. Для нового сайта используйте
  собственный легальный источник (фото производителя/поставщика).
- Для вкуса **Blackberry Boom** реестр v1 содержит фото с Target
  `product-blackberry-target.jpg`. Фото для листинга B0H776M5B5 были взяты из базы донорских товаров.

---

## 2. Как создавался листинг (до картинки)

Ключевой код: [uncrustables-box-planner.ts](https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/src/lib/bundle-factory/uncrustables-box-planner.ts),
[uncrustables-studio-run.ts](https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/src/lib/bundle-factory/uncrustables-studio-run.ts),
[uncrustables-stage.ts](https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/src/lib/bundle-factory/uncrustables-stage.ts),
[cost-model.ts](https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/src/lib/pricing/cost-model.ts).

### 2.1 Рецепт = раскладка коробок
Единица планирования — **раскладка**, а не сумма. Рецепт: список позиций `{вкус, qty, размер коробки}`.
Один вкус может занимать несколько позиций (10 + 10 + 4 винограда). Разные раскладки с одной суммой — разные
листинги, потому что картинка разная (правило владельца 2026-08-15).

Проверка `validateRecipe`:
- вкус есть в каталоге; размер коробки — из реальных фасовок **4, 8, 10, 15, 18, 24**;
- `qty` делится нацело на размер коробки;
- итог в рациональных зонах кулера: **S 24–30 · M 48–54 · L 60–66 · XL 90–135**. Зоны 31–47, 55–59,
  67–89 — «мёртвые»; ниже 24 штук экономика не сходится ($6.62 за сэндвич при рознице ~$1);
- лимиты сцены: ≤4 вкуса, ≤11 коробок, ≤4 ряда, ≤4 коробки в ряду.

Отгружаем всегда россыпью в кулере; коробки на картинке — для узнаваемости.

### 2.2 Текст листинга
Генерируется детерминированно (`buildListingCopy`, без LLM). Заголовок:
`Smucker's Uncrustables Frozen Sandwich Variety Pack, <вкусы>, <N> Count`.
Пять буллетов: состав по вкусам; «Packed in original retail boxes: …» построчно; описание упаковки
каждого сэндвича; `Keep frozen. Thaw … 30 to 60 minutes … within 8 hours. Do not refreeze.`;
кулер и гель-паки как упаковка. Описание — обычный текст, абзацы через пустую строку.

Бренд-голос (обязательно): **без эмодзи**, без промо-прилагательных (ultimate, perfect, premium, best…),
без ручных маркеров `•`, без HTML в описании, без заявлений о продаже/доставке
(`Keep frozen` ✅ — `Ships frozen` ❌, `free shipping` ❌), без медицинских заявлений. Название вкуса с
коробки (например Blackberry Boom) — факт и допустимо.

### 2.3 Цена
Модель провалидирована на реальных продажах (2026-06-15): `себестоимость = штуки × $1 + упаковка кулера
(S 7.5 / M 10.9 / L 14.1 / XL 18.9) + этикетка (S 20 / M 32 / L 45 / XL 60)`, цена товара =
**landed × 1.5**, коридор репрайсера min = landed × 1.3, max ≈ landed × 1.53. Покупатель платит доставку
отдельно. Ориентиры: 24 шт → $76.99, 30 → $88, 48 → $138, 90 → $256. Цель — ~70% ROI на вложенные
деньги (товар + упаковка).

### 2.4 Идентификаторы
Каждому SKU выдаётся уникальный SKU и UPC из пула; UPC, уже занятый на Amazon, нельзя (был главный
блокер публикации). Категория/тип: `GROCERY` с полным набором атрибутов (temperature_rating Frozen,
unit_count, fc_shelf_life, melting_temperature, manufacturer, ...).

---

## 3. Как создавалась главная картинка (MAIN)

Контракт: [BUNDLE_FACTORY_FROZEN_MAIN_IMAGE_v2.0.md](https://github.com/kuzyvladimir-maker/ss-control-center/blob/main/docs/BUNDLE_FACTORY_FROZEN_MAIN_IMAGE_v2.0.md).
Код: [uncrustables-render-contract.ts](https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/src/lib/bundle-factory/uncrustables-render-contract.ts),
[uncrustables-render-runner.ts](https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/src/lib/bundle-factory/uncrustables-render-runner.ts),
[image-generation.ts](https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/src/lib/bundle-factory/image-generation.ts).

### 3.1 Общая схема
```
рецепт → подбор эталона на каждую позицию → референсы [якорь, эталон1, эталон2…≤6]
      → промпт (базовый + контракт по рецепту) → GPT Image 2 → скачать байты, sha256, размеры
      → QA-офицер (3 голоса) → одобрено → в карточку
```
Модель: **GPT Image 2** через Codex CLI на подписке ChatGPT (`image_gen`), /bin/bash за картинку.
Воркер на отдельном сервере, вызов `POST /codex-image/generate`; на выходе PNG, приводится к
**2048×2048**. Одна картинка — 2–5 минут; параллелить бесполезно (один воркер).

### 3.2 Базовый промпт (смысл)
Профессиональное e-commerce фото на **чисто белом фоне**, квадрат 1:1. Референс №1 — якорь: копировать
только кулер, эмблему, надписи, **ровно 4 гель-пака**, камеру, свет, раскладку; товары с якоря не копировать.
Референсы №2..N — эталоны упаковки: копировать бренд, точное название вкуса, цвета, рисунок и настоящий
печатный счёт дословно; не переупаковывать, не подменять. Ровно N коробок внутри кулера, посажены за
передний внутренний борт, общая перспектива и свет, контактные тени; не парят, нет зазоров и «вырезанных»
краёв. Брендинг Salutem — **только** на кулере и гель-паках. Лёгкая роса, **никакого льда/снега**. Без людей,
рук, реквизита, надписей поверх, водяных знаков и меток ретейлеров.

### 3.3 Блок контракта (собирается кодом из рецепта — не писать руками)
- **REFERENCE MAPPING:** «Ref k = коробка на N штук вкуса X, лицевая панель читается дословно "…";
  нарисуй ровно B таких, бейдж "N" и рисунок не менять».
- **ROW LAYOUT CONTRACT:** ряды сзади вперёд, «Row 1 (back): EXACTLY n коробок … Count: one, two…».
  Одновкусовые позиции идут в один ряд, пока ≤4; ряд из >4 коробок переливается на следующий ряд того же
  вкуса. Итог «TOTAL cartons: EXACTLY T».
- **CARTON SCALE:** большая фасовка физически больше коробка; 4-count не рисовать шире 8/10-count.
- **ROW FITS THE COOLER:** гель-паки не перекрывают лицевые панели.
- **FRUIT ART:** на коробке только рисунок своего вкуса.
- **GEL PACKS + GEL PACK TEXT:** ровно четыре; на каждом дословно "FROZEN GEL PACK", "KEEP FROZEN"
  (F-R-O-Z-E-N), "FOR FROZEN SHIPMENTS", лотос, "SALUTEM SOLUTIONS", "OUR BEST SOLUTIONS FOR YOU".
- **SMUCKER'S BANNER / COUNT BADGES:** орфография бренда посимвольно; на бейдже цифра, скопированная
  с эталона (8 — две петли, не B и не 6).
- **RETAILER FLAGS:** метки ретейлеров («Only at Walmart») не рисовать.
- **NO LOOSE PROPS, BRANDING, FRONT TEXT:** лишних предметов нет; логотип копировать с якоря; текст
  лицевой панели дословно, самые длинные слова диктуются побуквенно.

### 3.4 Точный текст лицевой панели (`frontPanelText`)
Корневая причина «выдуманного товара»: модель печатала наше внутреннее название на настоящей упаковке.
Пример: реальная пачка Whole Wheat пишет «Strawberry **Spread**», внутреннее имя — «Strawberry Jam».
Поэтому в каталоге вкусов хранится точная надпись с фото, и контракт подаёт модели именно её.
Пример для нашего листинга: `BLACKBERRY BOOM / Peanut Butter & Blackberry Spread Sandwich`.

### 3.5 Правила подлинности (кратко)
Нельзя: выдумывать вкус/упаковку/бейдж, печатать суммарный count листинга на упаковке, стирать настоящий
печатный счёт, подставлять эталон другого вкуса или размера. Название и картинка — только точные варианты
из рецепта. Количество видимых коробок × печатный счёт = qty (нарушение этого правила и привело к отказу
Amazon 18320 у B0H776M5B5: 4 коробки на картинке при рецепте 6).

---

## 4. Проверка: QA-офицер и гейты

Код: [frozen-main-qa.ts](https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/src/lib/bundle-factory/audit/frozen-main-qa.ts).
Второй вызов зрения (Claude на подписке, $0) отвечает **только JSON** о том, что реально видно:
число коробок, коробки по вкусам с прочитанным бейджем, подлинность упаковки, целостность логотипа,
искажённый текст (список слов), число гель-паков и надпись KEEP FROZEN, брендинг кулера, белый фон,
лёд/люди/реквизит/оверлей. Решение принимает код, три прогона, блокирует то, что увидело большинство.

- **Блокеры:** общий счёт коробок, неподлинная упаковка, обрезанный логотип, орфография крупного
  текста, гель-паков ≠ 4, не «KEEP FROZEN», неверный брендинг кулера, фон не белый, лёд/реквизит.
- **Предупреждения (не блокеры):** поштучные бейджи и счёт по рядам — модель путает мелкие цифры
  (16 из 16 жалоб «badge 4 vs 8» оказались ложными).
- Если зрение недоступно → `verified:false` → **не публиковать**.
- Неудача QA → перегенерация, максимум 3 оценённые попытки; сбой воркера/QA попытку не списывает.
- Перед массовым прогоном: владелец одобряет по одной картинке каждого класса; любая правка промпта,
  якоря, эталонов или раскладки инвалидирует прошлое одобрение. На каждую картинку — манифест
  (модель, промпт, референсы с SHA, размеры, SHA результата).

---

## 5. Галерея и публикация

### 5.1 Галерея (до 8 слотов)
Слот 1 — фиксированная карточка «почему мы/холодная цепь»
(`https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/prod/brand/salutem-brand-card-v1.png`), без эмодзи и
без «Superior». Слоты 2–8 — донорские фото вкуса (упаковка, состав, инструкция, инфографика),
скопированные в собственное хранилище и увеличенные. Берётся по кругу между вкусами набора. Фото с
чужими вкусами или лайфстайлом не брать.

### 5.2 Публикация на Amazon
Полный конвейер: стейджинг (SKU/UPC/комплаенс) → подмена MAIN на прошедшую QA → галерея → минт пруфа по
точным байтам → запечатанный манифест → preflight-пермит → отправка (Listings API, PUT create-or-replace).
Скрипты: [_b2_auto.ts](https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/scripts/_b2_auto.ts) (автономный цикл), [_b2_render.ts](https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/scripts/_b2_render.ts),
[_b2_gallery.ts](https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/scripts/_b2_gallery.ts), [_b2_publish.ts](https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/scripts/_b2_publish.ts).
Для **уже существующего** листинга полный PUT опасен (может удалить sale price/купон) — только точечный PATCH
картинок с VALIDATION_PREVIEW, как в [_jfat_rebuild.ts](https://raw.githubusercontent.com/kuzyvladimir-maker/ss-control-center/main/ss-control-center/scripts/_jfat_rebuild.ts).

---

## 6. Грабли (что стоило времени)

1. Работа по устаревшему документу: 200 композитов «вырезал-вставил» ушли в утиль, потому что путь
   отменён контрактом v2.0. Читать всё по теме, а не первое найденное.
2. Из 323 генераций batch-200 полезных 122 (~38%): закладывайте ~2.5 попытки на листинг.
3. Одинаковые слаги затирали файлы волн — имя файла делать уникальным (хэш слага).
4. После правки калибровки QA перезапускать работающий цикл — он держит старый код в памяти.
5. Автомат живёт под launchd; системный cron на macOS без Full Disk Access не работает.
6. UPC из пула иногда уже занят на Amazon — проверять до присвоения.
7. Пути к файлам в реестре относительные; хэш проверять по байтам, а не по имени.

---

## 7. Что нельзя перенести на новый сайт как есть

- **Бренд и якорь.** Кулер, эмблема, гели — Salutem. Для другого бренда нужен новый утверждённый якорь.
- **Охлаждёнка ≠ заморозка.** Всё выше — только для заморозки; для chilled другой якорь и текст на гелях.
- **Правила Amazon.** Белый фон, запрет реквизита, слова-стоп — требования Amazon; на своём сайте их
  можно ослабить. Запрет на выдуманный товар и искажённый текст сохраняется всегда.
- **Эталоны** — фото ретейлеров; для нового сайта нужен свой законный источник.
- **Инфраструктура:** воркер Codex, база донорских товаров, пул UPC и Amazon-публикация принадлежат
  Salutem Control Center; в новом проекте их нужно пересоздать или заменить.
