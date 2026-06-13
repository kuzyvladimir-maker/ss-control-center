# ✅ ЧЕКПОИНТ: Shipping Frozen v3.5 — РАБОЧЕЕ СОСТОЯНИЕ (2026-06-12)

> **Зачем этот файл:** зафиксированная «золотая» точка, где Frozen shipping работал ПРАВИЛЬНО и
> проверен боем. Если позже что-то сломается при правках — сравнивай с этим состоянием / откатывайся.
>
> **Git-тег отката:** `shipping-frozen-v3.5-ok` (создан на коммите этого чекпоинта).
> Откат: `git checkout shipping-frozen-v3.5-ok -- ss-control-center/src/app/api/shipping/plan/route.ts ss-control-center/src/app/api/shipping/buy/route.ts ss-control-center/src/app/api/shipping/rates/route.ts ss-control-center/src/lib/veeqo/client.ts`
> (или весь репо: `git checkout shipping-frozen-v3.5-ok`).

## Доказательство, что работало
**Bulk-покупка 12/12 этикеток, 12/12 PDF в Google Drive, 0 ошибок** (Владимир, 2026-06-12). Рейты были
сверены с веб-Veeqo и одобрены. Пример: `113-3947294` → FedEx 2Day One Rate $17.78 (дешёвый понедельничный),
трекинг + PDF на Drive.

## Что включает это рабочее состояние

### 1. Настоящий левер даты — новый Rate Shopping API
- `getRatesForShipDate(order, preferredShipmentDate, parcel?)` в `src/lib/veeqo/client.ts`
  → `POST /shipping/api/v1/rates` с `preferred_shipment_date`. ЭТО двигает EDD по дате (старый
  `GET /shipping/rates` — нет). Нормализует поля нового API на старую форму.
- Подробности: `docs/wiki/veeqo-rate-shopping-api.md`.

### 2. Frozen-выбор рейта (Master Prompt v3.5 §5)
Рейт ГОДЕН ⟺ **оба**: `EDD ≤ дедлайн` И `calDays(EDD − деньОтгрузки) ≤ окно`. Окно = **3** дня,
или **2** при FrozenRiskAlert = high/critical. **Никаких** carrier-исключений, пятничных запретов, процентов.
Среди годных: **самый дешёвый**, но за более быстрый (меньше дней в пути) доплачиваем **до $3 (абсолют)**.

### 3. Трюк с понедельником (Master Prompt v3.5 §7)
Считаем лучший-на-сегодня и лучший-на-понедельник (оба через новый API, реальные EDD). Оба уже годны
⇒ оба безопасны. Берём понедельник, если:
- на сегодня нет годного, ИЛИ
- понедельник **быстрее** по транзиту И не дороже более чем на **$3**, ИЛИ
- понедельник **>15% дешевле** (даже если на 1 день дольше в пути — внутри окна еда не портится).
Иначе — сегодня. `labelDate` всегда = сегодня; физически отгружаем в выбранный день.

### 4. Габариты именованных коробок
plan + buy резолвят `boxSize` через `resolveBoxDimensions()` (`src/lib/shipping/box-presets.ts`),
который понимает И «LxWxH», И имена («XL» → 24×13×16). Без этого «XL» срывался → рейт по стейловому
allocation-пакету (был фантомный дешёвый FedEx One Rate).

### 5. Покупка (buy/route.ts)
- guard НЕ требует `remoteShipmentId` (новый API его не отдаёт — берётся свежим при ре-квоте на покупке).
- матч сервиса при покупке — регистронезависимо по `sub_carrier_id + title` (новый API: «Fedex», старый: «FedEx»).
- покупает свежий рейт (`freshRate`) со старого эндпоинта по выбранному сервису.

### Ключевые константы (в `plan/route.ts`)
- `FROZEN_SPEED_TOLERANCE_USD = 3` — доплата за день быстрее (абсолют).
- `MONDAY_SHIFT_MIN_SAVING_PCT = 0.15` — порог «существенно дешевле» для сдвига на понедельник.
- `frozenMaxCalDays(risk)` → 2 (high/critical) иначе 3.

### Файлы этого состояния
- `src/lib/veeqo/client.ts` — `getRatesForShipDate` + нормализация.
- `src/app/api/shipping/plan/route.ts` — `selectBestRate` (frozen) + Monday-трюк + парсел через resolveBoxDimensions.
- `src/app/api/shipping/buy/route.ts` — guard, матч сервиса, parseBoxSize→resolveBoxDimensions.
- `src/app/api/shipping/rates/route.ts` — модалка ручного выбора, date re-quote через новый API.
- `src/app/shipping/page.tsx` — плашка-объяснение Frozen-логики.
- `docs/MASTER_PROMPT_v3.5.md` — каноническая спека. `docs/wiki/veeqo-rate-shopping-api.md` — про API.

### Диагностика (read-only, для отладки «почему такой рейт»)
- `scripts/diag-explain-order.ts <ORDER#> [cap]` — bestToday vs bestMonday + решение.
- `scripts/diag-weight-check.ts <ORDER#> [lbs] [LxWxH]` — рейты по правильному vs стейловому весу.
- `scripts/diag-rate-shopping-v1.ts` — образец вызова нового API.
