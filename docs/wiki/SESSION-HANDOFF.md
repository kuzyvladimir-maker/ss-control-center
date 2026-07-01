# 🔄 SESSION HANDOFF — читать ПЕРВЫМ при продолжении на любой машине

> **Как пользоваться:** на новой машине скажи Claude: *«прочитай вики и найди
> SESSION-HANDOFF»*. Здесь — что мы делали, где остановились, и план. Обновляется
> в конце каждой сессии.
>
> **Последнее обновление:** 2026-06-30 (MacBook-Claude) — **настоящий калькулятор цены**
> (себестоимость + кулер/лёд/коробка + комиссии → маржа/маркап, переиспользует economics-модуль),
> **превью атрибутов из донора** (было пусто до промоушена), **все фото донора** (искали не в той
> таблице → DonorProduct). Own-brand драфты Uncrustables (5 шт) исправлены на месте + перегенерены —
> теперь бренд в тайтле, без дисклеймера, без Salutem. Всё в проде (`ece5099`), badge → v2.3.
> _(Предыдущее: 2026-06-30 own-brand режим `6ea7e24` + первое full-fidelity превью `fdd6fbe` → v2.2.)_
> _(Предыдущее: 2026-06-24 — Walmart Compliance/T&S removals read-инструмент `f5c9019`; 2026-06-21 — Financial Plan `/finance` + авто-захват чеков `33e7d23`; блоки ниже.)_

---

## 🆕 СЕССИЯ 2026-06-30 (продолжение) — Own-brand режим (Uncrustables) + full-fidelity превью

**ИТОГ:** две задачи сделаны и в проде. Bundle Factory badge → **v2.2**.

**1) Own-brand passthrough (исключение Uncrustables/Smucker's)** — коммит `6ea7e24`.
Владелец: для брендов-исключений НЕ делаем gift-set. Листим под ИХ собственным брендом, чужой бренд
в тайтле разрешён ТОЛЬКО когда в атрибуте `brand` стоит их бренд (а не Salutem Vita). Реализация:
- `src/lib/bundle-factory/own-brand.ts` — крошечный проверенный allowlist (`Smucker's/Smuckers/Uncrustables`),
  `isOwnBrandPassthrough()`, `resolveListingBrand()`. Режим выводится ЧИСТО из бренда листинга, без DB-флага.
- Проброшено: studio-engine (draft.brand = донор-бренд, draftName = имя товара без «…Gift Set»),
  content-generation (style-блок + user-msg ветвятся — бренд В тайтле, нет блока «no foreign brand»,
  нет дисклеймера, не «gift set»), compliance gate (own_brand из бренда; правила 1/2/3/4 ветвятся —
  донор-бренд ОК в тайтле + другие passthrough-термины типа «Uncrustables» рядом со «Smucker's», прочие
  чужие бренды всё ещё флагаются; донор-бренд валиден как brand field; дисклеймер пропускается),
  amazon-publish (атрибут `brand` = реальный бренд MasterBundle, был захардкожен «Salutem Vita»).
- 7 unit-тестов own-brand в `compliance/__tests__/rules.test.ts` (все 31 проходят). 15 неверных
  gift-set драфтов Uncrustables удалены из Turso. Память: `project_uncrustables_own_brand_exception`.
- ⚠️ TBD: штрих-код (матчить существующий ASIN vs новый UPC — сверить с живыми листингами перед первой
  own-brand публикацией). `item_type_keyword` пока «food-gifts» и для own-brand (валидный GROCERY-ключ,
  не блокирует, но семантически «подарок» — уточнить позже).

**2) Full-fidelity превью драфта** — коммит `fdd6fbe`. Владелец: в превью видно только 4 вещи, надо ВСЁ.
- Галерея фото: сгенерированное титульное = hero; фото из донора (`ResearchPool.reference_image_urls`
  по каждому компоненту + `draft_secondary_images`) = кликабельные превьюшки. Генерим ТОЛЬКО титул, остальное
  тянется из донор-базы. Показывает счётчик и происхождение фото.
- Цена кликабельна → `PricingModal` с формулой `price = max(floor, ceil(COGS × markup))`, живой разбор
  COGS/markup/floor; markup и floor редактируются и сохраняются через новый роут
  `GET/POST /api/bundle-factory/pricing` (глобальная модель, помечено явно).
- Полная таблица атрибутов: разворачивает Amazon-attribute JSON из ChannelSKU (Phase 2.1 filler —
  ingredients/allergens/number_of_items/nutrition…) + ship-specs (вес, Д×Ш×В), UPC, страна, browse node.
- Файлы: `drafts/[id]/page.tsx` (грузит donorPhotos + attributes + pricing), `DraftDetailClient.tsx`
  (галерея, PricingModal, buildPreviewAttributes), `api/bundle-factory/pricing/route.ts`.

**СЛЕДУЮЩЕЕ (для владельца):** живой прогон одного Uncrustables-драфта в own-brand режиме до Publish;
решить штрих-код; при желании — per-listing override цены (сейчас модель глобальная).

### Догон 2026-06-30 (по фидбеку владельца на превью) — коммит `ece5099`, badge v2.3

1. **Калькулятор цены (настоящий, как ChannelMax).** Было: наивно COGS×3. Стало: `computeBundlePrice()`
   в `pricing-config.ts` — товар + кулер/лёд/коробка (из economics `packaging.ts` по весу) + FBA/closing/
   наша доставка + Amazon referral (economics `fee-tables.ts`), решается под целевую МАРЖУ (дефолт 35%)
   или МАРКАП. Флор. Чистая функция, 8 юнит-тестов. promote-draft теперь цену ставит через неё
   (реальная цена = что в превью). Модалка переписана в 2 колонки (себестоимость слева, комиссии+цена+
   прибыль+маржа справа), тумблер маржа/маркап, живой пересчёт через `POST /api/bundle-factory/pricing/preview`,
   Save пишет глобальную модель (расширен `POST /api/bundle-factory/pricing`).
2. **Превью атрибутов** было пустым на GENERATED (ChannelSKU ещё нет). page.tsx теперь считает донор-
   атрибуты (ingredients→FDA аллергены, кол-во, нетто, хранение, страна) → видно ДО публикации; после
   промоушена клиент берёт реальные ChannelSKU.attributes.
3. **Все фото донора.** Показывалось 1, потому что page.tsx искал в ResearchPool, а studio-компоненты
   ссылаются на DonorProduct.id. Теперь грузим DonorProduct (`mainImageUrl` + `imageUrls[]`); studio-engine
   ещё и сохраняет все фото в `draft_secondary_images`. (Публикация доп. фото на Amazon — отдельный TODO.)
4. **5 неверных Uncrustables-драфтов** (сделаны ДО деплоя own-brand в 20:06, поэтому Salutem+giftset) —
   ПРИЧИНА подтверждена (тайминг, не баг). Исправлены на месте в Turso (brand→Uncrustables, имя→чистое)
   + перегенерён контент локально (tsx→prod Turso+Claude) → CAN_PUBLISH, бренд в тайтле, без дисклеймера,
   без Salutem. Прод-эндпоинты за авторизацией (401), поэтому гонял через локальный tsx.

**ЕЩЁ TODO:** публикация вторичных фото на Amazon (`other_product_image_locator`); штрих-код own-brand;
per-listing ценовой override.

---

## 🆕 СЕССИЯ 2026-06-27/30 — Bundle Factory: полная пересборка (✅ ФАЗЫ 0–6 ГОТОВЫ, в проде)

**ИТОГ:** все 6 фаз пересборки сделаны и задеплоены. Конец-в-конец: промпт → контент адаптирует данные
донора → полные атрибуты (GROCERY + ингредиенты/аллергены) → frozen-hero картинка (брендированный кулер,
по референсам, бесплатный воркер) → QA-офицер → публикация (frozen=только Amazon), билды достраиваются
кроном при уходе со страницы. Growth-модули частично на shared brand-voice. ОСТАЁТСЯ (опц.): живой тест
публикации владельцем; UI-кнопка QA-офицера; глубже завести Growth на QA-officer/registry; богаче стартовая форма.

**ЧТО ДЕЛАЛИ:** пересобирали Bundle Factory по согласованной с владельцем логике сборки карточки.
Канонический план: вики [bundle-factory-rebuild-plan.md](bundle-factory-rebuild-plan.md) (Фазы 0–6).
Общий фундамент: [listing-quality-stack.md](listing-quality-stack.md) (используется и Growth-модулями).
Картинки frozen: `docs/BUNDLE_FACTORY_FROZEN_MAIN_IMAGE_v1.0.md`. Решения — в memory `project_bundle_factory_vision`.

**КЛЮЧЕВЫЕ РЕШЕНИЯ (зафиксированы):**
- Контент — Claude АДАПТИРУЕТ данные донор-каталога (не выдумывает).
- Картинки — вторичные = реальные фото каталога; главная = frozen hero (брендированный кулер+гелевые
  пакеты+товар = это и есть товар лицом, главная картинка). Генерация = бесплатный Codex/GPT-подписка воркер.
  Эталоны: `ss-control-center/public/bundle-factory/frozen-refs/`.
- Атрибуты — полный набор из API маркетплейсов (Amazon 80–117/тип в `docs/marketplace-rules/amazon/_schemas/`).
- Товарная группа Amazon: по умолчанию GROCERY; корм → PET_FOOD (GIFT_BASKET у Amazon НЕ существует).
- Walmart НЕ принимает frozen/refrigerated → заморозка только Amazon.
- QA-офицер (Отд 5) проверяет каждый листинг по KB перед публикацией.

**ГДЕ ОСТАНОВИЛИСЬ (continue here):**
- ✅ Фаза 0 (фундамент): 0.1 реестр атрибутов (`src/lib/bundle-factory/attributes/`), 0.2 чистка KB
  (эмодзи-примеры + строка «эмодзи в bullets OK» в title-policy), 0.3 общий `src/lib/brand-voice/`
  (walmart/multipack переведён; Amazon Growth advisor — в Фазе 6).
- ✅ Фаза 1.1 — контент адаптирует РЕАЛЬНЫЕ данные донора: `content-pipeline.ts` тянет
  donor (title/bullets/description/ingredients/nutrition), `content-generation.ts` рендерит блок
  "MANUFACTURER REFERENCE DATA" → Claude адаптирует, не выдумывает.
- ✅ Фаза 2 (Amazon) — product type **GROCERY** (вместо несуществующего GIFT_BASKET), обязательные
  `item_type_keyword="food-gifts"` + `supplier_declared_dg_hz_regulation`, filler rich-атрибутов
  (ingredients/allergen_information/number_of_items из донора → ChannelSKU.attributes →
  merge в payload). Walmart-payload расширение — отложено (Walmart не берёт frozen).
- ✅ Фаза 3 РАЗБЛОКИРОВАНА (2026-06-27): воркер на боксе обновлён (`ops/codex-image-worker/server.js` —
  принимает `reference_images`/`reference_urls`, пишет их в run-dir, codex использует как input-референсы),
  задеплоен (scp на `root@104.219.53.204` = ssh-алиас `server`; README-алиас `openclaw` УСТАРЕЛ), nginx
  `client_max_body_size`→24m, перезапущен. **Живой тест PASSED:** референс Uncrustables-эталона → на выходе
  точная копия (брендированный кулер + реальные коробки + FROZEN GEL PACK). Бесплатный image_gen РЕАЛЬНО
  использует референсы. Токен воркера — только на боксе `/root/codex-image-worker/.env` + Vercel (НЕ в .env.local).
  ✅ Фаза 3 КОД ГОТОВ: `image-pipeline.buildImagePrompt` (frozen-hero для cold / clean для shelf-stable, реальная
  упаковка), передаёт референсы (донор-фото + R2-эталон `${R2_PUBLIC_URL}/prod/frozen-refs/anchor-*.png`),
  `image-generation` шлёт `reference_urls`, Rule 6/vision-check инвертированы (`allowedBrands` = бренды компонентов).
  6/6 prompt-тестов прошли. R2-креды РАБОЧИЕ (Vercel-managed; pull через `vercel env pull --environment=production`).
- (история блокера, решено) Фаза 3 была заблокирована на:
  (1) бесплатный GPT image-воркер (`codex-image-worker` на боксе 104.219.53.204) принимает только
  `{prompt,size}` — БЕЗ референс-картинок; чтобы передавать 2 эталона + фото товара (для совпадения с
  одобренными рендерами и точной чужой упаковки), нужна доработка ВОРКЕРА на боксе (вне этого репо).
  (2) текущий `image-pipeline.buildImagePrompt` + compliance **Rule 6** (vision) ЗАПРЕЩАЮТ брендированную
  упаковку; frozen-hero её ТРЕБУЕТ (Jimmy Dean + Salutem) → нужна связанная инверсия промпта + Rule 6
  (разрешить свои + бренды компонентов бандла, блокировать только неожиданные). Не тестируется без живого
  воркера/vision. Нужен владелец (бокс) + решение по подходу (reference vs AI-approx).
- ✅ Фаза 4 — Qualification Officer: `src/lib/bundle-factory/qualification/officer.ts` (`qualifyChannelSku`,
  pure-функция: completeness + brand-voice + покрытие required-атрибутов реестра + аллергены/ингредиенты)
  + `GET /api/bundle-factory/drafts/[id]/qualify` (advisory отчёт по всем ChannelSKU). Переиспользуем в Growth.
- ⏳ Остаются (без блокера): Фаза 5 — channel-gate (frozen→только Amazon; в distribution-pipeline:
  пропускать Walmart для FROZEN_GROCERY/REFRIGERATED по категории MasterBundle), богаче стартовая форма,
  resumability билда (серверный тик вместо браузерного). Фаза 6 — перевести Amazon/Walmart Growth на
  shared-модули (brand-voice уже общий; advisor ещё со своей копией; officer/registry — подключить).
- UI-wiring: кнопку «QA-офицер» на экране драфта (вызов /qualify) — не сделано, тонкий слой.
- ⚠️ Ранее в этой сессии уже починен сам pipeline (генерация→картинки→вес/габариты→validate→publish) + добавлены
  авто-цена, ship-specs, Amazon-превью, кликабельные драфты, публикация на NEEDS_REVIEW. См. memory `project_bundle_factory_pipeline_breaks`.

**ОТ ВЛАДЕЛЬЦА НУЖНО (позже):** живой тест публикации на Amazon в конце.

---

## 🆕 СЕССИЯ 2026-06-25 (iMac-Claude) — Картинки: платный OpenAI → БЕСПЛАТНЫЙ Codex (подписка ChatGPT)

**ГДЕ ОСТАНОВИЛИСЬ:** задача ЗАКРЫТА и на проде. Картинки листингов (Bundle Factory) и A+ Content
Factory теперь генерируются **бесплатно** через встроенный `image_gen` Codex CLI (gpt-image-2) на
лимитах подписки ChatGPT — **$0/картинка**. Платный OpenAI Images API убран полностью (вызова
`images.generate` в коде больше нет; `cost_cents` всегда 0). Расход OpenAI API по images = 0 структурно.

### Сделано и на проде (коммит `5660b09`, пушнуто, Vercel prod = Ready)
- **Архитектура:** Vercel `generateMainImage()` → POST `https://mcp.salutem.solutions/codex-image/generate`
  (nginx TLS + Bearer) → воркер на боксе (systemd `codex-image-worker`, 127.0.0.1:8791) → `codex exec`
  встроенный image_gen → PNG → Vercel грузит в R2. Codex нельзя запустить на Vercel (нужны `~/.codex` +
  сессия подписки) ⇒ воркер на always-on боксе OpenClaw (104.219.53.204), он уже был `codex login`-нут
  по подписке (auth_mode=chatgpt, без API-ключа).
- **Защита от платного пути:** воркер вырезает `OPENAI_API_KEY`/`CODEX_API_KEY` из окружения → платный
  фолбэк скилла (`scripts/image_gen.py`) физически не может сработать. (Сам `OPENAI_API_KEY` остаётся —
  он ещё нужен для ТЕКСТА: customer-hub, ai-vision. Убран только путь картинок.)
- **Код:** новый `src/lib/image-gen/codex-worker.ts` (HTTP-клиент + нормализация размера через `sharp`);
  `src/lib/bundle-factory/image-generation.ts` переписан (тот же интерфейс — pipeline и A+ не тронуты).
  Исходник воркера в репо: `ops/codex-image-worker/` (server.js + README со systemd-юнитом и nginx).
- **Env:** `CODEX_IMAGE_WORKER_URL` + `CODEX_IMAGE_WORKER_TOKEN` — в `.env.local` И в Vercel Production.
- **Проверки:** unit 8/8 ✅, `tsc --noEmit` 0 ошибок ✅, живой end-to-end через реальный код → R2 отдал
  валидный PNG 1024×1024, cost=0 ✅. Док: `docs/wiki/codex-image-generation.md`. Память: `project_codex_image_worker`.

### ▶️ ПРОДОЛЖИТЬ НА MacBook (сделай ПЕРВЫМ)
1. **`git pull`** — заберёт коммит `5660b09` (codex-worker, переписанный image-generation, ops/, вики).
2. **Секреты картинок НЕ в git** (`.env.local`). Если на MacBook их нет: `cd ss-control-center &&
   vercel env pull .env.local` (они уже в Vercel prod). Или с бокса: `ssh openclaw 'cat /root/codex-image-worker/.env'`.
3. **Проверить живьём:** `cd ss-control-center && npx tsx scripts/smoke-codex-image.ts` → ждём `PASS`
   (реальная генерация по подписке → R2). Если 502 — `ssh openclaw 'codex login status'` должен быть
   «Logged in using ChatGPT» (если нет — `codex login --device-auth`).
4. Ничего не висит: дерево чистое, dev-серверов нет.

### 🔜 ХВОСТЫ / опционально (не блокеры)
- **Скорость** ~30–90 сек/картинка (агент подписки) vs ~10 сек у старого API. Vercel image-роуты
  `maxDuration=300` + до 3 ретраев/канал → на мульти-канальном драфте можно подойти к потолку. Если упрёмся —
  уменьшить ретраи или вынести bulk-генерацию в async-джобу.
- **Размер фото:** валидатор хочет Amazon ≥2000²/Walmart ≥1500², а вызовы просят 1024²/1536×1024 (так было
  и со старым API — pre-existing). Закрыть = поднять `size` у вызовов (подписка + sharp потянут больше).
- A+ UI имеет дропдаун модели — теперь no-op (подписка сама берёт gpt-image-2); можно убрать из UI позже.

---

## 🆕 СЕССИЯ 2026-06-24 — Walmart Compliance / T&S removals (read-инструмент)

**ЗАДАЧА (Владимир):** достать через API полный машиночитаемый список SKU, которые Walmart снял
за нарушения (Health & Compliance → «Item compliance», Trust & Safety «Download Reports») — не руками из UI.

**РЕЗУЛЬТАТ:** инструмент `walmart_compliance_removals` готов, на проде, запушен.

### Главная находка (для другого Клода — не трать время заново)
Правильный эндпоинт — **обычный Items API на простом OAuth**, НЕ Insights и НЕ Reports:
```
GET /v3/items?publishedStatus=UNPUBLISHED&limit=200&offset=N   (offset-пагинация, дедуп по sku+wpid)
```
Причина снятия в `unpublishedReasons.reason[]`. **T&S-снятие = дословно**
«Your item has been flagged by our internal team. To find out why, file a case in Case Management.»
Это ≠ END_DATE («End Date has passed») и ≠ PRICE_RULE («violates … Pricing Rule»). Классифицируем по тексту.

**Что НЕ подошло (проверено живьём на store 1 / seller 10001624309):**
- Insights `/v3/insights/items/unpublished/counts` → 200, но T&S не считает (только END_DATE + price).
- Insights `/v3/insights/items/unpublished/items` → **403** "Auth header required for this consumer"
  (нужен `WM_CONSUMER.CHANNEL.TYPE` зарегистрированного Solution Provider — у нас нет). POST → 404.
- Reports `reportType=ITEM` → нет колонки причины снятия.

### Сделано и на проде
- `src/lib/walmart/compliance-removals.ts` — `getComplianceRemovals()` (пагинатор + классификатор)
- `src/app/api/walmart/compliance-removals/route.ts` — **`GET /api/walmart/compliance-removals`**
  (JSON; `?format=csv`; `?includeAll=1`; `?storeIndex=1` = STARFITSTORE)
- `scripts/diag-walmart-unpublished{,4}.ts` — пробы, задокументировавшие находку
- Полная док: `ss-control-center/docs/wiki/walmart-compliance-removals.md`

**Замер на 2026-06-24:** 572 unpublished → **42 уникальных T&S-снятия**, 434 price-rule, 96 end-date.

### 🔜 СЛЕДУЮЩЕЕ (если Владимир захочет развить)
1. Среди 42 T&S много старых промо-названий (Дима/ChatGPT: "Tasty Selection", "Delicious",
   "Comfort Classics") = паттерн, триггерящий compliance (история 99300 в CLAUDE.md).
   **Прогнать эти SKU через Smart Scrub** (Phase 2.6.1) — список теперь в один GET.
2. UI-страница/виджет в SSCC поверх эндпоинта (пока только API + CSV).
3. Опционально: ночной cron + Telegram-алерт на новые T&S-снятия.

> ⚠️ В коммит вики `e694898` авто-save репозитория заодно подхватил несвязанные shipping-правки
> (`veeqo/client.ts`, `shipping/plan/route.ts`) — это НЕ часть этой задачи, но они были в рабочем дереве.

---

## 🆕 СЕССИЯ 2026-06-21 — Financial Plan (Фонды), авто-захват чеков

**ГДЕ ОСТАНОВИЛИСЬ:** протестировали авто-захват чеков из Gmail (7 магазинов) — занеслись
в Restock reserve, тест прошёл, тестовые данные удалены (фонд = $11,125.11).

### Сделано и на проде
- **Баланс по трате** = Accrued (тикает) − Paid = **Balance** (переходит из ФП в ФП); суммы
  **округлены вверх до $5**. Зарплаты — только табелем (день=+ставка), кнопки Paid/Undo.
- **Распределение** (Income): живой пересчёт при смене Reserve%/My%; **Needed = долг периода +
  покрытие отрицательного баланса фонда**; **Auto-set** My%=Needed/distributable; Commit блок при >100%.
- **Резерв = COGS + упаковка** (БЕЗ шиппинга — netted из payout). Стоит **50%** (формула Uncrustables:
  60%→51%, 70%→47%; уточнить по реальным COGS).
- Перевод фонд→фонд; редактируемый журнал; **Undo** оплаты; Get Report фикс (окно 35д, кап 88);
  перф-фикс (начисление только в daily cron, GET'ы read-only).
- **Авто-захват**: `POST /api/finance/receipts {action:"ingest"}` → бизнес-закуп списывает из
  **Restock reserve**, рефанд = кредит, home = без денег, unknown = review. Дедуп channel+order_id.
  Lib `src/lib/finance/ingest-receipt.ts`. Спец Джеки: senders→inbox + business/home правила.

### 🔜 ЗАВТРА (по приоритету)
1. **Автоматизировать ежедневный заход** авто-захвата, **с June 22 вперёд**: OpenClaw читает Gmail
   по расписанию → POST в endpoint (endpoint готов), ИЛИ cron + server Gmail OAuth.
2. **Walmart Business — письмо link-only** (нет суммы/товаров) → **OpenClaw браузер** открывает
   заказ за логином, считывает итог. Тестовый $94.15 ВЕРИФИЦИРОВАТЬ.
3. **Amazon класс**: склад = «1162 Kapp Dr, Clearwater FL 33765»; в письме часто только город → review.
4. **Кнопка «Закрыть период ФП»** (как QuickBooks — зафиксировать неделю). Не сделана.
5. **Instacart** шлёт на marketing@salutem.solutions (не kuzy.vladimir@) → читать через OpenClaw.

### ▶️ ПРОДОЛЖИТЬ НА MacBook (сделай ПЕРВЫМ)
1. **`git pull`** — заберёт весь финансовый модуль (последний коммит `33e7d23`, всё на проде).
2. **`cd ss-control-center && npx prisma generate`** — финансовые коммиты добавили ПОЛЯ в схему
   (`expenseId` в ledger; `channel/orderId/classification/sourceInbox/emailId` + расширенный `status`
   в receipt). **Папки миграции НЕТ** — поля залиты прямо в Turso через `db push`. Runtime DB —
   **общий Turso** (твой локальный `.env.local` смотрит в ту же базу), поэтому `db push` повторять НЕ
   надо; нужен ТОЛЬКО `prisma generate`, иначе TS-типы клиента не увидят новые поля и сборка упадёт.
3. **Секреты НЕ в git** (`.env.local` gitignored). Если на MacBook их нет — `cd ss-control-center &&
   vercel env pull .env.local` подтянет из Vercel (Turso/Amazon/Google и т.д.).
4. Ничего в работе не «висит»: рабочее дерево чистое, dev-серверов не запущено. Бери задачи из «🔜 ЗАВТРА».

Полная док модуля: [Finance Core — Funds](finance-funds.md).

---

> **(история ниже)** **Последнее обновление:** 2026-06-12 (Claude — спланирована **Walmart Quantity-Confusion Fix**: диагноз
> возвратов + проверка политики Walmart по фото + утверждённый 3-слойный план, код ещё НЕ написан. См. блок
> «🆕 СЕССИЯ 2026-06-12 (Quantity-Confusion Fix)» ниже + `walmart-quantity-confusion-fix.md`. Это ОТДЕЛЬНАЯ
> ветка от COGS). Ранее в тот же день: iMac-Claude — **BlueCart ОПЛАЧЕН**, пилот 20 Walmart-SKU, first-party
> гейт (#8); осталось Unwrangle/Oxylabs/вариации/чистка → один полный прогон.
> Главная **незаконченная** задача — **COGS / Product Sourcing Engine** (см. «ПРОДОЛЖИТЬ ОТСЮДА»).
>
> **2026-06-12 (вечер, MacBook-Claude) — ✅ FROZEN RATE BUG РЕШЁН + переписан на Master Prompt v3.5.**
> Найден **настоящий левер даты**: новый `POST /shipping/api/v1/rates` + `preferred_shipment_date`
> (старый `GET /shipping/rates` дату не принимал — отсюда «враньё» Monday-shift). Подтверждено живьём:
> EDD совпадают со скриншотами веб-Veeqo Владимира. См. [veeqo-rate-shopping-api.md](veeqo-rate-shopping-api.md)
> и [MASTER_PROMPT_v3.5.md](../MASTER_PROMPT_v3.5.md). **Frozen-логика упрощена Владимиром до 2 условий**
> (EDD ≤ дедлайн · окно ≤2/3д) + $3-абсолют за скорость + Monday-трюк берётся только при >15% экономии.
> Код: `getRatesForShipDate` в veeqo/client.ts, переписан `selectBestRate` + Monday-трюк в plan/route.ts
> (без PUT-плясок), buy/route.ts матчит сервис регистронезависимо. **✅ ПРОТЕСТИРОВАНО БОЕМ 2026-06-12:
> Владимир купил bulk 12/12 этикеток, 12/12 PDF в Drive, 0 ошибок** (напр. 113-3947294 → FedEx 2Day
> One Rate $17.78 — дешёвый понедельничный). Дополнительно зафиксировано в ту же сессию:
> (1) модалка ручного выбора (`/api/shipping/rates`) тоже переведена на новый API (date re-quote);
> (2) именованные коробки XL/L/M/S/XS резолвятся через `resolveBoxDimensions` в plan+buy (раньше сырой
> регекс срывался на «XL» → рейт по стейловому пакету, фантомный $17.78 One Rate);
> (3) buy-guard больше не требует `remoteShipmentId` (новый API его не отдаёт — он перезапрашивается);
> (4) Monday-правило финал: дешевле всего; понедельник если быстрее (+$3) ИЛИ >15% дешевле — лишний день
> в пути ВНУТРИ окна еду не портит, поэтому большая экономия бьёт «медленнее на 1 день» (заказ 112-8268143:
> Mon FedEx 2Day $17.78 вместо Next Day Sat $82.73). Полная логика — `MASTER_PROMPT_v3.5.md`.

## 🚢 SHIPPING LABELS — сессия 2026-06-12 (MacBook-Claude) — ЧИТАТЬ, отдельно от COGS

**Зашипано и в проде** (ветка main, деплой Vercel):
- `173265d` Frozen-движок: всегда сравнивать «отгрузка сегодня vs понедельник», брать самый дешёвый валидный рейт.
- `e253742` пересчёт рейта при смене даты отгрузки (карточка + модалка выбора рейта) + дата в модалке.
- `2faeb3a` аудит-оптимизации (параллельный дашборд: Promise.all двух фаз + скользящее окно проб; `select sku`;
  убран двойной фетч в discard; мемоизация счётчиков; удалён мёртвый код: `getAllocation`, `getSwwCarriers`,
  `handlePresetChange`, недостижимый guard; убран отладочный шум dymo + per-buy VAS-дамп). **+ баг Владимира:**
  правка веса/размера теперь пересчитывает ТОЛЬКО изменённый заказ (был полный `load()`).
- `8033c96` holiday-safe «следующий понедельник» (`nextMondayFrom` везде, удалён дубль `getNextMonday`) +
  фикс переполнения товара в модалке результата покупки (wrap вместо nowrap).

**🔴 КРИТИЧЕСКАЯ НЕЗАКРЫТАЯ ПРОБЛЕМА — пересчёт рейта по дате отгрузки сломан в корне.**
Я вживую (через API, на реальных заказах) доказал:
- **EDD рейтов в Veeqo привязаны к дате отгрузки ЗАКАЗА** (для Amazon = маркетплейс-дедлайн `order.dispatch_date`).
  Доказательство: заказ `113-3043309` (Veeqo id 1815750501) — его `order.dispatch_date`/`preferred_shipment_date`
  естественно = Mon 6/15, и API отдаёт ровно «понедельничные» EDD, совпадающие с веб-Veeqo Владимира (скрин).
- **НО для Amazon-заказа эту дату через публичный API НЕ сдвинуть:** `order.dispatch_date` immutable (PUT → 200,
  но значение НЕ меняется — read-only, синкается из Amazon); `preferred_shipment_date` зажимается до неё;
  `allocation.dispatch_date` пишется, но на EDD НЕ влияет; перетолчка упаковки НЕ влияет; query/POST-параметры даты
  НЕ работают (POST-эндпоинты 404). **То есть `updateOrderDispatchDate` (что делает наш код) — НО-ОП для рейтов.**
- Поэтому Monday-shift: PUT даты (ноль эффекта) → re-quote отдаёт СЕГОДНЯШНИЕ EDD → `selectBestRate` считает
  calDays от понедельника → **мусор**. Пример (скрин Владимира, заказ `112-6530340`): карточка «USPS Cubic EDD 6/18
  · 3 дня · Physical 6/15», но 6/18 — это срок ЕСЛИ ОТПРАВИТЬ СЕГОДНЯ; из понедельника USPS придёт ~6/21. **Это
  пищевой риск** (можно купить рейт, который привезёт размороженным). НАДО как минимум обезвредить.
- Mechanism git-archeology: `updateOrderDispatchDate` всегда (с `9a16e48`) писал `order.dispatch_date` — НЕ менялся.
  Значит мои правки этот рычаг не ломали; он, видимо, никогда корректно и не работал (выглядел рабочим: ставил
  Physical Mon + выбирал дешёвый рейт по неверным EDD).

**Позиция Владимира (НЕ игнорировать):** в веб-Veeqo (app.veeqo.com) смена даты ДЕЙСТВИТЕЛЬНО пересчитывает EDD
и иногда цену — он прислал 2 скрина одного заказа (Today vs Mon Jun 15, EDD разные). И он УВЕРЕН, что в НАШЕМ
приложении это работало ~2 дня назад. Веб-UI явно умеет → рычаг существует, просто НЕ в публичном `GET
/shipping/rates`, который мы используем (вероятно приватный app-API / другой base/версия / GraphQL).

**Трюк (как объяснил Владимир — это и есть цель):** ставим дату ПОНЕДЕЛЬНИКА → смотрим, какой рейт реально
успевает ИЗ ПОНЕДЕЛЬНИКА в окно свежести + дедлайн → возвращаем дату на сегодня → покупаем лейбу СЕГОДНЯ (Amazon
думает, что отгрузили сегодня), а физически отгружаем в понедельник.

**Решение Владимиром НЕ выбрано.** Я предложил: (А) проекция — сами считаем понедельничные EDD из времени в пути
(Veeqo даёт `expected_delivery_days` + сегодняшний EDD), консервативно (округлять в позднюю сторону → никогда не
выберем рейт, привозящий позже окна); (Б) поймать сетевой запрос веб-Veeqo и повторить (точные цифры, но приватный
API — хрупко). Владимир оба раза отверг проекцию словами «работало 2 дня назад, смотри лучше».

**➡️ РЕКОМЕНДУЕМЫЕ ШАГИ для следующей сессии (ранжировано):**
1. **Поймать реальный запрос веб-Veeqo** (самый результативный). Попросить Владимира: открыть заказ в app.veeqo.com,
   DevTools → Network → фильтр `rate` → сменить Ship Date → прислать URL+метод+тело появившегося запроса. Это даст
   ТОЧНЫЙ эндпоинт, который котирует по дате (наш `GET /shipping/rates/{allocId}?from_allocation_package=true` —
   НЕ он). Возможно другой base (`api.veeqo.com/v2`?) или GraphQL.
2. **Обезвредить враньё СРАЗУ (пищевой риск):** пока нет реального рычага — Monday-shift не должен показывать
   фейковые понедельничные EDD. Либо отключить re-quote (котировать честно «на сегодня», брать лучший сегодняшний
   рейт), либо гейтить трюк. Сейчас он активно вводит в заблуждение.
3. **Фоллбэк — проекция** (если веб-запрос не дастся): бизнес-дни транзита, консервативно. Безопасно для еды.

**Тронутые заказы при тестах:** `112-5404197-4181866` (Veeqo id 1814769261, alloc 1312570818) — его
`allocation.preferred_shipment_date` дрейфнул 6/11→6/12 (клампинг Veeqo, безвредно; `order.dispatch_date` НЕ тронут).
`113-3043309` — только ЧИТАЛ. Диагностические скрипты удалены (не коммитились).

## ▶️▶️ ПРОДОЛЖИТЬ ОТСЮДА (2026-06-12, для MacBook-Claude) — что делать дальше
> 🔁 **КУРС (Владимир):** Джеки НЕ в рантайме — движок зовёт API сам (`src/lib/sourcing/retail-fetch.ts`). Джеки может
> координировать, но платит ТОЛЬКО по прямому слову Владимира в его Telegram (релей/файлы не принимает) ⇒ **Владимир
> оплачивает сервисы САМ** на дашбордах (аккаунт `info@salutem.solutions`).
> 🎯 **РЕШЕНИЕ Владимира:** прогнать все 506 Walmart-SKU ОДИН раз и СРАЗУ на всех ритейлерах (не Walmart-only дважды).
> ⚠️ **Ключи/пароли НЕ в git.** API-ключи — `.env.local` (gitignored): забери с бокса (см. «ВОСПРОИЗВЕСТИ»). Логины
> сервисов — на боксе `/root/.config/sourcing-accounts/*.json` (ssh `openclaw`).

Очередь:
1. **[Владимир, В ПРОЦЕССЕ]** Оплатить **Unwrangle** (pay-as-you-go). Код под неё ГОТОВ → как пополнит, добавляются
   Target+Sam's+Costco. ⚠️ Проверь живьём: `unwrangleSearch("target", "...")` — если `credits_remaining>0`, оплачено.
2. **[без оплаты]** Дописать **Oxylabs-фетчер** (BJ's/Publix через Instacart) в `retail-fetch.ts` — сейчас его НЕТ
   (только BlueCart+Unwrangle). После кода Владимир оплатит Oxylabs (dashboard.oxylabs.io) → тест.
3. **[без оплаты]** **Вариации по компонентам**: Green Giant 8-can (`RizwanX-4608`) движок уже метит `is_bundle=true`
   + 4 компонента — добавить в `cogs-enrich-pilot.ts` прайсинг каждого компонента → Σ = COGS набора (замечание #4).
4. **[без оплаты]** Почистить `SkuCost`: все `source='retail:websearch'` (10 шт — LLM-выдуманные цены, Джеки пометил
   как фейк: Chef Boyardee «$0.58» = ложный сниппет) + битый `RizwanX-3877` La Abuela $0.265.
5. **[после пп.1-3]** ПОЛНЫЙ ПРОГОН 506 СРАЗУ на 4-5 ритейлерах: `cogs-identify-walmart.ts` → `cogs-enrich-pilot.ts`
   (БЕЗ `--no-unwrangle`). 1P-фильтр уже включён. Потом → переделать COGS-вкладку (#11) + сверка.
6. **[✅ СДЕЛАНО]** Репрайсер margin floor. **[ЗАБЛОКИРОВАНО]** /analytics прибыль (AmazonOrder без line-items → SP-API getOrderItems).
⬇️ детали ниже: «СЕССИЯ 2026-06-11/12», «СЕССИЯ 2026-06-10 (вечер)», `cogs-sheet-review-2026-06-08.md`.

---

## 🆕 СЕССИЯ 2026-06-12 (Quantity-Confusion Fix) — ДВИЖОК РЕАЛИЗОВАН ✅, визуально утверждён
**Обновление по ходу сессии:** движок главного фото написан и принят Владимиром («Огонь!»). Вариант А
(детерминированный композитинг `sharp`) ПРИНЯТ; Вариант Б (GPT Image) ОТКЛОНЁН (коверкает текст этикеток,
не считает копии, $/шт). `src/lib/walmart/multipack/composite.ts`: **smart cutout** (flood-fill белого фона +
keep-largest-component → отсекает вшитые плашки типа «5g protein» у Bush's), **чистая сетка 2 ряда**
(4=2+2/6=3+3/7=4+3/8=2×4, без нахлёста, зазор H+V, ~95%), **highResImageUrl()** (срез thumbnail-параметров
Walmart CDN → 2200px+). Контент — `content.ts`. Пилот `scripts/diag-walmart-multipack-fixer.ts`
(dry-run → `preview-multipack/`, НЕ публикует). Прогнан на 6+ разных товарах. Визуал-предпочтения Владимира:
≥2 ряда для n≥4, виден зазор, БЕЗ тени, ~95%. **Осталось до каталога:** (1) отбор чистого hero-фото (часть
`RetailPrice.imageUrls` — мультипаки/миниатюры/композиты), (2) заливка на Walmart через `submitToWalmart()`
(бейдж-фото #2 в `productSecondaryImageURL[]`). Детали — `docs/wiki/walmart-quantity-confusion-fix.md`.

### (исходный план задачи, для контекста)
**ОТДЕЛЬНАЯ задача от COGS.** Владимир вычислил крупную причину возвратов на Walmart: **quantity
confusion**. Главное фото = копия штучного снимка Walmart (1 пачка), клиент ставит quantity 3 думая
«3 пачки», но `quantity 1 = весь набор N`, получает 3×N → возврат. Нигде нет формулы «1 заказ = N пачек».

**Проверил политику Walmart по фото (официальный Marketplace Learn, 2026-06-12):** на ГЛАВНОМ фото
бейджи/текст/оверлеи ЗАПРЕЩЕНЫ (продукт на белом RGB 255,255,255; нарушение → unpublished + удар по
Polaris-completeness 40%). На ДОПОЛНИТЕЛЬНЫХ фото (#2–10) текст/инфографика РАЗРЕШЕНЫ.

**Утверждённый 3-слойный фикс (всё compliant):**
1. **Главное фото** → авто-композиция: из ОДНОГО фото пачки программно тайлим N копий на белом фоне
   (без текста — честно показан объём). *Владимир выбрал авто-композицию, не поиск официальных multipack-фото.*
2. **Фото #2** → яркий инфографик-бейдж `N PACKS INCLUDED` + `1 order = N packages, not 1`.
3. **Title+bullets** → формула: `N-Pack (N packages per order)` + bullet `Each order contains N packages.
   Quantity 1 ships all N.` (brand voice: без promo-прилагательных/emoji).

**ПРОЦЕСС (установил Владимир):** дизайн бейджа + макет главного фото → пилот на **2 листингах** →
он смотрит визуально картинки И тексты → **только после апрува** весь каталог. НЕ массово до sign-off.

**Следующий шаг (MacBook-Claude):** читать `docs/wiki/walmart-quantity-confusion-fix.md` (полный план +
точные пути в коде + источники pack count). Кратко: добавить `sharp` (нет в package.json) →
`src/lib/walmart/multipack/composite.ts` (тайл + бейдж, заливка R2) + `content.ts` (rewrite) →
`scripts/diag-walmart-multipack-fixer.ts` (пилот 2 SKU, dry-run, превью БЕЗ публикации). Pack count из
`SkuShippingData.unitsInListing`/`SkuCost.packSize`. Публикация — `submitToWalmart()` (`MP_ITEM_4.7`,
сейчас шлёт пустой `productSecondaryImageURL[]` — туда зайдёт бейдж). Открытые вопросы: выбрать 2 пилотных
SKU (по числу возвратов), дизайн бейджа, проверить что MP_ITEM апдейтит фото без пересоздания листинга.

---

## 🆕 СЕССИЯ 2026-06-11/12 (iMac-Claude) — BlueCart ОПЛАЧЕН, пилот 20 SKU, first-party фикс
**Главное:** Владимир сам оплатил **BlueCart** (НЕ Джеки — мост подтвердил, что Джеки прямой авторизации не получал и
ничего не тратил). Живой тест: `credits_remaining=9999`, Walmart 1P работает. Unwrangle/Oxylabs пока триал/0 — Владимир
оплачивает Unwrangle сам; Oxylabs ждёт кода. **Курс:** один полный прогон сразу на всех ритейлерах (не Walmart-only).

**Сделано:**
1. **First-party гейт (#8)** — `isFirstParty()` в `retail-fetch.ts`: оффер принимаем ТОЛЬКО если `is_marketplace_item=false`
   (или продавец = сам ритейлер); реселлеры (PickAPrime/Sara Vita Labs/APIX) — reject. Коммит `5f55ed9`.
2. **Пилот 20 реальных Walmart-SKU** на ОПЛАЧЕННОМ BlueCart: **12/20 чистых Walmart 1P COGS** (BODYARMOR $1.00,
   Contadina $1.06, Campbell's $1.34, Rotel/Bush's $1.48, Snyder's $1.64, Progresso $2.58, Skippy $2.98, Klass $3.00,
   La Banderita $3.98, Barilla $5.48, Nature's Own Keto $6.64). Все sold_by Walmart.com. → RetailPrice+SkuCost (Turso).
3. **8/20 без Walmart 1P** — хлеб (Pepperidge ×3, Sara Lee), нишевое (Chef Woo рамен), вариация Green Giant 8-can: на
   Walmart.com их продают ТОЛЬКО реселлеры/мы. ⇒ им нужны другие ритейлеры (= конкретное «зачем» Unwrangle/Oxylabs).
4. **Репрайсер margin floor** (закоммичено `9ee02cb` ранее в эту же сессию) — см. блок ниже.
5. **Мост с Джеки работает**: ssh `openclaw` + `ask_openclaw` + файлы. Джеки ответил вживую (подтвердил $0 потрачено).

**BlueCart кредиты:** 9999 → 9959 (40 на 2 прогона пилота; на весь каталог 506 хватит с огромным запасом).
**НЕ начато (очередь пп.2-4):** Oxylabs-код, вариации-компоненты, чистка websearch-мусора, затем полный прогон (п.5).

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
