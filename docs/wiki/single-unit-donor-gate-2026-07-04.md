# Single-unit donor gate + per-listing qualification agent (2026-07-04)

> **Инцидент:** движок мультипак-ремедиации тайлил **картинку-мультипак** (каддик
> «Cheez-It 12 Pack», кейс Gatorade из 8 бутылок, шринк-пак Mott's) N раз →
> визуально получалось «N упаковок по 12/6/8» вместо «N единиц». На листинге
> «pack 4» покупатель видел 4 упаковки по 12. Владимир поймал на галерее триала.
> Связано: [[walmart-ideal-listing-spec]], [[project_walmart_remediation_worker]],
> [[walmart-multipack-quantity-confusion]].

## Корень

Донор-селекция шла **двумя путями с разной строгостью**:
- Через **Google Images** картинка проходила `classifyProductPhoto`/`pickBestFront`,
  которые умеют отбраковывать «больше одной единицы».
- Через **Walmart 1P и Sam's/Target** брался сырой первый оффер
  (`offers[0].imageUrls[0]`) и проверялся только `frontMatchesListing` —
  идентичность бренда/типа/вкуса. Гейта «ровно одна единица» там **не было**.
  Поэтому оффер-каддик/кейс проходил как «донор» и тайлился.

`verifyMainImage` (финальный гейт) проверял фронт-vs-оборот/nutrition/lying, но
**не считал единицы** и не отличал «одна коробка» от «плашка из 12».

## Фикс — два fail-closed гейта (src/lib/sourcing/vision.ts)

1. **`qualifyDonorFront(url, listingTitle, unitSize?)`** — донор-гейт до тайла.
   Один Sonnet-вызов, вердикт по пунктам: `brand / type / variant / singleUnit /
   front / whiteBg`. `singleUnit=false`, если фото — кейс, каддик, шринк-пак, ряд/
   стопка 2+ единиц, ИЛИ пачка с печатным «12 PACK / 8 COUNT / CASE» (значит она
   сама бандл, а не единица из title). `pass` = все шесть true.
2. **`qualifyTiledMain(url, listingTitle, packCount)`** — агент квалификации
   готовой склейки: `identity / eachCellSingle / countOk / front / whiteBg`.
   `eachCellSingle=false`, если в ОДНОЙ плашке сидит мультипак. Ловит донора,
   проскочившего гейт 1. `pass` = все пять true.
3. **`unitSizeFromTitle(title)`** — вытаскивает размер ОДНОЙ единицы (не пака):
   «… 21 oz (Pack of 4)» → «21 oz». Первый size-токен, чтобы хинт был однозначным.

Оба гейта fail-closed: любая ошибка/неоднозначность → `pass:false` (do-no-harm).

## Порт в бой (src/lib/walmart/multipack/remediate.ts + resolve-donor.ts)

- **`tileVerifiedMain`** теперь: `qualifyDonorFront` (до тайла) + `qualifyTiledMain`
  (после) вместо слабого `verifyMainImage`. Опция `donorGated` — пропустить гейт 1,
  когда донор уже провалидирован резолвером.
- **`resolveDonorPhoto`** (новый общий модуль `src/lib/sourcing/resolve-donor.ts`) —
  ОДИН водопад для триала и боя: **T1 Walmart 1P → T2 Google Images → T3 Sam's/
  Target**, каждый кандидат через `qualifyDonorFront`. Добавляет боевому пайплайну
  **тир Google Images**, которого не было (из-за чего прод-покрытие отставало).
  Вызывается как фолбэк, когда локальный каталог (RetailPrice) не дал годного фронта.
- **keep-путь** теперь требует `qualifyTiledMain(curMain).pass`; переменная `keep`
  поднята наверх, чтобы rescue/deep/live-фолбэки её уважали (иначе пересобирали бы
  уже-годную картинку — churn).
- **`assessRemediation`** переписан: честный грейд по 6 блокам эталона
  (main-qualified + ≥4 фото + title ≤150 + description ≥700 + 3–10 буллетов +
  ≥3 атрибута) вместо ложного «есть mainImageUrl = A-to-Z». Scope-aware: scoped-ран
  (image-only) не штрафуется за не-собранный текст; `textOk` для image-only =
  image-produced (иначе canary завалил бы здоровый image-only ран).

## Валидация

- Донор-гейт на 8 помеченных SKU (Cheez-It Extra Cheesy ×4, Gatorade ×2, Mott's ×2):
  **8/8** — каддик/кейс/шринк отклонён, взята одиночная единица, `eachCellSingle=1`.
  Контроль 3/3 (Doritos single bag; Arnold bread через Google Images).
- Общий модуль `resolveDonorPhoto` из боевого кода: Cheez-It → Walmart 1P (каддик
  отклонён), Arnold Keto → Google Images. Обе склейки прошли `qualifyTiledMain`.
- Независимое состязательное ревью боевого диффа: verdict **commit-after-fixes**
  (docstring-mismatch + scope-aware грейд — оба применены). Подтверждено: canary-
  драйвер `buildAndSubmitMany` сейчас без вызывающих (воркер зовёт
  `buildAndSubmitOne` напрямую), scope-фикс сделан заранее, до его включения.

## Стоимость (важно для полного каталога)

Каждый гейт = 1 Sonnet-vision-вызов. `resolveDonorPhoto` добавляет Oxylabs-вызовы
(Walmart 1P + Google Images + Sam's + Target). На холодном кэше «трудный» SKU в
хвосте может стоить ~14 uncached vision-вызовов (Google Images slice). Перед полным
прогоном 2508 SKU нужен дневной лимит трат + опора на `ImageClassification` кэш.
Владимир принял «медленнее/дороже, но качественнее».
