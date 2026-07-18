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
