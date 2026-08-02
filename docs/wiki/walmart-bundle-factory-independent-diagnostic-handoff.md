# Walmart Bundle Factory: independent diagnostic handoff

**Status:** diagnostic handoff only; no root cause is asserted here  
**Prepared:** 2026-08-02 (America/New_York)  
**Chat / thread ID:** `019f778e-2901-7d00-9e51-4a4cc2164492`  
**Raw local chat transcript:**
`/Users/vladimirkuznetsov/.codex/sessions/2026/07/18/rollout-2026-07-18T19-27-13-019f778e-2901-7d00-9e51-4a4cc2164492.jsonl`

> Important: this file deliberately distinguishes observations from interpretations.
> It is not a diagnosis. Every proposed explanation below is a question to test, not
> an established cause. Read the raw chat and the canonical project documents before
> deciding what happened.

## 1. Purpose of this handoff

The owner asked for an independent technical review because several attempts to use
the Walmart branch of Bundle Factory did not result in five reviewable Walmart draft
listings. The visible workflow repeatedly moved between product-readiness checks,
Product Truth preparation/enrichment, and stopped/failed states.

This handoff is intended to let another engineer or Claude Code:

1. reconstruct the complete request and execution history;
2. determine the production release actually serving each attempt;
3. trace one build from browser request through web API, database, immutable command
   artifacts, worker, Product Truth writes, and final draft generation;
4. identify the first authoritative failure, rather than infer a cause from UI text;
5. decide whether the unshipped candidate patch is correct, incomplete, or unrelated;
6. propose or implement a fix only after the evidence supports it.

## 2. Epistemic labels used below

- **Owner report** — a statement made by the owner in the chat.
- **Screenshot observation** — text or state visible in a screenshot attached to the
  chat. It may not be the authoritative backend state.
- **Repository pointer** — a file, branch, commit, or test result that can be checked
  locally. Its existence does not prove that production ran it.
- **Question to verify** — a possible explanation or audit question. It must not be
  treated as a conclusion.

## 3. Requested business outcome

### Owner report

The immediate test request was to prepare five new Walmart listings using Campbell's
canned soups. Each listing should be a pack of eight identical cans of one exact
flavor/variant. Five different exact Campbell's variants should be selected from the
shared donor reference catalog. The selected Walmart account was shown as
`SIRIUS TRADING INTERNATIONAL LLC`, and the selected shipping template was shown as
`Default Template` with free shipping.

The intended immediate output was a batch of five owner-reviewable draft listings.
The chat does not authorize silently changing five listings to another count or pack
of eight to another quantity. The owner has repeatedly distinguished preparing and
reviewing drafts from publishing them.

The wider product outcome is a working Walmart-specific branch inside Bundle Factory,
using the shared Product Truth / donor reference catalog and Walmart-specific rules,
attributes, pricing, imagery, shipping-template handling, safety checks, and output.

## 4. Canonical context that must be read first

Before diagnosing or changing code, read these files completely, as required by the
repository's `AGENTS.md`:

1. `docs/wiki/product-catalog-architecture.md`
2. `docs/wiki/donor-catalog-execution-roadmap.md`
3. `docs/wiki/enrichment-division-of-labor.md`
4. `docs/wiki/product-truth-operator-runbook.md`
5. `docs/wiki/product-truth-consumer-cutover.md`
6. `docs/wiki/product-truth-release-scope.md`
7. `docs/wiki/product-truth-matcher-replay-v2.md`
8. `docs/wiki/product-truth-command-center.md`
9. `docs/wiki/product-truth-web-operations-control-plane.md`
10. `docs/wiki/product-truth-owner-gates.md`
11. `docs/wiki/walmart-new-sku-operator-runbook.md`

The documents are inputs to the investigation. If the running implementation differs
from them, record the difference; do not silently assume either side describes the
production behavior.

## 5. Source evidence

### Raw chat

The raw JSONL transcript named at the top is the most complete local record currently
identified for this thread. Its ID matches the session index entry titled first
`Проверить блокеры SKU Walmart` and then `Новые SKU Walmart`. At handoff time the file
was approximately 563 MB and had a modification time on 2026-08-02.

The transcript can contain large tool outputs, images or image references, developer
instructions, and environment details. Do not echo credentials or secret values while
reviewing it. Do not rely only on this summary when the raw turn or screenshot is
available.

### Production page shown in the chat

`https://salutemsolutions.info/bundle-factory/new`

One screenshot also showed a cache-busting query:

`https://salutemsolutions.info/bundle-factory/new?release=r17`

The query string alone does not establish which server release handled the request.
Determine the deployment and environment pins from authoritative deployment evidence.

## 6. Chronology visible in the chat

The following sequence is a transcription of owner reports and screenshot-visible UI.
It intentionally does not state why the transitions occurred.

### A. Initial request UI

1. **Screenshot observation:** the owner entered a Russian prompt requesting five
   Campbell's listings with eight cans in each listing.
2. **Screenshot observation:** Walmart was selected as the sales channel.
3. **Screenshot observation:** the Walmart account and `Default Template` were selected.
4. **Screenshot observation:** an early version displayed red restrictions saying the
   verified pilot supported only one or two listings and packs of two or three.
5. **Owner report:** the owner did not want those UI restrictions and expected missing
   catalog data to trigger collection/enrichment instead of changing or rejecting the
   requested quantities.

### B. Scope and Advanced section changes

1. **Screenshot observation:** a later page accepted and displayed `5 listings` and
   `pack of 8` without the earlier red scope restriction.
2. **Screenshot observation:** the Walmart Advanced section initially exposed house
   brand, text-model, photo-generation, and Uncrustables-specific image-style controls.
3. **Owner report:** those controls appeared unrelated or potentially misleading for
   third-party Walmart products such as Campbell's.
4. **Screenshot observation:** a later page showed only the target-margin control in
   the Walmart Advanced section and explanatory text about preserving manufacturer
   brand and verified donor imagery.

### C. Product readiness result

1. **Screenshot observation:** product readiness displayed zero of five requested
   variants ready.
2. **Screenshot observation:** a longer candidate list contained several Campbell's
   products with `DATA MISSING`.
3. **Screenshot observation:** missing-field descriptions varied. Some mentioned
   ingredients, nutrition facts, and allergen information; others mentioned current
   exact purchase price.
4. **Screenshot observation:** the UI recommended preparing exact one-product plans,
   reviewing actions and a maximum provider-credit cost, then approving or declining
   an exact quote.

### D. Preparation and configuration states

1. **Screenshot observation:** after pressing a preparation/retry control, one screen
   displayed: `The Product Truth collection control configuration is invalid. No
   command was created.`
2. **Owner report:** at that point the button appeared to flash or refresh the screen
   without an understandable result.
3. **Screenshot observation:** a later attempt displayed a `Collection progress` box
   with one product `preparing` and others `queued`.
4. **Screenshot observation:** another state displayed `WEB_CONTROL_BATCH_NOT_FOUND`
   while five rows were marked `plan ready`.
5. **Screenshot observation:** after another action, the state returned to `PREPARING`.

### E. Quote approval and enrichment states

1. **Owner report:** the owner pressed `Approve Exact Quote` when it was presented.
2. **Screenshot observation:** the UI then displayed `ENRICHING`, the five product
   rows as `plan ready`, and text that the exact quote was approved.
3. **Screenshot observation:** a later state displayed a first product as failed with
   `CLI_EXIT_1`; remaining products were still preparing or queued.
4. **Screenshot observation:** the batch then displayed a stopped/failed message such
   as `Enrichment stopped safely. No automatic retry will be attempted.`
5. **Screenshot observation:** one progress card later showed `No recent worker signal`,
   zero percent, and text indicating that the product source did not return enough
   exact content to complete the item.
6. **Screenshot observation:** another progress card displayed
   `BATCH_ENRICHMENT_STOPPED`, zero completed, one stopped, and provider credits used.

### F. Partial readiness and later attempts

1. **Screenshot observation:** after subsequent checks, at least two Campbell's
   variants were shown as `READY` while other variants remained `DATA MISSING`.
2. **Screenshot observation:** a later collection-progress card contained three
   remaining candidates, not the original five, and moved through `PREPARING`.
3. **Screenshot observation:** another three-candidate attempt eventually displayed
   `CLI_EXIT_1` on one candidate and a failed/stopped batch.
4. **Screenshot observation:** the most recent screenshot attached before this handoff
   showed the three-candidate collection in `PREPARING` with one item preparing and
   two queued.
5. **Question to verify:** query the authoritative current backend state. This handoff
   does not claim the last browser-rendered state is still current.

### G. Refresh behavior

1. **Owner report / screenshot observation:** a forced refresh with `?release=r17`
   opened a blank start form with Amazon selected by default.
2. **Screenshot observation:** a subsequent view without that query showed the prior
   Campbell's prompt and Walmart selection again.
3. **Question to verify:** determine whether these pages were served by the same
   deployment, whether form state came from browser storage, and whether the active
   Product Truth batch identity came from browser state, database state, or both.

## 7. Error/status strings to trace to their authoritative origin

Search the repository, server logs, database records, immutable command artifacts,
and worker reports for the exact strings and associated IDs/timestamps:

- `The Product Truth collection control configuration is invalid. No command was created.`
- `WEB_CONTROL_BATCH_NOT_FOUND`
- `CLI_EXIT_1`
- `BATCH_ENRICHMENT_STOPPED`
- `No recent worker signal`
- `Enrichment stopped safely. No automatic retry will be attempted.`
- `DATA MISSING`
- `READY`
- `preparing`
- `queued`
- `plan ready`
- `ENRICHING`
- `FAILED`

Do not assume that two occurrences of the same UI string represent the same batch,
release, candidate, worker invocation, or failure.

## 8. Independent questions to answer

These are deliberately competing questions, not a preferred theory.

### Release and environment

1. Which Vercel deployment served each relevant request?
2. What Git commit, Git tree, executable-tree digest, release ID, and environment
   variables were active in the web runtime?
3. What exact checkout and release pins were active in the Product Truth worker and
   owner agent at the same timestamps?
4. Were web and worker using compatible batch contracts and the same release-bound
   identity inputs?
5. Did a browser cache or service-worker asset mix expose UI from one release while
   API requests reached another?

### Request and persistence

1. What persistent record represented the owner's five-listing request?
2. Did that record remain the same across readiness, quote, approval, enrichment,
   refresh, and draft generation?
3. Was a new Product Truth batch created on each button press or retry? If so, was that
   intended by the active contract?
4. Where was the current batch ID stored, and what happened when the page refreshed?
5. Did `WEB_CONTROL_BATCH_NOT_FOUND` mean no database record, a release-identity
   mismatch, a user/owner mismatch, an artifact mismatch, or another condition?
6. Could two browser tabs or two overlapping requests update the same client state or
   build state?

### Product selection and Product Truth

1. Which exact donor product IDs were selected for each attempt?
2. Were the five requested candidates exact Campbell's variants, and were any donor
   IDs repeated across attempts?
3. Which fields were missing for each candidate before and after each run?
4. Did a candidate lack exact content, fresh exact local price, both, or something else?
5. Did any price evidence accidentally stand in for content truth, or vice versa?
6. Were strict readiness requirements appropriate for the Walmart category and the
   exact requested product, as defined by the canon?
7. After two candidates became ready, did the consumer correctly preserve them and
   request only the remaining number?

### Worker and provider execution

1. What command artifact corresponds to each quote and approval?
2. Was the approval bound to exactly the command that the worker attempted?
3. What complete stdout, stderr, exit status, audit record, and report artifact sit
   behind each `CLI_EXIT_1`?
4. Did the worker actually start, stop before provider access, consume provider credits,
   receive insufficient evidence, fail to persist evidence, or fail later during audit?
5. Did the worker's fail-closed or stop-on-first-item behavior match the intended
   batch semantics?
6. Was a later queued item prevented from running by the first item's outcome?
7. Was any outcome ambiguous, stale, replayed, or incorrectly eligible for retry?

### Consumer and draft generation

1. Once five candidates are ready, what server action creates the five Walmart draft
   work items?
2. Has that action ever run for this owner request?
3. If it has not run, what exact gate prevented it?
4. Does the finalization path revalidate the selected live shipping template and all
   Product Truth inputs without changing the requested quantities?
5. Are draft creation, UPC reservation, and Walmart publication separate authorities?
6. Can the owner reach a stable batch-review URL after refresh and from another tab?

### Observability

1. Is the UI polling an authoritative server record or reconstructing progress from
   browser state?
2. Does the progress display identify the build ID, child batch ID, attempt number,
   current product, completed/stopped counts, credits used, last worker signal, and the
   next permitted action?
3. Are terminal states stable, or can the page appear to move backward after refresh?
4. Do server logs and immutable audit artifacts allow one click to be traced end to end?

## 9. Candidate patch prepared by Codex — not a diagnosis

### Repository pointer

Codex prepared a candidate change in a separate clean checkout:

- checkout: `/tmp/sscc-walmart-resume.HNIArT/checkout`
- branch: `codex/walmart-new-sku-full-catalog`
- commit: `4a879ef1164a18c9c2a8e5f2f87af0abb9a72594`
- tree: `58a17d52d18047411f49763f1e89c1d6179836d7`
- commit subject: `fix(bundle-factory): make Walmart builds durable`

At the owner's request, deployment work was paused. Do not assume this commit is live.
Independently compare the production deployment with this commit.

### Intended behavior of the candidate patch

The commit is intended to create one persistent `GenerationJob` and one stable build
URL for the complete Walmart preparation flow; attach Product Truth collection attempts
to that parent; require a new exact quote for a paid replacement attempt; recheck Product
Truth after a terminal child state; and create the requested Walmart draft work items
when enough exact products are ready.

That description is the patch author's intent. It is not evidence that the design is
correct, that all routes are reachable, or that it resolves the production failure.

### Files changed by the candidate patch

- `ss-control-center/src/lib/bundle-factory/walmart-durable-build.ts`
- `ss-control-center/src/app/api/bundle-factory/studio/generate/route.ts`
- `ss-control-center/src/app/api/bundle-factory/walmart/builds/[id]/finalize/route.ts`
- `ss-control-center/src/app/bundle-factory/new/[id]/page.tsx`
- `ss-control-center/src/app/bundle-factory/new/page.tsx`
- `ss-control-center/src/components/bundle-factory/WalmartDurableBuildProgress.tsx`
- `ss-control-center/src/lib/bundle-factory/__tests__/walmart-durable-build-ui.test.ts`
- `ss-control-center/src/lib/bundle-factory/__tests__/walmart-product-truth-collection-ui.test.ts`
- `ss-control-center/src/lib/sourcing/__tests__/phase0-containment.test.ts`
- four related canonical Wiki files in the same commit

### Reported local checks

The author reported these local results before pausing the release:

- Product Truth certification suite: 535 passed;
- focused durable/draft tests: 15 passed;
- TypeScript `--noEmit`: passed;
- changed-file ESLint: passed;
- Next.js production build: passed with pre-existing broad warnings;
- `git diff --check`: passed;
- Wiki-Brain: 0 orphans and 0 broken links.

Re-run the relevant checks. These results do not demonstrate that the production web,
database, worker, provider, and browser state behaved as the tests model.

## 10. Suggested independent investigation procedure

1. Read `AGENTS.md`, all canonical documents in section 4, this file, and the raw chat.
2. Do not deploy the candidate patch yet.
3. Preserve the current production evidence: deployment IDs, environment pins, server
   logs, database rows, web-control command/quote/approval artifacts, worker ledger,
   reports, and Product Truth evidence for the relevant time window.
4. Identify every distinct parent request/build ID, Product Truth batch ID, donor
   product ID, quote ID, command digest, approval signature, and worker execution ID
   visible in the evidence. Build a timestamped table.
5. Choose one failed attempt and trace it end to end. Find the first divergence between
   the intended contract and authoritative runtime evidence.
6. Decode `CLI_EXIT_1` using its complete underlying command result; do not diagnose
   from the wrapper label.
7. Separately explain `WEB_CONTROL_BATCH_NOT_FOUND` from its exact admission checks and
   runtime inputs.
8. Inspect the current partial Product Truth state for all Campbell's candidates without
   launching new provider work.
9. Review commit `4a879ef1164a18c9c2a8e5f2f87af0abb9a72594` as an untrusted proposal. Test whether
   it handles the evidenced failure and whether it introduces new contract, authority,
   concurrency, or recovery problems.
10. Report: evidence, confirmed cause or causes, rejected hypotheses, the smallest safe
    correction, migration/release consequences, test plan, and exact owner gates.
11. Only after owner direction, implement and deploy. Do not approve provider spending,
    reserve a UPC, publish a Walmart listing, or mutate Walmart during diagnosis.

## 11. Acceptance criteria for the eventual correction

These are outcome criteria, not a proposed implementation:

1. A single owner request for five pack-of-eight Campbell's drafts has a persistent ID
   and stable URL.
2. Refreshing or reopening the build shows authoritative progress for that same request.
3. Missing Product Truth data produces a visible, bounded plan and an exact quote before
   any paid provider execution.
4. An approved exact quote runs only its bound work and shows useful per-product progress.
5. A stopped or failed product exposes the real actionable reason and does not create an
   unexplained loop of identical button presses.
6. Already-ready exact products remain usable; failed candidates are not silently
   treated as ready or endlessly repeated.
7. Five exact ready variants produce five reviewable Walmart draft listings, each pack
   of eight, with no silent quantity substitution.
8. The owner can review the drafts before any UPC reservation or Walmart publication.
9. No paid action, UPC reservation, or Walmart mutation inherits authority from an
   earlier or different attempt.
10. Web, worker, database, and release evidence identify the same build and compatible
    release contract.

## 12. Short prompt for Claude Code

```text
Проведи независимое расследование сбоя Walmart Bundle Factory. Сначала полностью
прочитай /Users/vladimirkuznetsov/SS Command Center/docs/wiki/walmart-bundle-factory-independent-diagnostic-handoff.md,
затем сырой transcript чата с ID 019f778e-2901-7d00-9e51-4a4cc2164492 по пути,
указанному в handoff, и все обязательные canonical docs из AGENTS.md. Не принимай
ни одну гипотезу или candidate patch Codex как установленную причину. Сопоставь
production release, web/API, БД, batch/quote/approval artifacts, worker и Product
Truth для одного запроса на 5 Campbell's pack-of-8; найди первую доказанную точку
сбоя и объясни повторяющийся цикл. Сначала дай evidence-backed диагноз и план.
Ничего платного не одобряй, не деплой и не публикуй в Walmart без отдельной команды.
```

## 13. Paused state at handoff

- Candidate code is committed and pushed on the branch named above.
- The release/deployment phase was started only as read-only discovery, then paused by
  the owner before a new production release was created.
- No paid Product Truth action was launched as part of preparing this handoff.
- No UPC was reserved and no Walmart listing was published as part of this handoff.
- The authoritative current state of the last production collection attempt still
  needs independent verification.
