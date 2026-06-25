# codex-image-worker (deploy reference)

This is the source-of-truth copy of the image worker that runs on the OpenClaw
box (`104.219.53.204`) and serves FREE ChatGPT-subscription image generation to
the SS Command Center app. See `docs/wiki/codex-image-generation.md` for the full
picture.

`server.js` here is the same file deployed at `/root/codex-image-worker/server.js`.

## What it does

`POST /generate` (Bearer auth) `{ prompt, size }` → runs `codex exec` with the
imagegen skill (built-in `image_gen` tool, ChatGPT subscription, $0) → returns the
generated PNG bytes. `GET /health` → `{ ok: true }`. Requests are serialized.

It strips `OPENAI_API_KEY` / `CODEX_API_KEY` from the child env so the paid
`scripts/image_gen.py` fallback can never run.

## Deploy / update on the box

```bash
scp ops/codex-image-worker/server.js openclaw:/root/codex-image-worker/server.js
ssh openclaw 'systemctl restart codex-image-worker && systemctl status codex-image-worker --no-pager'
```

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
    client_max_body_size 4m;
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
