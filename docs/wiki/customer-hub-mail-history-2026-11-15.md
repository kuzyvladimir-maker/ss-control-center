# Customer Hub mail history repair — 2026-11-15

## Verified fault

The mail source published only a seven-day unanswered subset. The Messages
Sent/Resolved/All tabs still queried the older BuyerMessage importer. Its 66
records included Gid and drawahomtashtari, but not the requested Dave and Diane
conversations. Zero awaiting reply was therefore mistaken for empty history.
Refresh mail status only reread saved state. Process next had no handler.
Several case APIs converted database failures to successful empty responses.

## Contract and implementation

`ops/customer-service/cs_mail_unanswered.py` now publishes schemaVersion 2:
`threads`, `unanswered`, `errors`, `lookbackDays`. It pages through 30 days of
buyer mail and seller-send confirmations, reads message bodies and joins only
exact order IDs within one mailbox. Missing/ambiguous order IDs stay separate.
No same-name-only inference of a sent reply. Sanitized text is cached, not raw
headers or opaque mail footer URLs. Source failures retain previous successful
per-account evidence and mark it stale.

Conversation status: sent if the last message is from the seller; resolved when
the latest buyer thread is explicitly ignored; awaiting_reply within the
existing seven-day actionable window; needs_review for older buyer mail with no
matching reply evidence. Ignore-list resolution is not proof of an actual send.
These are **mail evidence**, never claimed to be Seller Central statuses.

`mail-inbox-rules.ts`, `mail-inbox.ts` and the messages API expose full history.
`MailInboxPanel.tsx` defaults to All, exposes Sent/Resolved/Needs review, and
renders buyer and seller text inside the hub. Process next opens the oldest
pending conversation for review; an empty queue produces an explicit notice.
No customer-send operation is added.

POST `/api/customer-hub/mail-refresh` queues a read-only check in Setting.
The authenticated worker PATCHes running/completed/failed and publishes the
snapshot. UI polls the job and displays failure. Refresh view refreshes saved
API data and labels that distinction explicitly. The existing Linux cron polls
once a minute with `mail-worker.py --scheduled`; collection runs approximately
every 30 minutes or on a user request, under flock. The retired browser cron
remains disabled. No Seller Central, CDP, bridge.ps1 or Windows browser access.

## Honest counters

Live baseline: zero active A-to-z/chargebacks, but 11 stored A-to-z cases and 7
chargebacks across history; stored states were EVIDENCE_GATHERED/DECIDED.
Feedback automatic ingestion is not implemented. The screen now states source,
coverage, stored total and latest record date, with a history shortcut. Failures
produce unavailable/error states rather than invented zeroes.

The old Total losses $429.39 was $305.41 from three stored refund actions plus
$123.976 estimated cost of three replacements, not A-to-z/chargebacks. The UI
now calls this Estimated case costs and shows the calculation; it is not a
verified payment ledger. Store filtering is applied consistently to cost queries.

## Validation

- 94 Customer Service TypeScript tests passed; typecheck and changed-file ESLint passed.
- Five source/parser/grouping tests and two publisher tests passed on Linux.
- React component integration covers All/Sent/Resolved, message text, Process
  next with empty and active queues, failed refresh and successful refresh.
- Read-only candidate scan: 27 conversations, 71 messages, 21 sent, one ignored,
  five older needs-review, zero current unanswered, zero source errors.
- All four requested examples are present. Gid, drawahomtashtari and Dave have
  seller-last evidence; Diane is buyer-last and explicitly ignored.

Deployment and live verification are recorded in the topic 42 completion report.

## Production verification

The production alias `salutemsolutions.info` resolves to the Ready deployment
`ss-control-center-bt3be73lv-kuzyvladimir-makers-projects.vercel.app`.
Authenticated live API checks returned All 27 / Sent 21 / Resolved 1 /
Needs review 5 / Awaiting 0. All four requested orders have nonempty message
bodies; their buyer and seller roles match the source evidence. Latest stored
claim records are from April 12, 2026 — the UI explicitly shows this age.

Read-only publication succeeded at 22:26:06 UTC with no mailbox errors. A real
POST to mail-refresh returned 202/pending; the cron completion evidence lives
in the project runtime folder `data/customer-hub-mail/refresh-proof-*.json`.
`live-history-proof.json` stores the bounded API verification results there.
No real buyer data was added to git.

Visual browser QA was blocked by the browser-control tool failing navigation;
no live button clicks are claimed. React component interaction tests and live
HTTP/worker checks are separate evidence, not a substitute screenshot.

Reproduce source tests on the Linux worker with
`python3 -m unittest mail_history_test mail_worker_test` from the ops directory.
For the UI harness, bundle MailInboxPanel.tsx with esbuild (platform=node,
jsx=automatic, external react/react-jsx-runtime), then run
`node ops/customer-service/mail_ui_test.cjs /absolute/path/to/panel.cjs`.
Install matching React 19 and react-test-renderer in that temporary bundle
folder; production dependencies are not changed by this harness.
