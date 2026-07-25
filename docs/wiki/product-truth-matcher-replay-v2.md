# Product Truth Matcher Replay v2.2 — канонический post-blind corpus и Gate 1

> **Статус 2026-07-20:** честный offline-контур v2.2 выпущен и проверен. Engine
> `78e0664908cd37c3746a311084f4826a031b3658`, tree
> `7a2eb1a6bbc0886fec33898268db3036e240aa22`; focused tests `23/23`, полный Product
> Truth suite `432/432`. Sealed-wrapper replay дал ожидаемый exit `2`: semantic matcher
> `304/304 PASS`, quarantine `300 resolved / 86 unresolved`, golden `2 cases / 4
> comparisons PASS`, единственный blocker `UNRESOLVED_EVIDENCE_PRESENT`.
> `MATCHER_CORPUS_NOT_CANONICAL` закрыт, но полный Gate 1 truth остаётся **BLOCKED** до
> authoritative evidence для 86 cases. Исторический sealed replay остаётся immutable
> на literal matcher `canonical-product-match/1.2.0` и не получает права на production
> writes. Current operational source от 2026-07-22 использует отдельный matcher release
> `1.2.1` с SHA implementation bytes и release manifest; его production data path всё
> ещё закрыт до owner-approved migration/backfill и consumer cutover. Paid/provider/
> DB/network/model/marketplace calls — ноль; очередь 1 458 не разрешена.
>
> Подчинён [[product-catalog-architecture]],
> [[donor-catalog-execution-roadmap]], [[product-truth-operator-runbook]] и
> [[product-truth-release-scope]].

## 1. Почему title-only v1 и операторский v2.1 запрещены

Raw artifact `_gen_enriched_state.json` содержит ровно 386 строк со старым статусом
`VARIANT_MISMATCH`. В нём есть legacy SKU, статус/причина, title нашего listing и donor
title, но нет авторитетного recipe decomposition, canonical variant identity,
pack/GTIN evidence или независимого expected verdict.

Механическая title-only конвертация дала формальное `386/386 PASS`, потому что все пары
были отвергнуты одной причиной `TARGET_BRAND_MISSING`. Matcher не получил
структурированную товарную идентичность и фактически «отклонил всё вслепую». Это
**vacuous pass**, а не доказательство precision или variant safety. Legacy
`VARIANT_MISMATCH` — результат старой эвристики, а не truth label; среди 386 есть
recovered positives вроде эквивалентных `Decaf`/`Decaffeinated` и необязательных
SEO/claim-токенов.

V2.1 исправил semantic contract и после `Original`/structured-flavor fix действительно
дал `304/304 PASS`, но его четырёхфайловый operator handoff остался неприемлемым:

- post-blind reconciliation ошибочно называлась соглашением двух blinded review;
- direct runner не доказывал exact commit/tree/runtime bytes до запуска;
- frozen blind task/review A/review B/reconciliation map не входили в обязательный
  operator input boundary.

Поэтому `INVALID-product-truth-matcher-operator-handoff-v21-*`, title-only packets и
`INVALID-assembled-v22-pre-legacy-map-canonicalizer-fix` являются только негативным
доказательством. Их нельзя исполнять или считать Gate 1.

## 2. Что именно доказывает v2.2

Corpus schema — `product-truth-matcher-replay-corpus/2.2.0`; replay report schema —
`product-truth-matcher-replay-report/2.2.0`. Режим provenance — только
`POST_BLIND_RECONCILED_CONSENSUS`.

V2.2 требует ровно восемь immutable input-файлов:

1. exact raw source artifact;
2. canonical final corpus;
3. post-blind consensus acceptance A;
4. post-blind consensus acceptance B;
5. исходный label-free blind task;
6. frozen original blind review A;
7. frozen original blind review B;
8. exact legacy reconciliation map.

Runner связывает эти bytes один-к-одному: все 386 raw `VARIANT_MISMATCH` rows, два
отдельных golden source cases, structured inputs каждого resolved candidate,
controlled reasons каждого unresolved case, исходные blind decisions, reconciliation
и обе финальные acceptance. Он сам пересчитывает original blind comparison
`80 exact / 181 structural disagreement with the same semantic signature / 127 semantic
disagreement` и отклоняет corpus, который скрывает или переименовывает эту историю.

Семь operational JSON inputs проверяются как exact canonical bytes. Reconciliation map
сохранён в точных historical builder bytes: его exact path/length/SHA, regular
non-symlink type, UTF-8 JSON и глубокая schema/semantic structure проверяются, но файл
не перерисовывается новым recursive-sort renderer. Это узкая compatibility boundary,
а не ослабление SHA или content validation.

Дополнительный sealed runtime wrapper до запуска runner проверяет:

- clean Git checkout, exact commit `78e06649…` и tree `7a2eb1a6…`;
- exact SHA/length matcher, replay module, runner, renderer, tests и package lock;
- absolute path, SHA/length, regular-file/no-symlink boundary всех восьми inputs;
- fixed denominators `386` quarantine и `2` golden cases;
- ровно один заранее sealed новый output path;
- отсутствие passthrough flags и fixed Node args `--import tsx`.

Superseded runtimes `dae2cc33…`, `4a0b1350…` и pre-map-fix `9e0619be…` отвергаются
wrapper до runner. Preflight failure имеет exit `78` и не создаёт replay output;
runner exit передаётся без переименования.

## 3. Структура cases и защита от vacuous pass

Одна raw source row может описывать single item, single-variant multipack или mixed
bundle. Поэтому resolved case содержит один или несколько atomic target components
`variant × quantity` и один или несколько candidates. Каждый candidate связан с одним
target component; runner проверяет все candidates.

Canonical identity каждого atomic component/candidate разделяет brand, product line,
flavor, modifiers, form, outer pack count и parseable size. Raw title остаётся evidence,
но не становится structured identity автоматически.

Quarantine cohort содержит смешанные результаты:

- semantic `REJECT` только с конкретной semantic conflict reason;
- recovered positives с tier `EXACT_IDENTITY`, `CROSS_SIZE_ESTIMATE`,
  `SIBLING_ESTIMATE` или `SIZE_UNKNOWN_ESTIMATE`;
- `UNRESOLVED_EVIDENCE` при недостаточном evidence.

Unresolved row остаётся в exact 386-row denominator, но имеет `target=null`, пустые
`candidates`, `BLOCKED_FROM_MATCHER`, `matcherInvoked=false` и не влияет на semantic
precision. Его нельзя синтетически переименовать в reject.

Golden cohort отделён от quarantine: ровно два source cases и четыре comparisons,
вместе покрывающие все четыре positive tiers. Production non-vacuity floor остаётся
минимум `300` resolved и максимум `86` unresolved; это safety threshold, а не цель,
под которую разрешено подгонять labels.

Полный exit `0` возможен только при `PASS_FULL`: semantic matcher `PASS`, evidence
`COMPLETE`, full-corpus truth `PASS` и ноль unresolved. Semantic PASS при partial
evidence возвращает общий `certification=FAIL`, `fullCorpusTruthCertification=BLOCKED`
и exit `2`.

## 4. Честная история adjudication

Исходные reviewer decisions были действительно frozen до reconciliation, но **не
согласились** между собой на всём наборе. Их точное сравнение:

```text
exact decision equality:                         80
structural disagreement, same semantic result: 181
semantic signature disagreement:               127
total:                                          388
```

После blind freeze был построен evidence-backed reconciliation map, затем каждый
reviewer принял один и тот же reconciled set как post-blind consensus. Обе финальные
acceptance явно содержат:

```text
priorExposure: true
blindAgreementClaimed: false
consensusMode: POST_BLIND_RECONCILED_CONSENSUS
```

Следовательно, v2.2 не заявляет «два независимых blinded reviewer согласились». Он
заявляет более узкий и проверяемый факт: исходные blind artifacts сохранены по точным
hashes, их расхождения измерены, reconciliation byte-bound, а два reviewer после
раскрытия приняли его полностью. Engine проверяет форму и bindings, но не
аутентифицирует личности reviewer (`adjudicatorAuthenticatedByEngine=false`).

## 5. Frozen evidence packet

| Input | SHA-256 |
|---|---|
| raw `_gen_enriched_state.json` | `5a48cae7ff211170dc19a261b9a9418d463b7b2c4a62855ee2b85c40185c5484` |
| corpus v2.2 | `a1310fce60fcfe3e463cc853181fb155b9a200bc45ddaa5bda6ee8b79827e06f` |
| consensus acceptance A | `5d0cdc78006e4b72dee7067f041d8b6e6f960ac2c287fbe73110f4bbb9a701eb` |
| consensus acceptance B | `e2c1d781c47f53fc86f71a060a33c251f199887329c29b226ce412cef0670384` |
| original blind task | `0d53e57921abc26d08b7d334bebd67920062166c6db29b5365e47587054c1b45` |
| frozen blind review A | `d436565bb9c1e373928be655a94c6f292c51b7919393bbfd6e2ac47bad1ecec2` |
| frozen blind review B | `2445384e15a02052f3bdf464cbb1ca989e23ac92823c5082fc4a0526d26f2507` |
| reconciliation map | `bc23dc7cbcfc1bdca774044733a814b6090d850b5bcf27262fd29ed8a1591601` |

Canonical packet:
`release-artifacts/product-truth-matcher-adjudication-2026-07-19/assembled-v22-post-blind-consensus-final/`.

Runtime release:
`release-artifacts/product-truth-matcher-consensus-v22-release-2026-07-19/`.

Wrapper SHA-256:
`7022edca836d0bb563a21bf7d0dd66a321c951d8fb97de652e084a98d6669dfc`.

Untouched Claude manifest SHA-256:
`2927749ae03fc563175682afae83f96bfe037cd383c0530cce6929e9df812d11`.

## 6. Единственная операторская команда

Claude Code запускает **только sealed wrapper**, не `npm run product-truth --
matcher-replay` и не direct `scripts/product-truth-runner.ts`. Для текущего frozen
packet команда одна:

```bash
node '/Users/vladimirkuznetsov/SS Command Center/release-artifacts/product-truth-matcher-runtime-verifier-2026-07-19/verify-and-run-matcher-replay.mjs' \
  --manifest '/Users/vladimirkuznetsov/SS Command Center/release-artifacts/product-truth-matcher-runtime-verifier-2026-07-19/runtime-manifest.v2.2.claude-operator.json' \
  --expected-manifest-sha256 2927749ae03fc563175682afae83f96bfe037cd383c0530cce6929e9df812d11 \
  --expected-wrapper-sha256 7022edca836d0bb563a21bf7d0dd66a321c951d8fb97de652e084a98d6669dfc \
  --engine-root '/private/tmp/product-truth-matcher-consensus-v22.f2xgHH/repo/ss-control-center' \
  --source-artifact '/Users/vladimirkuznetsov/SS Command Center/ss-control-center/_gen_enriched_state.json' \
  --corpus '/Users/vladimirkuznetsov/SS Command Center/release-artifacts/product-truth-matcher-adjudication-2026-07-19/assembled-v22-post-blind-consensus-final/corpus.json' \
  --review-a '/Users/vladimirkuznetsov/SS Command Center/release-artifacts/product-truth-matcher-adjudication-2026-07-19/assembled-v22-post-blind-consensus-final/review-a.json' \
  --review-b '/Users/vladimirkuznetsov/SS Command Center/release-artifacts/product-truth-matcher-adjudication-2026-07-19/assembled-v22-post-blind-consensus-final/review-b.json' \
  --blind-task '/Users/vladimirkuznetsov/SS Command Center/release-artifacts/product-truth-matcher-adjudication-2026-07-19/prepared-v21-final/review-task-a.json' \
  --frozen-blind-review-a '/Users/vladimirkuznetsov/SS Command Center/release-artifacts/product-truth-matcher-adjudication-2026-07-19/reviews/codex-review-a/review-a-decision.json' \
  --frozen-blind-review-b '/Users/vladimirkuznetsov/SS Command Center/release-artifacts/product-truth-matcher-adjudication-2026-07-19/reviews/codex-review-b/review-b-decision.json' \
  --reconciliation-map '/Users/vladimirkuznetsov/SS Command Center/release-artifacts/product-truth-matcher-adjudication-2026-07-19/reconciliation-v21-final/canonical-adjudication-map.json' \
  --out '/Users/vladimirkuznetsov/SS Command Center/release-artifacts/product-truth-matcher-adjudication-2026-07-19/replay-v22-post-blind-consensus-claude-operator'
```

Ожидаемый честный результат — exit `2`, semantic `304/304 PASS`, golden `2/2 cases`
и `4/4 comparisons`, evidence `PARTIAL`, full truth `BLOCKED`, только blocker
`UNRESOLVED_EVIDENCE_PRESENT`. Claude сохраняет report/index и останавливается; не
правит engine/corpus/acceptances и не запускает очередь.

## 7. Проверенный Codex replay и оставшиеся blockers

Codex уже выполнил отдельный sealed manifest на тех же frozen bytes. Результат:

- report SHA-256 —
  `29aa05aaf8590fe09905e3b85f4d55f4dcc46e01a9b92cdec59deaf47e4fa8d5`;
- artifact-index SHA-256 —
  `2bffe77e99c1a943e85ff7295226876528ba6bfa00362d14d68da073113cc937`;
- semantic matcher `304/304 PASS`, false accept/reject/tier/reason mismatch — `0`;
- quarantine `300 resolved / 86 unresolved`;
- golden `2 cases / 4 comparisons`, все четыре positive tiers;
- only blocker `UNRESOLVED_EVIDENCE_PRESENT`;
- DB/network/model/provider/paid/marketplace calls — `0`.

Таким образом, code/corpus/runtime-проблема закрыта. Gate 1 в целом не закрыт по двум
разным причинам:

1. **Truth coverage:** 86 rows требуют нового authoritative recipe/identity evidence;
   ещё одна эвристическая разметка не может их закрыть.
2. **Production provenance boundary:** historical replay runtime остаётся exact
   `canonical-product-match/1.2.0`. Current operational source получил отдельную
   версию `canonical-product-match/1.2.1`, SHA точных implementation bytes и SHA
   matcher release manifest; persisted `1.2.0`, неполные и mismatched tuples теперь
   fail-closed отвергаются. Production decision writes всё ещё запрещены до
   owner-approved activation exact-eight migrations, authoritative backfill и consumer
   cutover release.

Semantic result не доказывает truth для 86 unresolved, production readiness,
завершение Phase 0/Phase 1 или право на paid queue.
