#!/usr/bin/env node
"use strict";

/**
 * Loopback-only operator bridge for the catalog triage runner.
 * Reads the worker token from the existing root-only .env, calls only /health
 * or /analyze-claude on 127.0.0.1, and returns a base64 response envelope.
 */

// Worker sources are CommonJS because server.js is deployed directly by Node.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");

const ENV_PATH = "/root/codex-image-worker/.env";
const MAX_REQUEST_BYTES = 20_000_000;
const MAX_RESPONSE_BYTES = 3_000_000;

function parseEnv(bytes) {
  const values = {};
  for (const rawLine of bytes.toString("utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

async function readStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) throw new Error("request exceeds 20 MB cap");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function main() {
  const action = process.argv[2];
  if (action !== "health" && action !== "health-summary" && action !== "analyze") {
    throw new Error("argument must be health, health-summary, or analyze");
  }
  const env = parseEnv(fs.readFileSync(ENV_PATH));
  const token = String(env.CODEX_IMAGE_WORKER_TOKEN || "").trim();
  const port = Number(env.PORT || 8791);
  if (!token || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("worker token/port is unavailable");
  }
  const body = action === "analyze" ? await readStdin() : Buffer.alloc(0);
  if (action === "analyze") JSON.parse(body.toString("utf8"));
  const response = await fetch(
    `http://127.0.0.1:${port}/${action === "analyze" ? "analyze-claude" : "health"}`,
    {
      method: action === "analyze" ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(action === "analyze" ? { "content-type": "application/json" } : {}),
      },
      ...(action === "analyze" ? { body } : {}),
      signal: AbortSignal.timeout(action === "analyze" ? 360_000 : 30_000),
    },
  );
  const responseBytes = Buffer.from(await response.arrayBuffer());
  if (!responseBytes.length || responseBytes.length > MAX_RESPONSE_BYTES) {
    throw new Error("worker response is empty or exceeds 3 MB cap");
  }
  if (action === "health-summary") {
    const health = JSON.parse(responseBytes.toString("utf8"));
    process.stdout.write(`${JSON.stringify({
      status: response.status,
      ok: health.ok,
      health_authorization_verified: health.health_authorization_verified,
      worker_build: health.worker_build,
      vision_timeout_ms: health.vision_timeout_ms,
      signed_vision_receipts: health.signed_vision_receipts,
      reservation_ledger: health.reservation_ledger,
    }, null, 2)}\n`);
    return;
  }
  process.stdout.write(JSON.stringify({
    status: response.status,
    body_base64: responseBytes.toString("base64"),
  }));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
