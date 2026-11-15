# Customer Service: Amazon mail replaces the browser inbox bridge

Owner scope: 2026-11-15, topic 42. Chrome/CDP inbox scanning is permanently
prohibited. No Seller Central access and no customer messages during this work.

## Authority and coverage

The server runs the existing `scripts/cs_mail_unanswered.py --json` with its
existing `.secrets/gog_cron.env`. Its ignore file `memory/cs_mail_ignore.txt`
remains owned and interpreted by that source; the hub does not duplicate it.
The source returns account, buyer, date, subject and Gmail thread ID. It searches
four Amazon mailboxes for the last seven days and matches later reply notices
by buyer name. This is **mail-derived status**, not Seller Central Response Needed.
The source currently limits each search to 100 threads; older/omitted mail and
same-name reply matching are source limitations, not proof of no pending cases.

The hub keys membership by **account + thread**, never buyer name or an inferred
order ID. Existing case/card links require an exact `storeEmail + gmailThreadId`
match. A local SENT card cannot silently remove a thread still returned by the
source. Unlinked threads remain visible, with the original subject and mail link.
Metadata is not fabricated into a buyer-message body or used to generate a reply.
Normal Gmail content ingestion and the existing explicit approval flow remain
separate. Absence from mail results does not fabricate `responseSentAt` or
“closed in Amazon”. Walmart, eBay and TikTok are explicitly **Not covered**.

## Implementation

- `mail-inbox-rules.ts`: snapshot validation, per-account success, partial failure,
  deduplication and monotonic checks. Missing/failed/>=60-minute evidence makes
  the complete count unknown, not zero. Retains the last successful timestamp.
- `mail-inbox.ts`: atomic Setting `cs_mail_inbox_v1`, thread/card joins. No schema
  migration. Failed accounts retain previous evidence but cannot expose old rows
  as current actionable items. Successful accounts remain visible on partial runs.
- `POST /api/customer-hub/mail-inbox`: authenticated snapshot ingestion;
  GET exposes current coverage, timestamps and source threads to authenticated users.
- `inbox-watch.ts`: `cs_open_threads` and `cs_inbox_status` now use mail authority.
  Reconciliation only retires browser-scan tasks; it never queues a browser task.
- `cs-tasks.ts`: `INBOX_SCAN` excluded from listing, claim and completion.
- `ops/customer-service/mail-worker.py`: source invocation and snapshot publication,
  no WinRM/CDP/Chrome dependencies. Source failure becomes explicit account errors.
  `scan-worker.py` is an inert error stub; old bridge assets are historical only.
- Hub awaiting-reply list, headline/KPI count and dashboard count now use mail
  evidence. Last successful check is visible separately from browser refresh time.
  A refresh button refreshes the view, not the timestamp of source observation.

## Operations

Install mail worker as `/root/.openclaw/workspace/scripts/cs_mail_publish.py`.
Use a **new** half-hour cron marker `SSCC_MAIL_INBOX`, flock
`/tmp/cs-mail-inbox.lock`, log `/var/log/cs-mail-inbox.log`.
Never enable `SSCC_STORE1_INBOX_SCAN`; its paused cron remains paused. Do not
start/stop/reconfigure Windows Chrome, scheduled tasks or the Telegram listener.
Credentials are loaded only from existing `.secrets/gog_cron.env` and
`.secrets/cs_scan.env`; none are logged. Last published evidence is stored in
`data/customer-hub-mail/last-published.json` on the server.

## Verification

Real source check on 2026-11-15: `unanswered=[]`, `errors=[]` when run with the
configured cron environment. Without that environment all four accounts return
access errors; this verified why errors must never become an empty success.
92 Customer Service tests and two Python worker tests pass, including empty
success, partial and full failure, stale evidence, repeat/out-of-order snapshots,
account/thread identity and disabled browser task listing. TypeScript and ESLint
checks pass. Deployment and live ingestion readback are recorded in the final
operator report; no synthetic mail rows are inserted into production.

This supersedes the browser-scanning sections of
[[customer-service-scan-learning-2026-11-06]] and [[customer-hub-inbox-watch]].
