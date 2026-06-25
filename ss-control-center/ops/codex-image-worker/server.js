#!/usr/bin/env node
"use strict";
/*
 * codex-image-worker
 * -----------------------------------------------------------------------------
 * Tiny HTTP service that turns a text prompt into a PNG using the Codex CLI's
 * built-in `image_gen` tool (the FREE ChatGPT-subscription path), NOT the paid
 * OpenAI Images API.
 *
 * Why this exists: SS Command Center runs on Vercel serverless, where the
 * stateful Codex CLI (needs ~/.codex/auth.json + a writable generated_images
 * dir) cannot run. This worker lives on the always-on OpenClaw box, which is
 * already `codex login`-ed with a ChatGPT subscription. The Vercel app calls
 * this worker instead of openai.images.generate().
 *
 * Hard rule (cost): never let the paid path run. We explicitly strip
 * OPENAI_API_KEY / CODEX_API_KEY from the child env so the imagegen skill can
 * only use the built-in (subscription) tool, never scripts/image_gen.py.
 *
 * Contract:
 *   POST /generate   Authorization: Bearer <token>
 *     body: { "prompt": "<scene description>", "size": "1024x1024" }
 *     200 -> image/png bytes
 *     4xx/5xx -> { error, ... } JSON
 *   GET /health -> { ok: true }
 *
 * Requests are serialized (one codex run at a time): codex writes into a shared
 * generated_images dir, so serializing keeps "which PNG did this run produce"
 * unambiguous and is gentle on subscription rate limits. Image gen is operator
 * driven (low volume), so a queue is fine.
 */
const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");

const PORT = parseInt(process.env.PORT || "8791", 10);
const HOST = process.env.HOST || "127.0.0.1";
const TOKEN = process.env.CODEX_IMAGE_WORKER_TOKEN || "";
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const GEN_DIR = path.join(CODEX_HOME, "generated_images");
const RUN_TIMEOUT_MS = parseInt(process.env.RUN_TIMEOUT_MS || "240000", 10);

if (!TOKEN) {
  console.error("FATAL: CODEX_IMAGE_WORKER_TOKEN is not set");
  process.exit(1);
}

// --- serial queue: run at most one codex exec at a time -----------------------
let chain = Promise.resolve();
function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

// --- list every generated PNG with its mtime ----------------------------------
function listPngs() {
  const out = [];
  let sessions;
  try {
    sessions = fs.readdirSync(GEN_DIR);
  } catch {
    return out;
  }
  for (const s of sessions) {
    const dir = path.join(GEN_DIR, s);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.toLowerCase().endsWith(".png")) continue;
      const p = path.join(dir, f);
      try {
        out.push({ p, dir, mtime: fs.statSync(p).mtimeMs });
      } catch {
        /* file vanished between readdir and stat */
      }
    }
  }
  return out;
}

// --- run codex exec with the paid path disabled -------------------------------
function runCodex(prompt) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    // Belt-and-suspenders: the imagegen skill's paid CLI fallback
    // (scripts/image_gen.py) needs OPENAI_API_KEY. Strip it so only the
    // built-in subscription tool can run.
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    env.CODEX_HOME = CODEX_HOME;

    const child = spawn(
      CODEX_BIN,
      ["exec", "--skip-git-repo-check", prompt],
      { env, cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";
    const cap = (s, d) => {
      s += d.toString();
      return s.length > 200000 ? s.slice(-200000) : s;
    };
    child.stdout.on("data", (d) => { stdout = cap(stdout, d); });
    child.stderr.on("data", (d) => { stderr = cap(stderr, d); });

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve({ code: -1, stdout, stderr: stderr + "\n[worker] timed out" });
    }, RUN_TIMEOUT_MS);

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + "\n[worker] spawn error: " + e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// --- wrap the raw scene prompt into an imagegen instruction --------------------
function buildPrompt(userPrompt, size) {
  let sizeHint = "";
  if (size) {
    const [w, h] = String(size).split("x").map((n) => parseInt(n, 10));
    if (w && h) {
      const shape = w === h ? "square" : w > h ? "landscape, wider than tall" : "portrait, taller than wide";
      sizeHint = ` Compose it as a ${shape} image, roughly ${w}x${h} pixels.`;
    }
  }
  return (
    `Generate an image: ${userPrompt}.${sizeHint} ` +
    `Use the imagegen skill with the built-in image_gen tool. ` +
    `Do not ask any questions and do not request confirmation; just generate and save the image.`
  );
}

async function handleGenerate(body) {
  const prompt = String((body && body.prompt) || "").trim();
  if (!prompt) return { status: 400, json: { error: "missing prompt" } };
  const size = body && body.size;

  const beforePaths = new Set(listPngs().map((x) => x.p));
  const startedAt = Date.now() - 2000; // tolerate small clock skew

  const { code, stdout, stderr } = await runCodex(buildPrompt(prompt, size));

  const after = listPngs();
  // Prefer files that did not exist before this run; fall back to anything
  // freshly written during the run window.
  let candidates = after.filter((x) => !beforePaths.has(x.p));
  if (candidates.length === 0) candidates = after.filter((x) => x.mtime >= startedAt);
  candidates.sort((a, b) => b.mtime - a.mtime);
  const picked = candidates[0];

  if (!picked) {
    return {
      status: 502,
      json: {
        error: "codex produced no image",
        code,
        stderr: stderr.slice(-2000),
        stdout: stdout.slice(-2000),
      },
    };
  }

  const png = await fsp.readFile(picked.p);
  // Keep disk clean: drop the whole session dir we just consumed.
  try { await fsp.rm(picked.dir, { recursive: true, force: true }); } catch {}
  return { status: 200, png };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, genDir: GEN_DIR }));
    return;
  }

  if (req.method !== "POST" || url.pathname !== "/generate") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  if ((req.headers["authorization"] || "") !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  let data = "";
  req.on("data", (d) => {
    data += d;
    if (data.length > 1_000_000) req.destroy();
  });
  req.on("end", () => {
    let body;
    try {
      body = JSON.parse(data || "{}");
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad json" }));
      return;
    }
    enqueue(() => handleGenerate(body))
      .then((result) => {
        if (result.png) {
          res.writeHead(200, { "content-type": "image/png", "content-length": result.png.length });
          res.end(result.png);
        } else {
          res.writeHead(result.status, { "content-type": "application/json" });
          res.end(JSON.stringify(result.json));
        }
      })
      .catch((err) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String((err && err.message) || err) }));
      });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`codex-image-worker listening on ${HOST}:${PORT} (CODEX_HOME=${CODEX_HOME})`);
});
