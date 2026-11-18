# Customer Service priority replies and screen reading — 2026-11-18

This follow-up supersedes the access/authorization snapshot in
`customer-service-screen-authority-2026-11-18.md`. Owner message 1625 and task
20261118T190336Z-c8d409 authorized replies to both MJ and Kathleen.

## Buyer outcome

Both full branches were read on the existing Salutem Solutions Windows VPS,
using Windows App and native screen interaction, without CDP/debugging.
Each order's delivery popup was checked independently before one Send click.

* MJ 112-8162702-1044245: FedEx 384615887118, Amazon delivery event Nov 15,
  10:38 AM PST, Westminster CA. Reply submitted about 19:17 UTC.
* Kathleen 113-2972988-7474644: UPS 1Z29K3Y40334555967, Amazon delivery event
  Nov 12, 7:18 AM PST (10:18 AM EST), Hoboken NJ. Reply submitted about 19:21 UTC.

Each reply states its own tracking facts, asks the buyer to check the delivery
location/receiving staff, and directs unresolved delivery review to Amazon
Customer Service without promising a refund or outcome. Signature Salutem Solutions.
No refund, replacement, or repeat send was performed.

Both exact texts persisted after reopening/reloading in Sent Messages. Processing
Response disappeared; each branch displayed Open. This proves a seller reply,
not buyer receipt/read or resolution. The Amazon UI time was one hour ahead of ET;
audit timestamps use UTC independently. Exact replies and verification observations
are stored in the execution journal; local audit artifacts are under
ss-control-center/data/cs-priority-20261118/ (not committed).

## Permitted screen path and limitation

Windows App saved device SS -> existing Salutem Chrome session -> Messaging.
The self-signed RDP certificate was compared with the RDP listener certificate
obtained over authenticated, encrypted WinRM. SHA256:
FFEDD80E08EE13D0AB30AF4A969E4B768F1163853532D3B47B027E59D6A6C1BF.
The UI fingerprint matched. Always trust remained unchecked. No profile, browser
security, remote debugging or paused cron was enabled.

A competing ss-hands-rdp.service repeatedly displaced the native session (0x5).
Its process was temporarily paused while reading/replying. Another process
restarted it at 19:24:22 UTC, causing a new disconnect. Exclusive RDP ownership
is necessary: coordinate handoff, verify the same certificate, open the correct
account, read the complete Response needed list and the separate metrics, then
POST reviewed evidence to /api/customer-hub/screen-inbox. A timer or cached
screenshot is never evidence of a new check. Manual repeated reads are supported;
an unattended screen collector is not claimed as verified.

## Hub corrections

* A-to-Z, chargebacks and feedback current counters are null/Not verified until
  a live authority exists. Historical imports and losses remain available separately.
* Blocked tasks are collapsed under technical details, grouped by order. Order
  114-2471869-1927461 has two different historical SEND task IDs, approved on
  Oct 26 and Nov 2; the repeated rows were not proof of two current customers.
  No historical task is deleted or silently marked sent.
* Authenticated PUT /executions records manual execution evidence, never sends.
  Exact-body SHA256, account/order, fresh post-attempt in-thread evidence, reload,
  and processing completion are required for sent_verified. Prior instruction
  history and reasons are retained. A verified attempt is idempotent and cannot
  be downgraded/replayed. Pending attempts cannot be replaced with a new body/ID.
* Screen snapshots retain a 60-minute TTL; missing/stale authority yields null,
  not a current zero. Response needed and Reported unresolved remain independent.

Tests cover evidence rejection, wrong branch/body, pending replacement, replay,
history preservation, collapsed UI grouping and refresh, plus existing CS suites.
