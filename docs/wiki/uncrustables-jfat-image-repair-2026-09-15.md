# SZ-ASPI-JFAT / B0H776M5B5 — ремонт картинок по frozen v2.0 (2026-09-15)

> Связано: [[uncrustables-listing-rules-canon]], [[HANDOFF-uncrustables-batch200-2026-08-13]],
> `docs/BUNDLE_FACTORY_FROZEN_MAIN_IMAGE_v2.0.md`.

## Что было
- Листинг: Uncrustables Blackberry Boom (PB & Blackberry), 6 коробок × 4 = 24, $76.99.
  Создан июльским забегом «Uncrustables 164» (BF-Images чат, 1–8 июля); после
  UPC-коллизии ASIN сменился B0H75VN18Z → B0H776M5B5.
- Amazon: issue **18320** «main image missing or incorrect», листинг подавлен;
  `summaries.mainImage` пустой. Наша июльская MAIN показывала **4 коробки** при
  рецепте 6 — нарушение канона «коробки × printed count = qty» (была в очереди
  «выдуманный товар» с 20.07, до перегенерации не дошла). Галерея — 1 слот.

## Что сделано
Скрипт `ss-control-center/scripts/_jfat_rebuild.ts` (STEP=plan|render|gallery|patch,
состояние `data/jfat-rebuild/state.json`):
1. `planStudioRecipe` + `buildStudioCandidatePrompt` — якорь кулера + референс
   коробки Blackberry Boom 4ct (Target), 2 ряда 4+2.
2. Рендер GPT Image 2 через Codex-воркер (213 с) → frozen QA (3 голоса) —
   **PASS с 1-й попытки**: 6 коробок, бейдж 4, 4 гель-пака, белый фон.
   MAIN: `prod/jfat-sz-aspi-jfat-1789505744751/main.png` (R2).
3. Галерея: 6 донорских фото → `sec/SZ-ASPI-JFAT/1..6.jpg`. Исключено фото
   «A flavor for every week day» (показывает чужие вкусы — выдуманный состав).
   Слот 1 = brand card (cold-chain), слоты 2–7 донорские.
4. **Surgical PATCH только image-locator'ов** (VALIDATION_PREVIEW → PATCH
   ACCEPTED, submission `1934877deb3940caa6559ed31612cc0d`). PUT не делали —
   оффер/цена нетронуты (проверено: $76.99 B2C, $76.22 B2B).
5. БД: `ChannelSKU.main_image_url`/`attributes`, `MasterBundle` обновлены.

## Открыто
- Issue 18320 на момент патча ещё висит — Amazon пересматривает MAIN не сразу.
  Проверить через сутки: `npx tsx scripts/_probe_jfat3.ts` (ожидание: issues=[],
  `mainImage` заполнен). Если 18320 останется при корректной картинке —
  это уже ручной кейс в Seller Central (Fix image → appeal).
- Заметка по скрипту: preview-режим PATCH возвращает статус `VALID`, не
  `ACCEPTED`.
