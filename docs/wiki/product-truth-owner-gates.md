# Product Truth — единый реестр owner gates

> **Статус:** живой decision ledger, сверено 2026-07-26.
>
> **Канон:** [[product-catalog-architecture]]. Execution order:
> [[donor-catalog-execution-roadmap]]. Permanent module:
> [[product-truth-command-center]]. Web operations:
> [[product-truth-web-operations-control-plane]].
>
> Ни один пункт этого файла не считается одобренным по факту его наличия. Owner
> approval существует только после явного ответа владельца на точный пункт.

## Зачем этот файл

Все Product Truth решения собраны здесь, чтобы владелец не получал несколько
перекрывающихся промптов от Codex и Claude Code. Каждый gate:

- имеет точную границу;
- перечисляет разрешённые действия;
- перечисляет действия, которые он **не** разрешает;
- может быть одобрен независимо от остальных;
- после использования помечается consumed с evidence.

## Текущий статус

| Gate | Состояние | Что блокирует |
|---|---|---|
| G1. Import permanent candidate | `CONSUMED_2026-07-26` | Закрыт; evidence ниже |
| G2. Web Operations Stage A | `CONSUMED_LOCAL_2026-07-26` | Закрыт; runtime hardcoded `OFF`, evidence ниже |
| G3. Phase 1 store dispositions | `OWNER_CONFIRMED` | Нужно выпустить hash-bound census/disposition artifact с exact owner facts |
| G4. Walmart ITEM v6 read-only report | `APPROVED_AWAITING_SEALED_AUTHORIZATION` | Нет новой engine-generated authorization/permit и authoritative report bytes |
| G5. Backfill apply | `NOT_READY` | Сначала G3/G4 → manifest → read-only plan |
| G6. Consumer SHADOW activation | `NOT_READY` | Сначала authoritative manifest/backfill/readiness |
| G7. Provider canary / paid wave | `NOT_READY` | Отдельный plan, permit, budget, balance и owner approval |
| G8. Marketplace/purchase actions | `NOT_READY` | Никогда не разрешаются data/readiness gate-ами |

## Owner decision 2026-07-26

Владелец подтвердил текущий Phase 1 selling-account scope и разрешил продолжить
G1–G4 в границах этого ledger:

- Amazon store1 `Salutem Solutions` — `IN_SCOPE`;
- Amazon store3 `AMZ Commerce` — `IN_SCOPE`;
- Walmart store1 `SIRIUS TRADING INTERNATIONAL LLC` — `IN_SCOPE`;
- Amazon store2 `Vladimir Personal` — `EXCLUDED_OWNER_CONFIRMED_BLOCKED`;
- Amazon store4 `Sirius International` — `EXCLUDED_OWNER_CONFIRMED_BLOCKED`;
- Amazon store5 `Retailer Distributor` — `EXCLUDED_OWNER_CONFIRMED_BLOCKED`.

Три исключённых Amazon-аккаунта сейчас заблокированы, по ним не выполняются
listing intake, enrichment или marketplace actions. Это **не удаление** аккаунтов
и не вечное исключение: после разблокировки любой из них возвращается только через
successor census, свежий authoritative report и новый manifest.

Решение разрешает:

- G1 — локальный import exact certified permanent candidate без push/deploy;
- G2 — реализацию Stage A с runtime hardcoded `OFF`;
- G3 — выпуск owner-bound census/disposition artifacts по фактам выше;
- G4 — одну новую zero-retry read-only попытку через sealed workflow.

Оно не разрешает G5–G8, production activation, paid provider waves, delist,
repricing, listing publish/apply или purchase.

## G1 — импорт permanent candidate в shared local `main`

### Consumed evidence 2026-07-26

- imported shared `main` commit:
  `df1e6600ef3a38ba402b5785ac7ed4ef1a3597a2`;
- imported tree:
  `a74a45697a88509478ecf1750995194c9b7c0e6c`;
- required base:
  `af403b1ffbbfa7c039935824c8b9cd8bd59aa99e`;
- two scoped recovery stashes retained; unrelated dirty worktree remained;
- shared Product Truth certification `445/445`, targeted ESLint and Wiki-Brain
  `0/0` passed;
- no push, deploy, DB/provider/paid/marketplace action occurred.

Global shared-worktree TypeScript remains independently red on two active,
uncommitted Walmart new-SKU files. The exact imported commit passed TypeScript and
production build from a no-hardlink clean checkout; this external dirty-worktree
warning does not weaken or expand G1.

### Разрешает

- импортировать exact verified candidate из recovery bundle/isolated branch;
- сохранить только scoped Product Truth code/docs/UI changes;
- разрешить конфликты без перезаписи unrelated owner worktree;
- повторить certification/build в shared tree.

### Не разрешает

- `git push`, PR/merge в remote;
- deploy;
- production env activation;
- DB migration/backfill;
- provider/API/marketplace calls;
- paid spend.

### Exact owner phrase

```text
Разрешаю G1: импортировать exact Product Truth permanent candidate в локальный
shared main, сохранив все unrelated изменения worktree. Push, deploy, production
activation, DB writes, provider calls и marketplace actions не разрешаю.
```

## G2 — Web Operations Stage A, runtime hardcoded OFF

Полный design: [[product-truth-web-operations-control-plane]].

### Consumed evidence 2026-07-26

- code commit:
  `fc98be84cdb6c909e0d5a6db45f8b6570e01bcde`;
- tree:
  `37a706c362201e46c6401756fc0b0347995f9199`;
- Product Truth certification `451/451`, TypeScript, targeted ESLint, Prisma
  validate, production build и `git diff --check` — `PASS`;
- отдельная SSCC migration family создана, но к production DB не применялась;
- runtime остаётся hardcoded `OFF`; routes, worker claim, production trust-root,
  provider calls/spend и marketplace actions отсутствуют.

### Разрешает

- отдельную SSCC migration family для command/artifact/event tables;
- canonical parsers/state machine;
- отдельный Product Truth Ed25519 domain/verifier;
- append-only DB triggers;
- adversarial/local tests;
- runtime hardcoded `OFF`.

### Не разрешает

- production migration apply;
- создание/enrollment production owner key;
- worker claim или запуск CLI;
- DB business-data writes;
- provider calls/spend;
- marketplace/purchase actions.

### Exact owner phrase

```text
Разрешаю G2: Product Truth Web Operations Stage A по
product-truth-web-operations-control-plane.md — отдельная SSCC
schema/contracts/tests, отдельный Product Truth Ed25519 domain, runtime hardcoded
OFF. Не разрешаю production activation, worker claim, DB apply, provider calls,
paid spend или marketplace actions.
```

## G3 — authoritative Phase 1 store dispositions

### Уже доказано

- Amazon store1 `Salutem Solutions`: connected US, свежий полный report,
  1 563 rows → рекомендовано `IN_SCOPE`.
- Amazon store3 `AMZ Commerce`: connected US, свежий полный report,
  514 rows → рекомендовано `IN_SCOPE`.
- Amazon store5 `Retailer Distributor`: credentials есть, US participation
  отсутствует, report пуст, last observed technical state `DEACTIVATED`;
  владелец 2026-07-26 подтвердил текущий business state `BLOCKED` и исключение
  из текущего Phase 1 snapshot.
- Amazon store2 `Vladimir Personal`: Sellers API 403, seller ID отсутствует,
  last order 2026-05-18.
- Amazon store4 `Sirius International`: credentials/seller ID отсутствуют,
  last order 2026-05-11.
- Walmart store1 `SIRIUS TRADING INTERNATIONAL LLC`: connected/active →
  `IN_SCOPE`, но authoritative ITEM v6 report отсутствует.

Код не мог решить бизнес-факт для store2/store4/store5. Владелец закрыл этот
вопрос решением 2026-07-26: все три сейчас blocked и исключаются из текущего
manifest denominator.

### Принятое disposition

```text
Amazon store2 Vladimir Personal, store4 Sirius International и store5 Retailer
Distributor сейчас заблокированы и исключены из текущего Phase 1 snapshot.
Amazon store1 Salutem Solutions, store3 AMZ Commerce и Walmart store1 SIRIUS
TRADING INTERNATIONAL LLC остаются в Phase 1.
```

### Historical proposed wording — superseded

```text
Подтверждаю G3: Amazon store2 Vladimir Personal и store4 Sirius International
сейчас не являются подключёнными selling accounts; Amazon store5 Retailer
Distributor исключить как deactivated без US participation. Amazon store1
Salutem Solutions, store3 AMZ Commerce и Walmart store1 SIRIUS TRADING
INTERNATIONAL LLC оставить в Phase 1.
```

### Если заблокированный магазин будет восстановлен

Владелец называет exact store. Для него создаются successor census/disposition,
восстанавливаются credentials/identity, снимается свежий полный Amazon report и
выпускается successor manifest. Старый manifest задним числом не изменяется.

G3 разрешает только owner-bound census/disposition artifacts. Он не разрешает
network call, manifest, backfill, provider spend или marketplace write.

## G4 — одна попытка получить Walmart ITEM v6

Новый bounded GET-only probe показал, что list endpoint вернул только ITEM v2.
Для authoritative Phase 1 нужен fresh ITEM v6 report.

### Разрешает

- не более одного OAuth token call;
- не более одного Walmart report-create POST;
- report download/poll только в рамках engine-generated exact authorization;
- `retries=0`;
- сохранение exact response/report bytes и SHA.

### Не разрешает

- listing/price/inventory/delist write;
- второй report-create;
- provider call/spend;
- backfill;
- publish.

### Exact owner phrase

```text
Разрешаю G4: одну новую zero-retry попытку создать и получить Walmart ITEM v6
только для read-only Product Truth intake: максимум один OAuth token call и один
report-create POST. Листинги, цены, inventory и delist не изменять; повторный
report-create не разрешаю.
```

G4 исполняется только готовым sealed operator workflow. Текстовое разрешение не
заменяет требуемые engine-generated authorization/permit bytes, hashes и exact
confirmation. Quarantined session и старые permit/authorization bytes повторно
использовать запрещено.

## Что произойдёт после G3 + G4

1. Внешние owner facts будут оформлены canonical census/disposition artifacts.
2. Exact Amazon/Walmart report bytes сформируют authoritative Phase 1 manifest v3.
3. Codex/оператор выполнит только read-only `backfill-plan`.
4. Владелец увидит denominator, writes preview, blockers и no-paid claims.
5. Только после этого появится отдельный G5 на exact backfill apply.

## Удобный комбинированный ответ

Если владелец принимает все текущие рекомендации, он может ответить одним
сообщением, не копируя длинные тексты:

```text
Разрешаю G1 и G2 в точных границах product-truth-owner-gates.md.
Подтверждаю рекомендуемые dispositions G3: store2/store4 не подключены,
store5 deactivated без US participation; store1/store3 Amazon и store1 Walmart
оставить в Phase 1.
Разрешаю G4: один zero-retry Walmart ITEM v6 read-only report request.
Никаких иных production, paid, provider, marketplace, repricing, delist или
purchase действий не разрешаю.
```

Можно одобрить только отдельные номера, например: `Разрешаю только G1`.
