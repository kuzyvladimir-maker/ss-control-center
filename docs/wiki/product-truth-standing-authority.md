# Product Truth — постоянная owner authority для enrichment

> **Статус:** ACTIVE с 2026-07-28.
>
> **Назначение:** убрать ручные `APPROVE_PRODUCT_TRUTH_…` строки, plan SHA,
> permit IDs и confirmation tokens из общения с владельцем. Этот документ
> применяется только к общему Product Truth retailer/provider enrichment.

## Решение владельца

Владелец неоднократно потребовал выполнять Product Truth под ключ, не
останавливаться на каждом provider-вызове и удалить проектное правило, которое
заставляло его копировать длинные approval-строки. Это постоянное решение заменяет
per-plan chat approval для обычного enrichment.

Движок по-прежнему работает fail closed. Разрешение теперь выводится автоматически
из immutable standing policy и точного sealed plan. Внутренние approval artifact,
metered permit, confirmation и budget ledger остаются техническими механизмами,
но создаются движком и никогда не запрашиваются у владельца вручную.

## Что выполняется автономно

- локальная разработка, тесты, clean-checkout certification и read-only production;
- Phase 1 retailer/provider enrichment только для authoritative selling scope;
- Phase 2 enrichment после явного включения соответствующего roadmap stage;
- fresh provider balance probe, если он технически необходим для reserve-floor gate;
- plan-bound Oxylabs/Unwrangle вызовы и exact canonical Product Truth writes;
- bounded canary и последующие bounded waves после machine acceptance предыдущей;
- status, report, readiness, immutable evidence и Wiki‑Brain updates.

## Жёсткие автоматические границы

- ZIP `33765`;
- только authoritative first-party evidence;
- exact variant для content; другой размер остаётся только price evidence;
- максимум одна попытка, concurrency `1`, no automatic retry/replay;
- BJ's запрещён; Sam's/Costco запрещены без отдельного club decision;
- Unwrangle reserve floor не ниже `15000`;
- plan и provider ceilings immutable, provider tariff учитывается по фактическому
  live-observed контракту;
- ambiguous/unknown outcome не replay и не превращается в FACT;
- никакого parallel catalog или consumer-owned retailer harvest;
- никакого marketplace/listing write, price/inventory change, delist,
  consumer activation или procurement.

## Что всё ещё требует отдельного решения владельца

Standing enrichment authority не охватывает materially different бизнес-действия:

- публикацию или изменение marketplace listing;
- изменение цены, min/max или inventory;
- delisting;
- включение consumer `ENFORCED`;
- procurement/purchase;
- включение harvest-cron;
- BJ's или club expansion;
- изменение общего reserve floor или расширение бюджетной политики за пределы
  pinned standing policy.

Для обычного Product Truth provider canary/wave отдельное сообщение владельца,
approval phrase или копирование хэшей **запрещено запрашивать**.

## Машинный контракт

Canonical policy:
`ss-control-center/data/audits/product-truth-standing-authority/standing-provider-policy-20260728-v1.json`.
Pinned SHA-256:
`7b7bcc997e340e46c97482c8c9f29f64cefdc8e46eadbd13d459d5953ed03eb0`.

CLI workflow:

```text
doctor → plan → balance-probe → authorize → execute → status/report
```

`balance-probe` и `authorize` проверяют pinned policy, exact plan SHA, production
target, Phase 1 manifest binding, provider ceilings, reserve floor и запреты.
`authorize` выпускает внутренний approval/permit и exact next command. Оператор
следует этой команде без обращения к владельцу.

Связано: [[product-catalog-architecture]],
[[donor-catalog-execution-roadmap]], [[product-truth-operator-runbook]],
[[product-truth-owner-gates]], [[product-truth-command-center]].

## Первое production-доказательство

Standing workflow принят фактическим canary
`pt-field-snapshot-standing-20260729t004612z`:

- clean release commit `bc98d341ee3dbe79a709e4dd3bf68661c1e6fc12`,
  tree `6eaed9761863dcf6596d67402b1d8ecfc441fe5d`, engine
  `805431de…b355`, Product Truth `519/519`;
- read-only request `50483a90…3389`, plan `d9f1ffaf…ad21`;
- automatic balance permit/receipt: `1` call / `2.5` units, observed balance
  `99665`, reserve floor `15000`;
- working run: Oxylabs `1` call / `1` unit, Unwrangle `1` detail /
  `2.5` units, retry `0`;
- combined spend `6` units;
- terminal outcome
  `COMPLETED / EXACT_FIELD_SNAPSHOT_CAPTURED_WITH_KNOWN_GAPS`;
- exact variant decision, price observation и partial content snapshot с шестью
  images сохранены; allergens/storage остаются явными gaps;
- marketplace/listing/price/inventory/delist/activation/procurement actions `0`.

Малый immutable packet и canonical checkpoint:
`ss-control-center/data/audits/product-truth-standing-authority/20260729T004612Z-canary-v1/`.
Большие read-only full-denominator artifacts не дублируются в Git; checkpoint
содержит их exact SHA-256. Postcheck reconciled `5935/5935`.

Следующий технический этап — independent canonical listing recipe/COGS
materialization из уже сохранённых exact evidence. Он не требует повторного
provider call и не восстанавливает ручной chat approval.
