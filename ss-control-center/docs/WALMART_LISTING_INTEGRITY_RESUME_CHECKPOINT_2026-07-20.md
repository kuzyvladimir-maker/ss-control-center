# Walmart Listing Integrity — resume checkpoint

Статус: `LOCAL SOURCE EXECUTOR + QA CONTRACT COMPLETE / REPAIR WRITER NO-GO`
Зафиксировано: `2026-07-20T02:58:57Z`

## Цель

Исправить Walmart-листинги так, чтобы фактический товар, вариант, размер,
состав и количество полностью совпадали с title, description, bullets,
атрибутами, MAIN и каждым gallery image; после каждого исправления подтвердить
buyer-facing результат и сохранение published/indexing.

## Принятый рабочий цикл

`найти ошибку → доказать её → составить точный repair plan → изменить один SKU
одним разрешённым write → дождаться Walmart → заново прочитать live PDP →
независимо проверить все поверхности → PASS либо остановка/перепланирование`.

Следующий SKU нельзя открывать до доказанного PASS текущего. Автоматический
повторный write при задержке propagation запрещён.

## Что завершено локально

- One-shot ITEM v6 executor теперь fail-closed и выполняет не более одного
  фиксированного POST после необратимого перехода authorization в `REQUESTING`.
- Frozen executor CLI и отдельный offline freezer созданы. Release связывает
  точные loaded bundle bytes, manifest bytes, runtime/build/argv, builtin imports,
  certification role→path closure и canonical capture root.
- Credential-derived transport account повторно сопоставляется с подписанным
  active account прямо перед OAuth/POST. Полный timeout + safety margin повторно
  проверяется на последнем pre-send gate.
- Consumption ledger содержит cumulative `.ledger-head.json`: exact inventory,
  previous-head SHA и атомарное продвижение для `CLAIMED → REQUESTING → terminal`.
  Удаление, усечение, лишний event и восстановление старого head приводят к
  fail-closed. Точная граница обещания записана в head:
  `at_most_once_scope=INTACT_SINGLE_CUSTODY_DIRECTORY`,
  `hostile_same_uid_resistance_claimed=false`,
  `distributed_at_most_once_claimed=false`.
- Финальный success не возвращается до повторного открытия и сверки всего
  семейства immutable session artifacts. Если этот reread находит изменение,
  создаётся `19-request-manual-review.json`, authorization остаётся consumed.
- Любая continuation phase (`poll`, `download`, `compile`) сначала проверяет
  request manual-review. Сочетание `COMPLETE + MANUAL_REVIEW` блокируется до
  любого GET и не может продолжить capture автоматически.
- Реальный замороженный bundle запущен локальным subprocess-тестом: loaded-code
  self-binding прошёл, после чего процесс штатно остановился на специально
  отсутствующем source-evidence artifact до credentials/network.

## Локальная сертификация

- Полный focused reissue/capture набор: `139/139 PASS`.
- Targeted ESLint: `0 errors`; после удаления одного неиспользуемого import —
  `0 warnings`.
- `node --check` frozen/freezer entrypoints и `git diff --check`: PASS.
- Network calls = 0; model calls = 0; database writes = 0; Walmart report/create
  calls = 0; Walmart listing writes = 0.

## Qualification Officer — локальная точка

- Новый v2 gate принимает только owner-signed exact ordered sequence и отдельный
  one-SKU permit; сама sequence не разрешает marketplace write.
- Gate заново строит baseline/post source-aware audit из exact source bundles и
  не принимает cached/self-hashed PASS либо caller actor strings как authority.
- Permit привязан к sequence position, plan, target, Product Truth, apply release
  и exact request bytes. Missing apply evidence, reused baseline capture, другой
  SKU/plan/target/truth и stale unsuccessful reread fail closed.
- `PENDING_PROPAGATION` разрешает только новый reread того же write без повторной
  записи; после полного propagation window неподтверждённое исправление становится
  `FAIL`, а не остаётся pending навсегда.
- Focused v2 qualification suite: `8/8 PASS`; targeted ESLint
  `--max-warnings=0` и `git diff --check`: PASS.
- Production verifier pin намеренно `null`: этот gate нельзя активировать, пока
  нет реального frozen apply writer и Walmart-native surgical payload contract.

Основные локальные файлы:

- `src/lib/walmart/item-report-reissue-executor-v2.ts`
- `src/lib/walmart/item-report-reissue-consumption-ledger-v2.ts`
- `scripts/walmart-item-report-reissue-v2-frozen-executor.mjs`
- `scripts/freeze-walmart-item-report-reissue-v2-executor-engine.mjs`
- `scripts/freeze-walmart-item-report-reissue-v2-engine.mjs`
- соответствующие focused tests в `src/lib/walmart/__tests__/` и
  `scripts/__tests__/`.

Stable source bytes после `139/139 PASS` и чистого targeted lint:

| SHA-256 | Файл |
|---|---|
| `e2a3c058e1ed85a495fcb7e00944e62d1d72ce0a1c45b08a7ac2d62795b349c9` | `src/lib/walmart/item-report-capture-session.ts` |
| `71cf53476ab36608ec101d53c791208d96645422e59c0e7005cade7700c54aff` | `src/lib/walmart/item-report-reissue-consumption-ledger-v2.ts` |
| `5a8d56c662a10e24d42ea8ffb851b5e2646631987b8cad03f45f3c324cd0d124` | `src/lib/walmart/item-report-reissue-executor-v2.ts` |
| `9cfbe84cac4ee0e60f86b295365ffd650a4c9e5e23f497e872beb8953afe15e3` | `src/lib/walmart/__tests__/item-report-reissue-consumption-ledger-v2.test.mjs` |
| `e3e604ff64f50726f8024637d7a25329643243af3b23698462d754b0fdce3a3a` | `src/lib/walmart/__tests__/item-report-reissue-executor-v2.test.mjs` |
| `caad6434094f1f62fcc2803e364a4dc1bf0722a3b05b93cbe06d757ee0693c4e` | `scripts/freeze-walmart-item-report-reissue-v2-engine.mjs` |
| `e58f66def68f2c7db014f1e8403e8592709306ca916990f027218e8d81393c5b` | `scripts/freeze-walmart-item-report-reissue-v2-executor-engine.mjs` |
| `633be31e2f0ba9b08502cdc7011be2226a1d439114d61152e2724be623825399` | `scripts/walmart-item-report-reissue-v2-frozen-executor.mjs` |
| `071016b2011f1fa021a3a0b4f78db4075bc45dc8db6c6507076e5c1c066ac245` | `scripts/__tests__/freeze-walmart-item-report-reissue-v2-executor-engine.test.mjs` |
| `d85b25b568dbd02a148169337b5a18d3140b51d7ac0a2d0067dda1cded1f0af2` | `scripts/__tests__/walmart-item-report-reissue-v2-frozen-executor.test.mjs` |

## Почему live всё ещё нельзя запускать

1. Production owner Ed25519 trust root остаётся пустым. Закрытый ключ не создан,
   public key не pinned; локальные тестовые ключи production authority не дают.
2. Нужны новый frozen release из этих финальных bytes, fresh source evidence,
   новый head-enabled ledger bootstrap и внешний owner-signed disposition,
   связывающий точные SHA всех этих артефактов.
3. После freeze нужен последний независимый review exact release bytes. Только
   затем допустим ровно один owner-authorized ITEM v6 POST без retry.
4. Общий listing-remediation контур отдельно остаётся `NO-GO`. Authority и
   source-aware rebuild теперь формализованы локально, но production existing-
   listing writer отсутствует. Текущий WIP payload verifier не соответствует
   доказанному Walmart `MP_MAINTENANCE`: нужны реальные `MPItemFeedHeader`,
   `productIdentifiers`/UPC, productType и current spec, а write должен быть
   changed-fields-only surgical mutation, не повторной отправкой full target.
   Нужны также frozen file-backed writer attestation и реальный permit-consumption/
   raw HTTP/feed capture. Этот checkpoint не разрешает массовые исправления.

## Точная точка продолжения

1. Не запускать live и не разрешать Claude редактировать этот движок.
2. Получить отдельное явное разрешение владельца на внешний private Ed25519 key,
   затем pin только public key и заново выполнить focused certification/freeze.
3. Создать fresh head-enabled ledger, свежие exact evidence и внешний
   owner-signed disposition; проверить их SHA и expiry в offline preflight.
4. Выполнить ровно один authorized ITEM v6 request, продолжить существующим
   `poll → download → compile`, без retry POST.
5. На свежих authoritative sources провести малый read-only audit и выбрать
   1–3 реальные ошибки.
6. Реализовать Walmart-native one-SKU surgical writer: exact current spec,
   payload-bound permit, durable ledger, один POST без ambiguous retry и exact
   raw response/feed-status capture.
7. Доказать 1–3 полных repair → propagation → live reread → qualification PASS.
8. Подключить тот же backend как вкладку **Listing Integrity** в Walmart Growth;
   постоянная архитектура: `docs/wiki/walmart-listing-integrity-platform.md`.
   Claude остаётся release/emergency operator, а не ежедневным runtime.
