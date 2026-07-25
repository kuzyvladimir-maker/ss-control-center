# Product Truth — единый реестр owner gates

> **Статус:** живой decision ledger, сверено 2026-07-25.
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
| G1. Import permanent candidate | `AWAITING_OWNER` | Код/UI/канон пока в isolated branch, не в shared `main` |
| G2. Web Operations Stage A | `AWAITING_OWNER` | SSCC command/artifact/event schema и tests не реализуются |
| G3. Phase 1 store dispositions | `AWAITING_OWNER_FACTS` | Нельзя выпустить owner-bound connected-store census |
| G4. Walmart ITEM v6 read-only report | `AWAITING_OWNER_ACTION_GATE` | Нет authoritative Walmart report bytes |
| G5. Backfill apply | `NOT_READY` | Сначала G3/G4 → manifest → read-only plan |
| G6. Consumer SHADOW activation | `NOT_READY` | Сначала authoritative manifest/backfill/readiness |
| G7. Provider canary / paid wave | `NOT_READY` | Отдельный plan, permit, budget, balance и owner approval |
| G8. Marketplace/purchase actions | `NOT_READY` | Никогда не разрешаются data/readiness gate-ами |

## G1 — импорт permanent candidate в shared local `main`

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
  отсутствует, report пуст, last state `DEACTIVATED` → рекомендовано
  `EXCLUDED_OWNER_CONFIRMED`.
- Amazon store2 `Vladimir Personal`: Sellers API 403, seller ID отсутствует,
  last order 2026-05-18.
- Amazon store4 `Sirius International`: credentials/seller ID отсутствуют,
  last order 2026-05-11.
- Walmart store1 `SIRIUS TRADING INTERNATIONAL LLC`: connected/active →
  `IN_SCOPE`, но authoritative ITEM v6 report отсутствует.

Код не может решить бизнес-факт, являются ли store2/store4 всё ещё intended
connected selling accounts.

### Если store2/store4 действительно больше не подключены

```text
Подтверждаю G3: Amazon store2 Vladimir Personal и store4 Sirius International
сейчас не являются подключёнными selling accounts; Amazon store5 Retailer
Distributor исключить как deactivated без US participation. Amazon store1
Salutem Solutions, store3 AMZ Commerce и Walmart store1 SIRIUS TRADING
INTERNATIONAL LLC оставить в Phase 1.
```

### Если store2 или store4 всё ещё действующий

Владелец называет exact store. Тогда gate остаётся открыт до восстановления его
credentials/identity и свежего полного Amazon report. Действующий магазин нельзя
исключить ради удобного denominator.

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
confirmation.

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

