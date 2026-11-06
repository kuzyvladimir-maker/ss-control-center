# Customer Service: authoritative inbox, quiet topic, owner learning — 2026-11-06

Owner scope: Telegram topic 42, only Amazon store 1 / Salutem Solutions. Other
stores remain disabled until the owner re-enables them. No buyer reply or refund
was sent/executed during this change.

## 1. Inbox: facts and correction

The initial claim “INBOX_SCAN never ran” was not exact: Turso contains a DONE
scan from 2026-11-01 21:36 UTC; its successor stayed QUEUED from 22:20 UTC.
Other stores also had stranded queued scans. Absence from Response Needed did
not close hub cases at all.

The full, read-only scan at **2026-11-06 14:27:08 UTC**, finished 14:28:46,
read **2 Response Needed and 743 Resolved** threads, following every `nextToken`.
It re-read Response Needed at the end and checked that membership/update times
had not changed. Browser requests ran on the Salutem account's own Windows VPS.

- Dee / `112-4952260-7430602`: deadline 2026-11-06 21:41:41 UTC; topic card 1039.
- Scott / `111-9633582-9233033`: deadline 2026-11-06 22:34:37 UTC; topic card 1043.
- Sandra / `112-8867440-4276233`: Amazon `SOLVED`, resolved timestamp
  2026-11-05 04:31:40 UTC. Card **989** (`cmw22ho5e000j08kzhsmjdqf6`) became
  `SUPERSEDED`; BuyerMessage became `RESOLVED` / `CLOSED_IN_AMAZON` with the
  scan source and timestamp in `resolution`. `responseSentAt` remains null:
  closing in Amazon is not fabricated evidence of a sent reply.

Machine readback: open=2, errors=[], alertCardId=null, both confirmed threads
have their Telegram links and `stale=false`. Evidence is in the ignored local
`ss-control-center/data/customer-hub-audit-20261106/{scan.json,applied.json}`.

Implementation: `config.ts` has the active store list; ingest, cards, task
claims/queueing, pipeline and cancellation notices honor it. `cs_open_threads`
uses scan membership, not inferred DB membership; an absent or >60-minute scan
sets `stale=true`. `cs_inbox_status` reports unknown (`null`) unanswered count
when stale. Actual Amazon deadlines are retained.

Only a complete, correctly identified two-folder scan may close absent cases.
Messages received/changed after observation and a claimed SEND are protected.
Malformed results fail closed; old outstanding threads remain covered even
outside the usual seven-day lookback. No Amazon state-changing call is made.

## 2. Quiet topic

Alert generation is deleted, including overdue/card_stale/inbox-not-checked.
Pending legacy alerts were superseded; `cs_cards_pending` also filters them.
New buyer reply cards and their approval flow remain active. Reminder ownership
moves to the owner's four-hour cron using `cs_open_threads`.

## 3. KB audit: included / missing / fixed

### Three latest cards at audit start

Raw historical user prompts were recovered from the subscription worker's
Claude session logs, not reconstructed from today's KB. Copies stay in the
ignored audit directory (`historical-prompts.json`, `last-three-before.json`,
`kb-evidence.json`).

| Card | Evidence of KB use | Matrix evidence and limits |
|---|---|---|
| `cmw46ge4c000j08jkxyrz7yej`, Betty, 23:29 UTC 05.11 | Final supplied-text version, matching stored `editedResponse`; no separate analyzer prompt found for this version. Do not pretend the prior version's prompt belongs to it. | Inherited reasoning cannot prove another model call. New supplied-text cards explicitly expose `draftSource=owner_verbatim`. |
| `cmw455o7p000c08jkiqlgtf7l`, Betty, topic 1047 | Actual user prompt at 22:50:56 UTC, session `caa86d6d-5c0e-4dbd-9e14-64910e833bd2`: four examples below. **Included.** | Stored reasoning names Table D / cancel in transit and carrier-delay/window-open rules. The exact historical system prompt was not retained. |
| `cmw44r9w8000808jkz8th2tes`, Scott, topic 1043 | Actual user prompt at 22:40:54 UTC, session `c089574b-3565-442a-ab1d-68d349ac9987`: four examples below. **Included.** | Stored reasoning names Table B / physical damage, photo request and claims-protected carrier damage. The exact historical system prompt was not retained. |

Betty KB IDs actually in the prompt:

- `cmvg28s640036agfz0c0f056z` — T3, unsuccessful carrier delivery / Amazon review.
- `cmvg28nic000vagfz07pb4rhg` — T10, cancellation after delayed delivery.
- `cmvg28o2o0015agfz1rnpmvf4` — T11, food return / condition clarification.
- `cmvg28sdd003aagfz28ia1jta` — T3, late delivery / buyer no longer needs it.

Scott KB IDs actually in the prompt:

- `cmvg28ok1001cagfzl7ndxd5k` — T5, smashed sandwiches / photos.
- `cmvg28q420027agfzprzj4xdq` — T5, packaging explanation.
- `cmvg28ruh0031agfze4rlb0r2` — T5, leaking product / historical refusal.
- `cmvg28v12004lagfz7v1peti3` — T5, damaged product / photos.

Thus retrieval was **working**, not empty. However, old examples and voice guide
still promoted apologies and “Customer Support Team”, contrary to today's
instruction. Current rules now override those historical patterns; examples'
apologies are removed in the injected response text, full examples are no
longer cut to 600 characters, and tone/sign-off are enforced before sending.

**Missing then / fixed now:** exact system+user prompt, KB IDs, retrieval result,
injected matrix rows, owner rules and provider attempts are persisted under
`Setting cs_prompt:<id>`, linked from newly generated cards and readable through
`cs_card_audit` (`include_prompt=true` for full dumps). An unavailable historical
record is reported as unavailable, never reconstructed and labeled original.

Controlled generation on Scott's stored facts completed through Claude on
06.11: audit `cs_prompt:814d6c1f-d8f2-4c35-9893-b4aa8d157b40`, four T5 examples,
48 injected matrix rows, action `clarify`, reply policy passed. This was a
controlled replay, not the historical card prompt and not a buyer send.
The raw evidence is `controlled-analysis.json`.

### Learning loop

Before: approvals were inserted as KB rows without deduplication and always
said “without changes”; wrong/rework comments were saved as rules, but the
final owner-supplied text did not immediately become a durable example.

**Fixed:** one deterministic KB key per buyer-message situation, updated across
card versions/retries; final answer, matrix type, situation and owner comments
are saved together, tagged `owner-approved` or `owner-corrected`. Relevant
corrected examples rank ahead of approved and older imported examples. Rule
comments also have deterministic deduplication keys. `cs_card_set_reply` and a
wrong/rework with explicit `override_text` learn the supplied final text without
sending it. A comment without final text remains a correction rule; the
rejected/model-generated draft is not falsely labeled owner-approved. Approval
then records the final text and accumulated comments before queueing SEND.

Live verification using Betty's already-sent final owner text: two saves created
one row `cs-owner-cf54a4869d5e496b69b23cadd187f89e`; its tag is `owner-corrected`
and it ranked first on a fresh retrieval for that situation. No fake test
examples or messages were inserted into production.

## Safety and validation

No apologies or fault admissions; exact sign-off **Salutem Solutions**.
Refund promises above $50 (or unknown amount) require an explicit owner refund
decision; otherwise drafts ask the owner internally. The autopilot only records
recommendations, and SEND queueing requires explicit owner authorization.
The existing one-attempt/unknown-result behavior is preserved.

Validation: 62 Customer Service tests, 3 browser-scanner tests, TypeScript and
ESLint. Live complete scan, Sandra readback, learned-example deduplication and
retrieval, and a completed subscription generation with an exact prompt dump.

## Operations

Source: `ss-control-center/ops/customer-service/`.

- Windows task `SalutemCsScanBridge`: persistent CDP connection to the existing
  authorized Chrome instance; own background inbox tab. Listener bound only to
  `127.0.0.1:9230`; WinRM transports the request from the existing server.
- Server worker `/root/.openclaw/workspace/scripts/cs_inbox_scan.py` claims only
  `INBOX_SCAN` store 1, performs read-only browser GETs, stores proof, then
  completes the task through MCP. It never invokes SEND tools.
- Server cron: `*/30 * * * *`, flock `/tmp/cs-inbox-scan.lock`, marker
  `SSCC_STORE1_INBOX_SCAN`; log `/var/log/cs-inbox-scan.log`.
- Proofs on server: `/root/.openclaw/workspace/data/customer-hub-scans/`.
- The bridge retains Chrome's allowed connection between runs. A browser restart
  or expired Amazon login can require a new local approval/login; failures are
  marked FAILED/stale, never interpreted as an empty inbox. The Telegram
  listener was not restarted.
- A temporary alternate browser profile was tested, did not preserve login,
  and was removed. The live scanner uses the original authorized profile.

Related: [[customer-hub-inbox-watch]], [[customer-hub-vps-send]],
[[customer-hub-owner-playbook]], [[customer-hub-decision-engine]].

## Production verification

Production MCP worker completed scan task `cmw52n33d0000wkfzso1ejg0a`: observed at 2026-11-06T14:48:03.918Z, 2 Response Needed and 743 Resolved. Production `cs_open_threads` returns only store 1, Dee and Scott, scan time and Telegram links; pending cards contain no alerts. Scheduling uses half-hour UTC slots (not a sliding 30-minute interval that could skip a cron tick after transport latency).
