# Customer Hub: evening audit, 18 November 2026

## Scope and outcome

Owner task `20261118T230956Z-63a2ae`. Read-only Seller Central inspection on the Salutem SS VPS via Windows App and CUA; no CDP, browser-profile changes, sends, refunds, or case-status changes. Existing verified replies were not repeated. This is **not a declaration of autonomous collection readiness**.

Two actual manual screen cycles were accepted and reread from production:

| UTC / America-New_York | Response needed | Over SLA | Reported unresolved | Unread |
|---|---:|---:|---:|---|
| 23:20:26.004Z / 18:20:26 EST | 2 | 0 | 1 | unknown |
| 23:21:26.566Z / 18:21:26 EST, after browser refresh | 2 | 0 | 1 | unknown |

Both lists: Mary `113-2368331-6725010`, Sharon `114-8686665-2821053`; both displayed Due 23 hrs. No exact deadline inferred from rounded badges. The first historical API read correctly returned stale/null metrics for the 19:27Z snapshot. Execution API contents were identical before and after both cycles.

## Defect → cause → fix → proof → remaining

| Defect | Cause | Fix / audited behavior | Evidence | Remaining |
|---|---|---|---|---|
| RDP displacement / 0x5 | Independent OpenClaw exec calls restarted `ss_hands.sh up`; start-only flock did not reserve the session. Original transient service also had Restart=on-failure and FreeRDP auto-reconnect | Exclusive named native/worker lease; foreign/unowned/expired commands fail closed. No automatic takeover. RDP Restart=no and auto-reconnect disabled. Existing competing RDP unit stopped | `rdp-cause.json`, `rdp-service.log`, `lease-rejection.json`; two native cycles without displacement | Advisory ownership must be used by every caller; direct external RDP connections are not OS-blocked. No unattended collector acceptance |
| Certificate bypass in existing worker | `/cert-ignore` | Pin SHA256 of RDP certificate independently retrieved through authenticated WinRM; native certificate details compared before connection | `certificate.json`; guarded script | Pinned worker reconnect has not been exercised. Certificate rotation must fail closed and be reverified |
| False All stores live | Header described filter selection as service health | Neutral “stores selected”, no green live indicator | Header source and post-deploy UI | Selection is not source health |
| Misnamed API unread counter | stats.unreadMessages returned responseNeeded | Separate responseNeeded and genuine nullable unreadMessages; heading/tab/KPI updated; non-Salutem filter does not borrow the Salutem count | stats API before/after, live acceptance assertions | Unread not observed, remains null |
| Snapshot freshness confused with collector availability | Fresh saved evidence implied live source | Explicit manual screen checks / connection not monitored; Refresh view only reloads evidence; source/evidence under collapsed details | ScreenQueuePanel, UI and API captures | No scheduled collection started; paused jobs remain paused |
| Technical JSON mixed into reply proof | Raw intent record beside reply body | JSON nested under collapsed Technical record; blocked historical tasks remain in collapsed details | ExecutionPanel and rendered UI test | Historical evidence retained |
| Unknown/stale/failed source yields false zero | Previously repaired authority path | Rechecked stale API, unit failure transitions, UI network failure preserving last-success time; null current metrics | tests.log, screen queue UI test, api-before.json | Live-read failure reporting still depends on the screen operator/worker submitting failure |
| Mail history / needs_review presented as current queue | Legacy mail source | Current screen authority and producer/publisher membership + observation provenance gates verified; alerts filtered | cs-cards.ts, inbox-watch.ts, customer-service-agent.ts; test suite; MCP acceptance output | Mail remains historical data only |
| Lost/replayed send intent | Legacy task execution states | Durable journal, pending attempts cannot be replaced, verified sends immutable/idempotent; no transport invoked | execution-journal tests; identical execution API before/after | Automatic transport remains disabled |
| A-to-Z/chargebacks/feedback zero | Historical/manual imports are not live sources | Current counts remain null with source limitations; stored losses/history separate | stats output | Current claims/feedback ingestion not restored |

## Exact RDP cause

`/run/systemd/transient/ss-hands-rdp.service`, not a discovered periodic timer, was the transport. Current-instance `NRestarts=0` does not account for explicit stop/start by another session. Scoped OpenClaw tool records show:

- session `e2e1a939-9c0c-4651-aaad-df4ff83fe8f3`: `scripts/ss_hands.sh up` at 19:24:21.834Z, down at 19:26:06.130Z.
- session `35c13e9f-02dc-4afa-954f-b080ed4cdbd9`: status/up/shot at 21:24:12.362Z; matches systemd start at 16:24 ET.

The new runtime scripts are versioned in `ss-control-center/ops/customer-service/`, installed at `/root/.openclaw/workspace/scripts/`. `ss_screen_lease.py acquire --owner <unique-task-id> --mode native|worker` reserves the screen. Worker calls require `SS_SCREEN_OWNER` and worker mode. Before handoff: disconnect native RDP or stop the owned worker, then release the matching lease. An expired lease requires explicit handoff; it is never stolen. No paused browser cron was enabled.

## Reported unresolved

Scott, order `111-9633582-9233033`, only entry in Reported Unresolved. Buyer messages on November 5 and 7 describe smashed contents, broken box and inner styrofoam container, nothing cold. Last visible seller response November 8 11:31 AM (UI-displayed time) directs the buyer to Amazon A-to-z and requests supporting photos. The thread remains Open / Reported Unresolved. Recommendation: inspect the actual A-to-z claim state and evidence for this order before deciding any further reply or remedy. Neither the claim's existence/status nor a refund is established by that message. No case action performed.

## Concrete autonomy gap / Jackie handoff

The verified route is native Windows App → SS VPS → existing Chrome Messaging, screen read via CUA, authenticated snapshot ingestion. It works during this active agent session. It is not a resident scheduled collector. The old INBOX_SCAN task path is permanently disabled; the existing service supplies RDP transport, not semantic screen extraction. No scheduler was enabled under this task.

Jackie: all future `/root/.openclaw/workspace/scripts/ss_hands.sh` callers must use the lease above. Safe next integration object is a **read-only screen worker** that owns that lease, refreshes Messaging, validates account/full list, saves screenshot, posts snapshot or failure to `/api/customer-hub/screen-inbox`, and releases/disconnects before handoff. It must not reuse the disabled CDP scanner or SEND queue. An unattended scheduling run needs the separately required scheduler authorization; the two manual cycles here do not prove unattended operation.

## Independent acceptance artifacts

Server directory: `/root/.openclaw/workspace/data/customer-hub-screen/audit-20261118-evening/`.
Local directory: `ss-control-center/data/cs-audit-20261118-evening/` (ignored, not committed).

- `cycle-1.png`, `cycle-2.png`: original CUA screenshots, no redrawing.
- `scott-unresolved.png`: actual thread and buyer/seller context.
- `cycle-1-input.json`, `cycle-2-input.json`: submitted observations.
- `api-before.json`, `cycle-1-api.json`, `cycle-2-api.json`: production GET results.
- `rdp-cause.json`, `rdp-service.log`, `certificate.json`, `lease-rejection.json`: access diagnosis.
- `tests.log`, `typecheck.log`: local checks. Post-deploy evidence is recorded alongside these artifacts.

Validation so far: 106 Customer Hub authority/execution tests passed; screen UI test covers unknown/fresh/stale/API failure and retained timestamp; lease test covers conflicting owners/modes/expiry/handoff; shell syntax, TypeScript, changed-file ESLint checked. Deployment and final production acceptance recorded below after completion.
