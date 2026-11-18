# Customer Service: origin of Mac path and direct VPS handoff

Owner clarification `20261118T232406Z-dde3b7`. This investigation opened **no Windows App or RDP session**, sent no buyer reply, and changed no Tailscale authentication, routes, exit node, browser profile, or Amazon egress settings.

## Who selected Windows App

The main Codex agent made the selection, not a subagent. Primary execution log:

`/Users/vladimirkuznetsov/.codex/sessions/2026/11/06/rollout-2026-11-06T09-01-01-01a1b129-af03-7531-bafe-1ac20cc8a2a5.jsonl`

- Session: `01a1b129-af03-7531-bafe-1ac20cc8a2a5`.
- Session metadata line 1 records `originator=codex_exec`, `source=exec`, `cli_version=0.154.0`, provider OpenAI. The CLI version is recorded session metadata, not an independently measured current executable version.
- Turn context line 2786, 2026-11-18T18:24:50.222Z: model `gpt-6-astra`, default collaboration mode, medium reasoning effort.
- No actual spawn tool calls exist in this session's November 18 execution records. There is no subagent ID for this work.

| UTC / EST | Primary record | Actual action / result |
|---|---|---|
| 18:25:54.895Z / 13:25:54 | 2837, call_c74ab84cae1a4c1d8b29fc0f7cc6c2d1 | SSH process-presence check: pgrep Xvfb :92 and pgrep matching FreeRDP process |
| 18:25:55.558Z / 13:25:55 | 2840 | Printed `Salutem display :92 running= True`, `Salutem RDP process running= True`. This does not prove a readable/authenticated screen |
| 18:28:51.785Z / 13:28:51 | 2872 | mcp__cua_repl.js, `await cua.listApps();` |
| 18:28:56.495Z / 13:28:56 | 2879, call_1215adc37d7f42f684f874d9ccb2b844 | mcp__cua_repl.js, `var csRdpApp = await cua.getApp('com.microsoft.rdc.macos');` |
| 18:29:02.445Z / 13:29:02 | 2886 | `await csRdpApp.click(18,{clickCount:2}); await csRdpApp.getAXState();` — saved device SS |
| 18:29:03.410Z / 13:29:03 | 2889 | RDP certificate warning appeared for SS public address |
| 18:29:09.791Z / 13:29:09 | 2893 | Cancel clicked; first attempt did not connect |

**Direct ss_hands screen reading was not tested before choosing Mac.** Server scripts and process presence were inspected. No recorded technical failure of the direct screen route justified switching to Mac. The tool-use constraint required CUA for UI interaction; it did not prescribe Windows App or the iMac architecture. The main agent chose the locally available CUA/Windows App route without validating the agreed server route. That was an execution-path error; no retrospective technical necessity is claimed.

Selected original calls, line numbers, call IDs, and hashes of their original log records are in `first-execution-evidence.json`. It contains tool actions and outputs, not an invented decision narrative.

## Tailscale diagnosis, read-only via WinRM

Observed at 2026-11-18T23:34:54.406Z on `CLOUD-NN0V1SRSP`:

| Check | Result |
|---|---|
| Installed binary | `C:\Program Files\Tailscale\tailscale.exe` |
| Installed version | 1.104.7 |
| Service | Running, Automatic |
| BackendState | **NeedsLogin** |
| CurrentTailnet | null |
| TailscaleIPs | null |
| ExitNodeID / ExitNodeIP | empty |
| RouteAll | false |
| Windows session | administrator ID 2, Disc; no active RDP session shown by quser |
| OpenClaw server | Tailscale Running, tail3cb362.ts.net; SS peer absent |

Conclusion: the client is installed and the daemon is running, but the SS node is not currently authenticated. This does **not** establish that it belongs to another tailnet. The reason authentication was lost/not completed was not established by this check. No login link or authentication key was generated, exported, or used.

## Prepared direct route and ownership

Versioned scripts: `ss-control-center/ops/customer-service/ss_direct_preflight.py`, `ss_hands.sh`, `ss_screen_lease.py`; installed counterparts in `/root/.openclaw/workspace/scripts/`.

- RDP now requires separate `SS_VPS_TAILSCALE_IP`; `SS_VPS_IP` remains the existing WinRM administrative endpoint and cannot be used as an RDP fallback.
- Read-only preflight requires a 100.64.0.0/10 address, Running local Tailscale, expected tailnet, a unique online peer with host `CLOUD-NN0V1SRSP`. Existing independently verified RDP certificate pin remains enforced.
- Both public startup and internal RDP service entry perform this check. It does not authenticate, alter routes, open RDP, or establish current queue truth.
- Existing named native/worker lease remains mandatory. At handoff the lease is null, the RDP unit is not-found/inactive, and Windows session ID 2 was disconnected. No new transport session was opened for this investigation.
- Server preflight currently returns exit 75, `ready=false`, because the verified tailnet address is not bound. It was not filled with an invented address.

### Exact next action for Jackie / authorized tailnet administrator

Authenticate the **existing Tailscale client on CLOUD-NN0V1SRSP** into the intended `tail3cb362.ts.net` tailnet through the approved administrative enrollment flow. Do not enable an exit node, route advertisement, or route acceptance; preserve Amazon network egress. This security-sensitive enrollment was not performed as part of the read-only diagnosis.

Then verify the node identity from both ends, bind its assigned address as `SS_VPS_TAILSCALE_IP` in `/root/.openclaw/workspace/.secrets/ss_vps.env`, and run `python3 /root/.openclaw/workspace/scripts/ss_direct_preflight.py`. Never copy credentials or an enrollment key into a task or report.

Before starting the direct reader: recheck `quser` through WinRM and `ss_screen_lease.py status`; if anyone is active, arrange explicit handoff. A single direct worker acquires `--mode worker --owner <unique-task-id>` and supplies matching `SS_SCREEN_OWNER`. No Mac intermediary or unowned `up` invocation is allowed. Stop the owned transport before releasing the lease.

Authentication is the first concrete blocker. An unattended semantic screen reader remains a separate unfinished integration from the evening audit; transport readiness alone must not be called collector readiness. No paused cron is enabled by this handoff.

## Verification and evidence

Three route tests passed: missing/public addresses rejected; wrong host/tailnet, offline/missing peer and NeedsLogin rejected; expected peer establishes transport-only readiness. Existing ownership test and shell syntax checks also pass. Live server preflight fails closed and leaves the RDP unit inactive.

Artifacts: `/root/.openclaw/workspace/data/customer-hub-screen/direct-path-20261118/`:

- `first-execution-evidence.json`: primary session/tool records.
- `tailscale-diagnostic.json`: restricted WinRM and server status fields.
- `direct-preflight.json`: live fail-closed result and inactive unit.

Local mirror: `ss-control-center/data/cs-direct-path-20261118/`. No frontend changes or frontend deployment required; this change is server transport preparation. RDP connectivity over Tailscale is **not verified** until enrollment and binding are completed.
