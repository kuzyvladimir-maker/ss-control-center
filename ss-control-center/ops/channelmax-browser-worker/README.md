# ChannelMAX browser worker — supervised iMac LaunchAgent

This directory operates the **read-only** ChannelMAX browser worker on the
logged-in iMac. The worker connects three existing pieces:

1. SS Command Center production queues a bounded read-only job.
2. This per-user LaunchAgent runs the pinned local worker from this checkout.
3. The worker observes the single signed-in ChannelMAX Chrome tab through the
   hardened local CDP helper and uploads managed evidence to SSCC.

The only accepted operations are `SNAPSHOT_INVENTORY` and
`DISCOVER_MANUAL_MODEL`. This lane has no click/fill/navigation or ChannelMAX
mutation contract. A future write lane must be separate and approval-gated.

## Production mutation preflight (still blocked)

The exact sealed-v10/offline preflight is available without enabling browser
writes:

```bash
npm run channelmax:preflight-uncrustables
npm run channelmax:preflight-uncrustables -- --full
```

It binds the exact source-plan, TSV, manifest, 164-row prewrite snapshot,
account, SiteID `300`, selected-site label, and canonical model `59021`; it also
emits the full 162-row before/desired diff and the one-row same-model canary.
The command intentionally exits non-zero because production execution is not
yet reversible:

- 161 target rows currently use ChannelMAX `Default`, but the finite upload
  contract has no tested mechanism to restore that null/default model after
  assigning `59021`.
- The old bounds are captured, but no independently verified rollback artifact
  restores the exact 161 `Default` / 1 `Manual min/max` target distribution.
- `SZ-ASPI-JFAT` is `B0H776M5B5` in sealed v10 but the live ChannelMAX row
  reports `B0H75VN18Z`; the exact 162-row upload therefore has an identity
  mismatch.
- The production mutation gate and finite browser-write executor remain off.

No canary or batch may run until a reviewed Default-model round trip restores
both model and bounds, the SZ identity is resolved or explicitly excluded in a
new sealed plan, and the complete rollback artifact verifies independently.

### Same-model VC canary executor

A finite state machine now exists for the only target already on canonical
`Manual min/max [59021]`:

- identity: `VC-ASV1-378P` / `B0H786L5MW`, account/site fixed above;
- forward bounds: `$219.57 / $252.99`, exact 103-byte TSV SHA-256
  `b3bb356eedc232bca2cd3d92f095e1b31606f3780ec93f6e9af1004b8a9c495a`;
- rollback bounds: `$251.32 / $289.28`, exact 103-byte TSV SHA-256
  `0a7f74822194fd8f4bd0f5aaec70b549875ba922dd618834aba5117cc4a9d932`;
- each direction is a separate `max_attempts=1` mutation job with its own real
  admin step-up approval;
- the state machine requires exact Analyze mapping, posts one acknowledged
  `MUTATION_STARTED`, calls submit once, verifies TaskID/counts and the exact
  postwrite row, and turns every uncertain result into terminal `AMBIGUOUS`.

Production execution remains disabled. A protected, content-addressed endpoint
is implemented for the two exact artifacts, but it has not been deployed and
probed from the worker. A deterministic finite CDP adapter skeleton now binds
the exact target, hashes, one-row Analyze contract, maximum one Submit, TaskID,
and row readback interfaces, but it contains no guessed selectors or DOM
expressions. Every browser method fails before CDP because the reviewed DOM
contract is still null. The current queue also cannot pre-arm a separately
approved rollback job while preventing it from being claimed before its
forward dependency.

The skeleton prepares only the exact 103-byte forward/rollback bytes in an
isolated 0600 temporary file and specifies the hardened
`scripts/cdp_browser.py upload_file` primitive with `--allowed-root` and
`--expected-sha256`; it always removes the workspace. Focused offline checks:

```bash
npm run test:channelmax-canary-adapter
python3 ../scripts/test_cdp_browser.py
```

The exact adapter blockers are: no pinned File Uploader DOM evidence, no
reviewed file-input selector, no reviewed Analyze control/parser, no reviewed
Submit/Task receipt parser, no reviewed postwrite readback, and the independent
adapter release gate remains false.

The endpoint accepts only authenticated `GET` with the existing
`JACKIE_API_TOKEN` / `SSCC_API_TOKEN` or a real admin session. It returns exact
`Content-Length`, `Content-Type`, SHA-256 headers, and bytes; every other digest,
query variant, or HTTP method fails closed:

- forward: `/api/openclaw/channelmax/canary-artifacts/b3bb356eedc232bca2cd3d92f095e1b31606f3780ec93f6e9af1004b8a9c495a.txt`;
- rollback: `/api/openclaw/channelmax/canary-artifacts/0a7f74822194fd8f4bd0f5aaec70b549875ba922dd618834aba5117cc4a9d932.txt`.

The exact next ceremony is:

1. Deploy this build and probe both authenticated artifact URLs from the worker;
   verify the received body SHA-256 and byte size, then verify an unknown digest
   and an unauthenticated request are rejected.
2. Read-only inspect the live File Uploader DOM and independently review a
   finite adapter for its exact file input, Analyze preview, single Submit,
   TaskID receipt, and postwrite snapshot; no caller-provided selectors or JS.
3. Add a dependency state that lets the owner step-up approve the rollback job
   before forward execution while keeping rollback unclaimable until explicitly
   armed after a confirmed forward result.
4. In the admin UI, render forward and rollback hashes, both price pairs,
   account/site/SKU/ASIN, one-attempt policy, prewrite snapshot hash, and the
   terminal-ambiguity warning before consuming either approval.
5. Run tests, manually open the exact Salutem File Uploader tab, approve only
   the forward job, and enable only the canary-specific release flag. Never
   enable the 162-row lane from this ceremony.

Offline state-machine verification:

```bash
npm run test:channelmax-canary
```

## Fixed production identity

- SSCC: `https://ss-control-center.vercel.app`
- worker ID: `imac-channelmax-primary`
- ChannelMAX account: `channelmax:amznus:salutem-solutions`
- selected site: ID `300`, exact name `AmznUS [Salutem Solutions]`
- Chrome CDP: loopback port `9222`

Both probes host-validate the selected SiteID and exact SiteName before their
result is accepted. Visible page text remains an additional early guard.

## Secret handling

The worker reuses the existing shared `JACKIE_API_TOKEN`; do **not** create a
second token. Store that existing value once at the native hidden macOS
Keychain prompt:

```bash
./ops/channelmax-browser-worker/install-launchagent.sh set-token
```

Keychain service: `com.salutem.sscc.jackie-api-token`; account: the current
macOS login user. The token is never embedded in the plist, passed in argv,
printed, tailed by status, or written to a repository file. `status` checks
only Keychain item metadata.

## Prerequisites

- Run commands from the `ss-control-center` directory in this checkout.
- Local dependencies are installed. The installer pins the absolute Node
  executable/version and `node_modules/tsx/dist/cli.mjs` version into the plist;
  no `npx` or runtime package download is used.
- Python 3 can `import websocket`.
- Chrome is already running with remote debugging on `127.0.0.1:9222`.
- Exactly one HTTPS tab is open on `selling.channelmax.net`, signed in, with
  `AmznUS [Salutem Solutions]` selected.

The scripts do not relaunch Chrome or alter its profile. If CDP is absent, the
launcher exits with code 75 and launchd retries after its 30-second throttle.

## Install and operate

`install` copies/renders files only. It deliberately does not load or start the
agent:

```bash
./ops/channelmax-browser-worker/install-launchagent.sh install
```

If the Keychain item is absent, `install` invokes the same hidden native prompt.
Starting remains a second explicit command:

```bash
./ops/channelmax-browser-worker/install-launchagent.sh doctor
./ops/channelmax-browser-worker/install-launchagent.sh start
./ops/channelmax-browser-worker/install-launchagent.sh status
```

Other bounded operations:

```bash
./ops/channelmax-browser-worker/install-launchagent.sh stop
./ops/channelmax-browser-worker/install-launchagent.sh restart
./ops/channelmax-browser-worker/install-launchagent.sh uninstall
```

`uninstall` boots out only this exact service and removes only its plist and
installed runner copy. It preserves the Keychain entry and logs. Reinstall
after a deliberate Node/tsx upgrade so the pinned versions are reviewed.

## Installed paths and logs

- plist: `~/Library/LaunchAgents/com.salutem.channelmax-browser-worker.plist`
- runner: `~/Library/Application Support/SS Command Center/channelmax-browser-worker/run-worker.sh`
- logs: `~/Library/Logs/SS Command Center/channelmax-browser-worker/`

The runner rotates `stdout.log` and `stderr.log` at 5 MiB and keeps five
archives of each. Status reports only their path, size, and modification time;
it never displays log contents.

## Verification

Offline operational checks (no install/start, network, Keychain read, or CDP
interaction):

```bash
npm run test:channelmax-worker
./ops/channelmax-browser-worker/test.sh
```

After an explicit start, `status` is healthy only when the plist binding,
pinned runtime, Keychain metadata, launchd state, SSCC reachability, and CDP ping
all pass. No status or test command performs a ChannelMAX mutation.
