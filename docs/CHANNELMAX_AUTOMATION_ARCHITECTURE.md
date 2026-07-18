# ChannelMAX automation architecture

Status: the durable control plane and exact-account read-only iMac worker are
implemented. Live ChannelMAX mutation is disabled until a separate finite
upload/export/reconciliation executor and every mutation gate in this document
are verified end to end.

## Read-only live baseline (2026-07-18)

The existing authenticated Chrome tab was inspected without clicks, field
changes, navigation, downloads, or uploads. The page's own authenticated
Angular `WebAPI` service returned the following baseline for the Salutem
Amazon US account:

- 164 active launch-pattern Uncrustables SKUs were present and all reported
  repricing status `LIVE`.
- 162 rows were still on ChannelMAX `Default` (no explicit model ID).
- Only two rows had `Manual min/max`, whose observed model ID is `59021`:
  `VC-ASV1-378P` and `VN-AS1A-D572`.
- 116 rows had a positive current price; 48 returned zero or no current price.
- The approved 162-row assignment intentionally differs from the 164-row live
  baseline because the launch-aware plan excludes the two catalog-blocked
  rows (`TY-AST2-JE9P` and `VN-AS1A-D572`).
- The exact ChannelMAX snapshot also exposes a third, different safety issue:
  sealed v10 maps `SZ-ASPI-JFAT` to `B0H776M5B5`, while ChannelMAX reports
  `B0H75VN18Z` for that SKU. Until resolved or excluded by a newly sealed plan,
  the current 162-row file is not an exact live-identity match.
- Example: `FK-AS6B-6G25` / `B0H8259J9G` was `Default` with observed floor
  `$64.14`, ceiling `$77.88`, and current `$76.99`, while the sealed launch
  target is `$66.95` / `$76.99`.

This confirms that a correct-looking current Amazon price is not proof that
ChannelMAX has the correct model or guardrails. The baseline is diagnostic
only; no ChannelMAX state was changed.

The offline production preflight further proves that the 162 target rows start
as 161 `Default` and one `Manual min/max`. Existing operations can upload a
numeric model ID, but no finite, tested operation restores `Default` (null
model). Capturing old bounds is therefore insufficient rollback evidence: a
failed batch could restore numbers while leaving 161 SKUs on the wrong model.
The mutation lane remains fail-closed.

## Bounded same-model canary

The finite write protocol is implemented only for `VC-ASV1-378P` /
`B0H786L5MW`, the sole target already on `Manual min/max [59021]`. Forward is
the exact 103-byte TSV SHA-256 `b3bb356eedc232bca2cd3d92f095e1b31606f3780ec93f6e9af1004b8a9c495a`
(`$219.57 / $252.99`); rollback is the exact 103-byte TSV SHA-256
`0a7f74822194fd8f4bd0f5aaec70b549875ba922dd618834aba5117cc4a9d932`
(`$251.32 / $289.28`). Neither artifact contains another SKU or changes model.

The protocol validates the real-admin approval and exact job digests, requires
one attempt, verifies the account/site and same-model prewrite state, accepts
only an exact one-row Analyze preview, records one acknowledged mutation fence,
submits once, verifies TaskID/counts plus a managed postwrite snapshot, and
makes ambiguity terminal. Forward and rollback remain separate approvals.

This is not yet a callable production browser worker: the canary release flag
and global mutation release flag are false, the finite CDP adapter is a
deterministic disabled skeleton because no reviewed File Uploader DOM evidence
or selectors are pinned, the protected canary artifact endpoint is implemented
but not deployed/probed from the worker, and rollback cannot yet be
pre-approved in a dependency-blocked state. Those gaps must close before the
owner ceremony; they do not authorize any Default-row or 162-row rollout.

The disabled adapter contract is implemented in
`uncrustables-same-model-cdp-adapter.ts`. It binds the exact account/site,
`VC-ASV1-378P` / `B0H786L5MW`, both 103-byte artifact hashes, one-row Analyze
shape, maximum one Submit, TaskID syntax, and postwrite row identity. Its only
implemented file operation writes the already verified sealed bytes to a
fresh 0600 temporary file, reads them back by SHA-256, and always removes the
workspace. The future file-input step is restricted to the hardened
`cdp_browser.py upload_file` command with `--allowed-root` and
`--expected-sha256`. All selector and fixed-expression slots are deliberately
`null`, and every browser-port method fails with
`PINNED_DOM_CONTRACT_MISSING` before a process or CDP call.

The artifact wire contract is authenticated `GET` only under
`/api/openclaw/channelmax/canary-artifacts/<exact-sha256>.txt`. Its allowlist has
exactly the forward SHA `b3bb356eedc232bca2cd3d92f095e1b31606f3780ec93f6e9af1004b8a9c495a`
and rollback SHA `0a7f74822194fd8f4bd0f5aaec70b549875ba922dd618834aba5117cc4a9d932`.
Each response is exactly 103 bytes with media type
`text/tab-separated-values`; unrecognized names, query variants, missing or
invalid auth, and all non-GET methods are rejected.

## Decision

SS Command Center is the durable control plane. A small always-on worker on the
owner's iMac is the execution plane because the authenticated ChannelMAX Chrome
profile lives on that machine.

```text
Codex / Jackie / SSCC web UI
             |
             v
  durable ChannelMAX job queue
  plan hashes, leases, events, evidence, approval
             |
             v
  iMac ChannelMAX worker (JACKIE_API_TOKEN)
             |
             v
  dedicated signed-in Chrome tab -> selling.channelmax.net
```

OpenClaw is an optional supervisor and notification channel. It is not required
for queue durability, browser correctness, or approval.

## Responsibilities

### SS Command Center

- Builds and seals the exact requested plan.
- Stores jobs and append-only events in the database.
- Issues short leases and prevents two workers from operating the same
  ChannelMAX account/browser concurrently.
- Enforces idempotency and duplicate-plan protection.
- Stores immutable, content-addressed evidence and verifies byte size/SHA-256.
- Shows status and evidence in the web UI.
- Allows cancellation before the mutation fence.
- Requires fresh independent owner step-up approval for mutation.
- Never treats ChannelMAX as authority for Amazon base price or sale price.

### iMac worker

- Uses the existing `JACKIE_API_TOKEN`; no new OpenClaw token is required.
- Polls the deployed SS Command Center and claims only allow-listed operations.
- Defaults to read-only capabilities.
- Controls only one uniquely identified `selling.channelmax.net` tab.
- Is bound to account `channelmax:amznus:salutem-solutions`, ChannelMAX SiteID
  `300`, and selected label `AmznUS [Salutem Solutions]`.
- Stops for login, 2FA, CAPTCHA, unexpected UI, ambiguous results, lease loss,
  or evidence-upload failure.
- Sends heartbeats and structured events while working.
- Never blindly retries an operation after a possible mutation.

### Codex and Jackie

- May create read-only audits and inspect status/evidence.
- May prepare a mutation plan, but cannot approve it.
- May not turn an ambiguous mutation into success.
- May not bypass the durable queue with a direct browser-write prompt.

## Job lifecycle

Read-only:

```text
QUEUED -> RUNNING -> SUCCEEDED | FAILED
```

Mutation:

```text
PENDING_APPROVAL -> QUEUED -> RUNNING
                 -> mutation fence
                 -> CONFIRMED_APPLIED | CONFIRMED_NOT_APPLIED | AMBIGUOUS
```

Mutation approval is bound to the full canonical subject: job, operation,
account, model, row count, assignment artifact SHA-256, payload SHA-256,
request SHA-256, nonce, expiry, and a one-use human step-up assertion. Bearer
tokens and synthetic identities cannot approve.

## First production workflow

1. Run a read-only capability/login and exact-account check.
2. Capture the 164-row active Uncrustables snapshot and record the exact Manual
   repricing model ID/name (`59021`, `Manual min/max`).
3. Store the screenshot and canonical inventory JSON as immutable baseline and
   rollback evidence.
4. Compare all 164 active launch rows with the owner-approved manifest. The
   sealed assignment currently contains 162 rows and must separately account
   for the two intentionally excluded catalog-blocked SKUs.
   Any SKU/ASIN mismatch, including the current `SZ-ASPI-JFAT` mismatch, blocks
   the exact batch rather than being silently keyed by SKU alone.
5. Prepare one small immutable canary assignment.
6. Owner reviews the rendered diff and re-authenticates in SS Command Center.
7. Worker uploads exactly the approved bytes once.
8. Capture Analyze result, upload TaskID/receipt, post-upload export, and a
   delayed observation showing ChannelMAX did not move the Amazon base price.
9. Expand only after the canary reconciles without ambiguity.

## Mutation prerequisites

No ChannelMAX upload is allowed until all are true:

- Queue, lease, account/browser mutex, cancellation, and reconciliation tests
  pass.
- Worker can target exactly one expected HTTPS host/tab.
- Upload source is restricted to a job workspace and matches the approved hash.
- Before/after evidence bytes are stored and server-verified.
- Fresh owner step-up approval is consumed atomically.
- `MUTATION_STARTED` is recorded before the irreversible UI action.
- Success requires a consistent ChannelMAX receipt and exact processed/success
  row counts; contradictory outcomes become `AMBIGUOUS`.
- A rollback artifact exists and has been independently verified.
- A one-row round trip has proved that the finite executor can restore both the
  exact previous bounds and ChannelMAX `Default` model semantics; a blank,
  omitted, or caller-invented model value is not proof.
- Every target SKU/ASIN pair matches the fresh exact-account prewrite snapshot.

## Rollout

1. Deploy the queue/API and web status view with mutation feature flag off.
2. Install the exact-account iMac worker as a supervised service and run only
   `SNAPSHOT_INVENTORY` / `DISCOVER_MANUAL_MODEL` jobs.
3. Verify heartbeat, reconnect, lease expiry, cancellation, and evidence paths.
4. Enable password re-auth or WebAuthn/TOTP step-up for owner approval.
5. Implement and independently review the finite mutation executor; it must not
   expose arbitrary JavaScript, selectors, browser commands, or caller-chosen
   files.
6. Enable a one-row canary only.
7. Enable bounded batches after the canary and delayed observation pass.
