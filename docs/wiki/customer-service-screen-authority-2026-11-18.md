# Customer Service: screen authority and blocked sends — 2026-11-18

## Correction to Nov 15 design

Mail is history, NOT a Seller Central queue. This supersedes the mail authority
in the Nov 15 reports. No ignore-list edits, history deletion or reclassification
is used to force the current count down.

| Consumer | Current authority |
|---|---|
| Hub stats, heading, KPI and Process next | screen-inbox, unknown without evidence; Process next cannot execute sends |
| Dashboard Cases open / sidebar attention | Response needed only, nullable; never sum other metrics |
| open-threads API, cs_open_threads, cs_inbox_status | fresh account-bound screen snapshot only |
| messages API active / MCP messages_list unread | screen metrics; unread is independent from Response needed |
| mail-inbox / historical messages | explicitly historyOnly, never current queue |
| createCard / pendingCards / markPublished | fresh membership AND matching screen provenance; old mail cards blocked |
| card urgency | screen Over SLA and deadline only, no email age inference |
| owner digest | rejects any source except fresh seller_central_screen |
| SEND completion | exact approved body/account/order bound in-thread screen confirmation |

The screen snapshot contract uses Setting cs_seller_screen_v1, store 1,
Salutem Solutions, source seller_central_screen, method screen_read, observedAt,
evidenceRef and independent unread/responseNeeded/overSla/reportedUnresolved.
A complete Response needed list must match its count. After 60 minutes current
metrics become null and threads empty; lastSuccessfulCheckAt is retained.
Historical mail and historical screenshots never fill a missing current snapshot.
Authenticated POST /api/customer-hub/screen-inbox accepts reviewed screen evidence;
GET exposes freshness. No screenshot has been fabricated or imported as current.

## Actual screen access check

The server has Xvfb :92 and a matching FreeRDP process for Salutem. Process
presence is NOT proof of a readable/authenticated Seller Central page. Through
the supported computer-use tool, Windows App has saved device SS. Opening it
reached an unverified-root RDP certificate warning for 209.208.63.54. Connection
was cancelled; no certificate exception, Chrome profile or debugging change.
A trusted/verified RDP connection is required before an actual screen snapshot
can be captured and reviewed. No current queue count is claimed.

## Execution safety and continuity

SEND transport is explicitly disabled until a permitted screen-only executor
is verified. list/claim cannot start SEND, including previously paused work.
Approval is retained, not reported as delivery. The executions API/UI exposes
approved / pending / blocked / sent_verified. Legacy DONE without the new proof
is reported blocked, not verified. Unknown/failed work is never requeued.

DONE requires result.sentVerification: source, method, storeIndex, orderId,
SHA256 of the exact approved body, observedAt after claim and within one hour,
sellerMessageVisible=true and evidenceRef. Completion and the deterministic
outgoing row are transactional. Repeat completion is idempotent; a different
body cannot bypass an unresolved send for the same order. Email confirmations
no longer mark a case sent or cancel its unfinished SEND.

MJ 112-8162702-1044245: the owner reports «шли» on Nov 17, without verified send.
Record an idempotent blocked execution intent using the Nov 18 task as provenance;
this is NOT a runnable send task and has no invented final text. Kathleen has
no owner approval in this task; do not create one. Existing history is retained.

## Validation and operational boundary

102 Customer Service tests (including unknown, stale, mail 27 isolation,
2 Response needed vs 1 unresolved, exact-body proof, repeat completion/claim),
3 digest tests, mail-history UI isolation and screen-panel unknown/fresh/stale
interaction checks. Typecheck and changed-file lint; production API/MCP checks
after deployment. The old CDP cron remains disabled. No customer send is
performed by this repair. Runtime evidence and MJ journal readback are reported
in topic 42; the screenshot/access limitation remains an explicit blocker.

## Production verification

Live API and MCP returned source seller_central_screen, state unknown, all four
metrics null, no current threads and no actionable pending cards. MJ blocked
intent was persisted once and a repeated request returned the same record.
Native Chrome UI inspection confirmed the unknown heading and four unknown
metrics, separate mail history, and the blocked MJ intent. Process next displayed
the explicit suspended notice without sending. Refresh view reads screen authority;
Refresh mail history only updates history. The RDP certificate blocker remains.
