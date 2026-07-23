# Uncrustables Studio — план вшивания конвейера в Bundle Factory

Дата: 2026-07-23. Статус: **дизайн утверждён к реализации после пробного забега**
(owner mandate 2026-07-23: пробный забег + вшивание в BF параллельно). Дизайн
подготовлен Plan-агентом по итогам разведки реального кода; выжимка ниже —
канонический référence для реализации.

## Архитектурные решения

1. **Новый параллельный модуль, не расширение prompt-studio.** Секция
   `/bundle-factory/uncrustables` + API `/api/bundle-factory/uncrustables/*`.
   НОЛЬ правок Codex-lane файлов (`studio-engine.ts`, `studio-channel-routing.ts`,
   `api/.../studio/generate/route.ts`, `new/page.tsx`). Копия листинга —
   детерминированная из `buildListingCopy()` box-planner-а, без LLM.
2. **Render before draft.** Кандидаты живут в новой таблице
   `UncrustablesStudioCandidate`; GenerationJob/BundleDraft/GeneratedContent/
   ChannelSKU создаются ТОЛЬКО после human APPROVE gate.
3. **Submit через существующую blast-door цепочку приложения.**
   Находка разведки: `runDistribution()` в
   `src/lib/bundle-factory/distribution/distribution-pipeline.ts` УЖЕ делает всё,
   что делал submit-скрипт вручную: `preflightProductionUncrustablesMain` на
   own-brand SKU (строка ~471), permit map, `submitToAmazon` c
   VALIDATION_PREVIEW, lifecycle, poll путь (`pollSubmissionStatus`/
   `persistPollResult`) с сохранением ASIN. Шаг submit студии =
   `approveDraftForDistribution()` + `runDistribution({apply:true})`.
   `_publish_batch12_submit.ts` и `_verify_batch12_live.ts` портировать НЕ надо.
4. **Печати: union запечатанных манифестов; идентичная верификация всюду.**
   Статические repo-манифесты (v3, trial1, будущие экспорты) ∪ append-only
   DB-манифесты (`UncrustablesOwnerApprovalManifestRecord`); КАЖДЫЙ проходит
   полный набор проверок (schema/immutable/SHA-seal/registry binding/per-proof
   authenticity/кросс-манифестная уникальность proof_id+subject). Один битый
   манифест → throw → вся публикация закрыта. Пермит пиннится к sha именно
   того манифеста, который содержит его proof. (Статическая часть УЖЕ
   реализована в ходе забега — dual-manifest preflight, commit ce3016e7.)
5. **Tick-driven рендеринг** (как `tickBatch`): клиент поллит, один рендер на
   запрос, CAS-клейм кандидата, лимит попыток 8, `maxDuration=300`. Без cron
   в Phase A.

## Машина состояний кандидата

```
PLANNED → RENDER_QUEUED → RENDERING → RENDERED → (REJECTED → RENDER_QUEUED)*
        → APPROVED → STAGED → VALIDATED → PROOFED → SUBMITTED → LIVE
   любой этап → FAILED (last_error; ретрай упавшего шага оператором)
```

Human gates: **APPROVE** (шаг 3 — zoom 2048px, кропы по рядам, референс-арт
рядом, таблица ожидаемых коробок из рецепта, чек-лист из 11 пунктов минтера;
сервер пере-скачивает точные R2-байты и сверяет sha) и **SUBMIT** (шаг 6 —
сначала dry-run превью, потом явное подтверждение). Auto-publish отсутствует.

## Новые файлы (Amazon lane)

- Pages: `bundle-factory/uncrustables/page.tsx`, `new/page.tsx` +
  `PlannerClient.tsx` (пикер 15 вкусов, шаг qty = размер коробки, живые ошибки
  `validateRecipe`, band-метр, превью копии/цены, готовность донора/арта),
  `[runId]/page.tsx` + `RunBoardClient.tsx`, `[runId]/review/[candidateId]/` +
  `ReviewClient.tsx`; компоненты `ZoomableProof`, `CartonChecklist`, `BandMeter`.
- API: `runs` (create/list), `runs/[runId]` (board poll),
  `runs/[runId]/tick` (один рендер), `candidates/[id]/rerender|approve|reject|
  prepare|submit`. Live-check — существующий `skus/[id]/poll-status`.
- Lib (экстракции из скриптов, со golden-parity тестами):
  - `uncrustables-donor-resolver.ts` ← QUALIFIERS + donorFor() из `_trial_render.ts`;
  - `uncrustables-render-contract.ts` ← сборка контракта (REFERENCE MAPPING /
    ROW LAYOUT / FRUIT ART / GEL PACKS+TEXT / RETAILER FLAGS / SCENE / BRANDING /
    FRONT TEXT) — golden-тест на байт-идентичность промпта со скриптом;
  - `uncrustables-render-runner.ts` ← рендер + sha256/dims сразу после;
  - `uncrustables-official-ingredients.ts` ← INGREDIENTS/аллергены/UPC overrides
    из stage-1;
  - `uncrustables-ship-specs.ts` ← bandFor() (S 12×12×10/160oz, M 13×13×15/256oz,
    XL 24×13×16/544oz) — отдельно от рациональных диапазонов планировщика;
  - `uncrustables-stage.ts` ← stage-последовательность (job→draft→content→
    complianceGate→promote→specs/qty→`runValidationForDraft`);
  - `audit/uncrustables-owner-approval-minting.ts` ← постройка proof и
    манифеста той же sealing-библиотекой; reviewer = реальная сессия
    апрувера, реальные timestamps, реальный чек-лист;
  - `audit/uncrustables-owner-approval-manifests.ts` ← union-загрузчик.
- Опционально: `scripts/export-uncrustables-studio-approvals.ts` — консолидация
  DB-манифестов в repo-JSON (git-провенанс).

## Правки общих файлов (CHAT-SYNC флаги)

- `prisma/schema.prisma` — ТРИ новые модели в конец файла
  (`UncrustablesStudioRun`, `UncrustablesStudioCandidate`,
  `UncrustablesOwnerApprovalManifestRecord`, append-only). Миграция =
  **OWNER GATE** + окно через CHAT-SYNC (Walmart-лейн тоже мигрирует).
- `BundleFactorySubNav.tsx` — одна строка nav-ссылки (CHAT-SYNC).
- Blast-door правки Amazon-лейна: preflight union (частично уже сделано),
  `amazon-publish.ts` — verify пермита union-aware.

## Фазировка

- **Phase A (shippable, Mode A retail_boxes / AMAZON_SALUTEM):**
  A0 union-загрузчик+тесты (частично сделано) → A1 планировщик → A2 tick+board →
  A3 review gate → A4 prepare (stage→validate→mint; проверить прохождение
  `runValidationForDraft` на Uncrustables-драфте — скрипты Stage 6 обходили) →
  A5 submit+live через существующую инфраструктуру. Ship gate: один полный
  проход на новом рецепте с dry-run на ревью владельцу.
- **Phase B:** обобщение до brand-agnostic StudioCandidate + реестр
  scene-контрактов + gift-set планировщик (Mode B, Salutem Vita); sealed
  authenticity manifest остаётся own-brand-only; Walmart исключён (pilot lane).

## Риски

1. Stage-6 валидаторы × Uncrustables-драфты — непроверенная комбинация
   (скрипты обходили); фолбэк — проверенная прямая цепочка за теми же гейтами.
2. Тайминг рендера ~1-3 мин ↔ `maxDuration=300`, один рендер на tick.
3. DB-манифест слабее git-коммита по истории ревью — компенсация: append-only,
   полная переверификация на чтении, session-bound reviewer, экспорт-скрипт.
   Владелец должен явно принять trade-off (или выбрать queue+script фолбэк).
4. Расход UPCPool — показывать остаток пула на борде.
