<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Product Truth Platform — mandatory project canon

Before changing sourcing/enrichment, `DonorProduct`, `DonorOffer`, `SkuComponent`,
`SkuCost`, Bundle Factory, listing improvement, Economics, Pricing, or Procurement,
read the workspace-level instructions in `../AGENTS.md` and these documents:

- `../docs/wiki/product-catalog-architecture.md` — OWNER CANON.
- `../docs/wiki/donor-catalog-execution-roadmap.md` — current execution plan and gates.
- `../docs/wiki/enrichment-division-of-labor.md` — one-writer enrichment contract.
- `../docs/wiki/product-truth-operator-runbook.md` — the only operator workflow;
  matcher replay v2.2 is wrapper-only, never a direct runner invocation.
- `../docs/wiki/product-truth-matcher-replay-v2.md` — honest eight-input post-blind
  Gate 1 provenance and the exact sealed offline command.
- `../docs/wiki/product-truth-consumer-cutover.md` — required staged consumer cutover;
  exact manifest/DB binding, set-based parity, shadow first, no legacy fallback.
- `../docs/wiki/product-truth-release-scope.md` — exact Git boundary and mandatory
  clean-checkout acceptance gate before Claude Code may operate the engine.

If local code or an older document conflicts with the OWNER CANON, surface the
conflict and align the implementation before extending it. Paid enrichment,
harvest-cron activation, delisting, repricing/min-max, publication, and purchasing
remain explicit owner-gated actions.

For the Walmart new-SKU pilot, Claude Code may run only the frozen operator commands
listed in `../docs/wiki/walmart-new-sku-operator-runbook.md`. The database-writing
`walmart:new-sku:schema` and `walmart:new-sku:catalog` activation surfaces are
owner/Codex-only and require their own exact external approval; they are never an
operator workaround for a blocked doctor.

The self-contained frozen-release allowlist is exactly:

- `npm run walmart:new-sku:release -- verify ...`;
- `npm run walmart:new-sku -- doctor|plan|stage|rotate-upc|certify|dry-run|approve|apply|verify ...`, using only engine-emitted exact arguments.

Certification evidence follows the same no-manual-hash rule: Claude runs
`certify --mode template`, fills only the permitted human TODO decision/evidence
fields, and then runs that invocation's emitted `certify --mode seal-evidence`.
The engine alone resolves and hashes every local evidence artifact and writes a new
sealed certification input; Claude never edits its SHA-256/byte-size fields, sealed
output, plan/stage/policy binding, code, policy, schema or migration.

When `verify --mode status` emits a pending buyer-evidence worksheet, Claude may
replace only its TODO/null observation fields and absolute screenshot path. It must
then execute the emitted `verify --mode seal-evidence` command with the exact
certification and immutable verify receipt. The engine alone writes
`rawEvidence.artifact.sha256`; Claude never computes or edits that digest, the sealed
output, or the receipt/attempt/item binding.

Verify receipt `walmart-new-sku-verify-receipt/1.1.0` and the immutable submission
ledger bind one exact certification SHA, payload SHA, seller-account fingerprint,
deterministic idempotency key and attempt ID. The verify-specific poller checks that
same active attempt before any Walmart GET and again transactionally before lifecycle
updates. A repeated initial verify may issue a new receipt-bound worksheet filename;
Claude must use only the exact worksheet/receipt pair in that invocation's
`next_argv`, never mix pairs or reuse a path manually. The same rule applies when a
later non-LIVE verify issues a refresh worksheet for stale or nonqualifying evidence;
the old sealed evidence is never edited.

Those commands run only from the issued, verified
`/ABSOLUTE/RELEASE/release`, never from this mutable source workspace. Immutable run
outputs must use an external absolute writable artifact root; the read-only release is
not an output directory. The separate prerequisite `TARGETED_WALMART_EVIDENCE` carve-out
may use only the verified frozen Product Truth CLI and exact commands authorized by
`../docs/wiki/product-truth-operator-runbook.md`.

The source boundary is `walmart-new-sku-source-release/3.2.0`, the frozen manifest is
`walmart-new-sku-frozen-source-release/2.1.0`, and the runtime dependency policy is
`walmart-new-sku-runtime-dependency-closure/1.1.0`. The sealed source exclusion omits
ambient `.DS_Store`; frozen verification rejects it as topology drift. This is not a
claim that an embedded-secret scan ran.

The machine-interpreted compliance artifact is the structured POLICY_REVIEW. Raw
seller-health, category-approval, recall and brand-rights files are byte/provenance
bound but still require real human/owner review. The pinned six-domain screen is
necessary and fail-closed, not a guarantee that the changing Walmart policy universe
is exhaustive.

In that operator role Claude Code must not edit or create code, scripts, policy files,
tests, schema or migrations; run SQL, `curl` or direct marketplace/provider calls;
invoke `walmart:new-sku:schema`, `walmart:new-sku:catalog`, owner-permit assembly or
release freeze; bypass `next_argv: null`; retry an unknown/ambiguous submission;
create a cron/schedule; or expand beyond the separately owner-permitted one-SKU run
and the release-wide two-SKU pilot cap. A blocked command is handed back to
owner/Codex; it is never repaired inside the frozen release.

An accepted-state re-invocation/readback after a known accepted feed ID is not a retry
of an unknown POST. For any unknown/ambiguous outcome, the current release permits only
`verify` and manual reconciliation; a new POST would require a separately implemented,
reviewed and certified recovery release plus a fresh exact owner gate.
