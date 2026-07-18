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
- Example: `FK-AS6B-6G25` / `B0H8259J9G` was `Default` with observed floor
  `$64.14`, ceiling `$77.88`, and current `$76.99`, while the sealed launch
  target is `$66.95` / `$76.99`.

This confirms that a correct-looking current Amazon price is not proof that
ChannelMAX has the correct model or guardrails. The baseline is diagnostic
only; no ChannelMAX state was changed.

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
