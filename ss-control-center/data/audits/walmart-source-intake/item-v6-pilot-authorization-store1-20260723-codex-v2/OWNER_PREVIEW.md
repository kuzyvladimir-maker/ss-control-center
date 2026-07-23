# Walmart all-status catalog capture — owner preview

> **Статус: SUPERSEDED / НЕ ИСПОЛНЯТЬ.** Этот packet был подготовлен до
> owner-control enrollment. Связанный frozen executor содержит пустой production
> trust root, поэтому корректно не способен выполнить POST; source evidence также
> имеет ограниченный срок. Ни приведённая ниже фраза, ни старые plan/session/ledger
> не должны переиспользоваться. После одного owner-control key enrollment Codex
> выполняет fresh GET-only probe и выпускает новый self-bound packet.

## Зачем это нужно

Один раз запросить у Walmart полный ITEM v6 report для действующего store 1 и
получить authoritative all-status каталог наших Walmart-листингов. Этот каталог
нужен Bundle Factory, чтобы до выбора первого нового SKU исключить дубли по SKU,
UPC, товару, варианту и bundle recipe во всех seller statuses.

Это **не** публикация листинга, не изменение существующего листинга, не repricing,
не delist и не закупка.

## Что уже подготовлено локально

- Frozen one-shot executor manifest SHA-256:
  `2faa4399e751ad4d7877629347ba7c6138d915ca99bfca5909f4c33d77918c5e`.
- Frozen executor bundle SHA-256:
  `b44b6a354d512cda3229186c3da0224a65f1c807d7732db622945681d5f7429e`.
- Focused safety suite: `71/71 PASS`.
- Fresh source-evidence artifact SHA-256:
  `0c203bef0b14f199c6eca33560257adbf8baf4d17721950a6dfd765333be64a5`;
  valid through `2026-07-23T06:39:07.290Z`.
- New replacement plan SHA-256:
  `5db5f99d1eb55f7d0214f117cd6d94e4b046a1ecd1cafebafb5f91f716cde182`.
- New empty at-most-once ledger binding SHA-256:
  `f18034cf7900503f28c565eb8b59c00a86f7304e0727f265dbbe62b817841d88`.
- Account scope: Walmart US, store 1, seller `10001624309`.

На этапе подготовки выполнено: network calls `0`, database calls `0`, model calls
`0`, Walmart content writes `0`.

## Что произойдёт только после отдельного разрешения

1. Будет создана новая короткоживущая одноразовая авторизация, привязанная к exact
   executor, evidence, replacement plan, ledger и store 1.
2. Executor выполнит не более одного POST к Walmart Reports API для создания
   `ITEM v6` report request.
3. Повторов POST не будет. Timeout, HTTP 429, неизвестный ответ или crash навсегда
   сожгут эту авторизацию и остановят процесс.
4. Только при доказанном `requestId` дальнейшие операции будут GET-only:
   poll, download и offline compile/verify полного каталога.

Предыдущая авторизация с ответом HTTP 429 терминальна и повторно не используется.

## Что не разрешается этим решением

- создание или изменение Walmart SKU;
- применение production schema migrations;
- активация каталога в production DB;
- платные provider/model calls;
- волны 15–20 SKU или расписание.

## Решение владельца

Если preview принят, понятное разрешение для следующего шага:

`Разрешаю один новый запрос полного Walmart ITEM v6 каталога для store 1 по подготовленному плану v2 без повторов и без публикации листингов.`
