# codex-image-worker (deploy reference)

This is the source-of-truth copy of the image worker that runs on the OpenClaw
box (`104.219.53.204`) and serves FREE ChatGPT-subscription image generation to
the SS Command Center app. See `docs/wiki/codex-image-generation.md` for the full
picture.

`server.js`, `prompt.js`, `image-preflight.js`, and `vision-contract.js` here are the source files deployed under
`/root/codex-image-worker/`.

## What it does

`POST /generate` (Bearer auth) `{ prompt, size, reference_images?, reference_urls? }`
→ runs `codex exec` with the imagegen skill (built-in `image_gen` tool, ChatGPT
subscription, $0) → returns the generated PNG bytes. `GET /health` → `{ ok: true }`.
Requests are serialized.

`reference_images` is an array of base64-encoded PNGs (product photos + the
approved frozen-hero anchors); `reference_urls` an array of image URLs. They are
written into a per-run working dir and the codex agent is told to pass **every**
ordered reference to `image_gen`: ref-1 is the kit anchor and ref-2..N are exact
product donors in recipe order. Generation fails closed if any requested
reference cannot be decoded or fetched; it must never silently generate a mix
with a missing flavor reference. Backward compatible: omit them and it behaves
as before (text only).
⚠️ Reference support depends on the codex `image_gen` tool accepting input
images — confirm on the first real run.

It strips `OPENAI_API_KEY` / `CODEX_API_KEY` from the child env so the paid
`scripts/image_gen.py` fallback can never run.

## Deploy / update on the box

```bash
scp ops/codex-image-worker/server.js ops/codex-image-worker/prompt.js ops/codex-image-worker/image-preflight.js ops/codex-image-worker/vision-contract.js openclaw:/root/codex-image-worker/
ssh openclaw 'systemctl restart codex-image-worker && systemctl status codex-image-worker --no-pager'
```

The vision lane pins Codex to `gpt-5.6-sol` at `medium` reasoning. Health and
every analyze response attest that model, reasoning effort, Codex/Claude CLI
version, Node version, platform, architecture, input image count, exact vision
timeout, and a worker build hash that includes both source bytes and the runtime
contract, including the reservation-ledger identity, epoch, canonical-path
fingerprint, directory-custody fingerprint, and identity-artifact fingerprint.
A model, CLI/runtime, `CODEX_HOME`, ledger identity, or ledger custody change
therefore creates a new build identity and invalidates old checkpoints instead
of silently reusing them.

Attested Claude observations additionally require an Ed25519 signing key in
`VISION_ATTESTATION_PRIVATE_KEY_PKCS8_B64` and its stable identifier in
`VISION_ATTESTATION_KEY_ID`. Before Claude is spawned, the worker permanently
reserves the signed request's `call_key` under
`$CODEX_HOME/vision-call-reservations/` using exclusive create + fsync. A replay
or an ambiguous prior attempt returns HTTP 409 and never starts another model
invocation. The v2 request and signed receipt additionally bind the immutable
family SHA, selected partition, exact execution-permit SHA and server-side
reservation timestamp. These reservation files are audit records; do not
delete them to retry a call.

## First-time setup (already done 2026-06-25)

Prereqs on the box: `codex` CLI installed and `codex login status` == "Logged in
using ChatGPT" (subscription, NOT API key).

```bash
mkdir -p /root/codex-image-worker
# secret + config
printf 'CODEX_IMAGE_WORKER_TOKEN=%s\nPORT=8791\nHOST=127.0.0.1\nCODEX_HOME=/root/.codex\n' \
  "$(openssl rand -hex 32)" > /root/codex-image-worker/.env
chmod 600 /root/codex-image-worker/.env
```

Generate the receipt key once on the worker and store its PKCS8 DER as base64
in the same `0600` environment file. Never copy the private key into a run-lock;
only the public SPKI fingerprint and key ID are frozen there.

### Pin the reservation ledger after its first controlled startup

This is a mandatory two-step bootstrap. On the first controlled startup only,
leave `VISION_CALL_LEDGER_EXPECTED_ID` and
`VISION_CALL_LEDGER_EXPECTED_EPOCH` unset. The worker creates immutable
`.ledger-identity.json` and mutable `.ledger-head.json` custody artifacts under
`$CODEX_HOME/vision-call-reservations/`; existing v2 call-key files are adopted
without being rewritten.

1. Start the worker, make an **authenticated** `GET /health`, and record the
   complete `reservation_ledger` object and `worker_build`. Persist the exact
   identity pair from that response in the protected environment file:

   ```dotenv
   VISION_CALL_LEDGER_EXPECTED_ID=<reservation_ledger.ledger_id>
   VISION_CALL_LEDGER_EXPECTED_EPOCH=<reservation_ledger.ledger_epoch>
   ```

2. Restart the worker with both variables set. Make another authenticated
   `GET /health` and verify that `reservation_ledger` and `worker_build` are
   byte-for-byte identical to the values from step 1 before permitting any
   observed call.

Both expected variables must always be set together after bootstrap. If the
directory is missing, empty, replaced, moved, bound to another identity/epoch,
or has lost a reserved call-key file, startup fails closed. Never clear or copy
the ledger to unblock a call. A deliberate path/identity rotation is an owner
operation that requires a new worker build and new run-locks.

### systemd unit — `/etc/systemd/system/codex-image-worker.service`

```ini
[Unit]
Description=Codex Image Worker (subscription image_gen -> PNG for SS Command Center)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/codex-image-worker
Environment=HOME=/root
Environment=CODEX_HOME=/root/.codex
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=/root/codex-image-worker/.env
# Never allow the paid OpenAI Images path:
Environment=OPENAI_API_KEY=
Environment=CODEX_API_KEY=
ExecStart=/usr/bin/node /root/codex-image-worker/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now codex-image-worker
```

### nginx — add to `/etc/nginx/sites-available/mcp.salutem.solutions`

Inside the `server { ... listen 443 ssl; }` block, **before** `location / {`:

```nginx
location /codex-image/ {
    proxy_pass http://127.0.0.1:8791/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Connection "";
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    client_max_body_size 24m;   # raised from 4m for base64 reference images
}
```

```bash
nginx -t && systemctl reload nginx
```

The same token goes into the app's `CODEX_IMAGE_WORKER_TOKEN` (`.env.local` +
Vercel Production). Public URL: `https://mcp.salutem.solutions/codex-image/generate`.

## Verify

```bash
ssh openclaw 'curl -s https://mcp.salutem.solutions/codex-image/health'   # {"ok":true,...}
# from the app dir:
npx tsx scripts/smoke-codex-image.ts                                      # PASS
```
