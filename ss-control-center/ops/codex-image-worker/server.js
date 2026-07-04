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
// Codex image_gen with reference images routinely runs ~4 min. Kill only at
// 285s — just under the nginx /codex-image/ proxy_read_timeout (300s) and the
// caller's fetch timeout (290s). The old 240s SIGKILLed generations right at the
// finish line (a 241s run died). Override via RUN_TIMEOUT_MS in the box .env.
const RUN_TIMEOUT_MS = parseInt(process.env.RUN_TIMEOUT_MS || "285000", 10);

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

// --- write reference images for a run; returns the file paths -----------------
// Vercel sends `reference_images` (base64 PNGs — product photos + the approved
// frozen-hero anchors) and/or `reference_urls`. We drop them into the run's
// working dir so the codex agent can hand them to image_gen as visual references
// (style/layout + accurate third-party packaging). Best-effort: a bad entry is
// skipped, never fatal.
async function writeRefs(refs, urls, runDir) {
  const files = [];
  let i = 0;
  for (const b64 of Array.isArray(refs) ? refs : []) {
    try {
      const clean = String(b64).replace(/^data:image\/\w+;base64,/, "");
      const buf = Buffer.from(clean, "base64");
      if (buf.length === 0) continue;
      const p = path.join(runDir, `ref-${++i}.png`);
      await fsp.writeFile(p, buf);
      files.push(p);
    } catch { /* skip bad ref */ }
  }
  for (const u of Array.isArray(urls) ? urls : []) {
    try {
      const res = await fetch(String(u));
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) continue;
      const p = path.join(runDir, `ref-${++i}.png`);
      await fsp.writeFile(p, buf);
      files.push(p);
    } catch { /* skip unreachable url */ }
  }
  return files;
}

// --- run codex exec with the paid path disabled -------------------------------
function runCodex(prompt, cwd) {
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
      { env, cwd: cwd || os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] }
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
function buildPrompt(userPrompt, size, refFiles) {
  let sizeHint = "";
  if (size) {
    const [w, h] = String(size).split("x").map((n) => parseInt(n, 10));
    if (w && h) {
      const shape = w === h ? "square" : w > h ? "landscape, wider than tall" : "portrait, taller than wide";
      sizeHint = ` Compose it as a ${shape} image, roughly ${w}x${h} pixels.`;
    }
  }
  let refHint = "";
  if (Array.isArray(refFiles) && refFiles.length === 1) {
    const a = path.basename(refFiles[0]);
    refHint =
      ` Reference image ${a} is in the current working directory. Pass it to the ` +
      `image_gen tool as an input/reference image and match its style, layout, ` +
      `lighting, and any branded packaging shown.`;
  } else if (Array.isArray(refFiles) && refFiles.length >= 2) {
    // ROLE-LABELED references (caller sends anchor first, product second).
    const anchor = path.basename(refFiles[0]);
    const product = path.basename(refFiles[1]);
    refHint =
      ` Two reference image files are in the current working directory. ` +
      `${anchor} is the KIT ANCHOR — use it ONLY for the styrofoam cooler look, the gel-pack style, and the overall layout/arrangement. ` +
      `${product} is the DONOR PRODUCT PHOTO — it shows the REAL retail packaging (real brand name, real logo, real box art and colors). ` +
      `You MUST reproduce the product packaging from ${product} EXACTLY as shown; do NOT invent, simplify, or substitute a different-looking package, and do NOT copy any product from the anchor image. ` +
      `Pass BOTH files to the image_gen tool as input/reference images.`;
  }
  return (
    `Generate an image: ${userPrompt}.${sizeHint}${refHint} ` +
    `Use the imagegen skill with the built-in image_gen tool. ` +
    `Do not ask any questions and do not request confirmation; just generate and save the image.`
  );
}

async function handleGenerate(body) {
  const prompt = String((body && body.prompt) || "").trim();
  if (!prompt) return { status: 400, json: { error: "missing prompt" } };
  const size = body && body.size;

  // Per-run working dir so reference images are isolated + auto-cleaned.
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-img-"));
  let refFiles = [];
  try {
    refFiles = await writeRefs(
      body && body.reference_images,
      body && body.reference_urls,
      runDir,
    );
  } catch { /* refs are best-effort */ }

  const beforePaths = new Set(listPngs().map((x) => x.p));
  const startedAt = Date.now() - 2000; // tolerate small clock skew

  const { code, stdout, stderr } = await runCodex(
    buildPrompt(prompt, size, refFiles),
    runDir,
  );
  // Drop the run dir (reference images) once codex is done with it.
  try { await fsp.rm(runDir, { recursive: true, force: true }); } catch {}

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

// --- VISION: run codex exec with image(s) attached, return the model's text -----
// Same subscription path as generation, but here Codex READS the attached images
// (`-i FILE`) and answers in text. Used for product identification (COGS engine).
const VISION_TIMEOUT_MS = parseInt(process.env.VISION_TIMEOUT_MS || "180000", 10);
function runCodexVision(imgFiles, prompt, cwd) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.OPENAI_API_KEY; // subscription-only, never the paid CLI fallback
    delete env.CODEX_API_KEY;
    env.CODEX_HOME = CODEX_HOME;

    const args = ["exec", "--skip-git-repo-check"];
    for (const f of imgFiles) { args.push("-i", f); } // attach each image as vision input
    args.push(prompt);

    const child = spawn(CODEX_BIN, args, { env, cwd: cwd || os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const cap = (s, d) => { s += d.toString(); return s.length > 200000 ? s.slice(-200000) : s; };
    child.stdout.on("data", (d) => { stdout = cap(stdout, d); });
    child.stderr.on("data", (d) => { stderr = cap(stderr, d); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve({ code: -1, stdout, stderr: stderr + "\n[worker] vision timed out" }); }, VISION_TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + "\n[worker] spawn error: " + e.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// Extract the LAST parseable {...} object from codex stdout (which may contain
// agent logs/reasoning before the final answer). Scans right-to-left, matching
// each closing brace to its opener, and returns the first candidate that parses.
function extractLastJson(text) {
  let end = text.lastIndexOf("}");
  while (end !== -1) {
    let depth = 0, start = -1;
    for (let i = end; i >= 0; i--) {
      const c = text[i];
      if (c === "}") depth++;
      else if (c === "{") { depth--; if (depth === 0) { start = i; break; } }
    }
    if (start !== -1) { try { return JSON.parse(text.slice(start, end + 1)); } catch { /* keep scanning */ } }
    end = text.lastIndexOf("}", end - 1);
  }
  return null;
}

async function handleAnalyze(body) {
  const prompt = String((body && body.prompt) || "").trim();
  if (!prompt) return { status: 400, json: { error: "missing prompt" } };

  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-vis-"));
  let imgFiles = [];
  try {
    imgFiles = await writeRefs(body && (body.images || body.reference_images), body && (body.image_urls || body.reference_urls), runDir);
  } catch { /* best-effort */ }
  if (!imgFiles.length) { try { await fsp.rm(runDir, { recursive: true, force: true }); } catch {} return { status: 400, json: { error: "no images" } }; }

  const names = imgFiles.map((f) => path.basename(f)).join(", ");
  const wrapped =
    `${prompt}\n\n` +
    `The image file(s) ${names} are attached to this message — look at them. ` +
    `Respond with ONLY a single JSON object (no markdown, no code fences, no prose, no explanation). ` +
    `Do NOT generate or create any image. Do NOT ask questions or request confirmation.`;

  const { code, stdout, stderr } = await runCodexVision(imgFiles, wrapped, runDir);
  try { await fsp.rm(runDir, { recursive: true, force: true }); } catch {}

  const result = extractLastJson(stdout);
  if (!result) {
    return { status: 502, json: { error: "codex produced no json", code, stderr: stderr.slice(-1500), stdout: stdout.slice(-1500) } };
  }
  return { status: 200, json: { ok: true, result } };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, genDir: GEN_DIR, vision: true }));
    return;
  }

  const isGenerate = req.method === "POST" && url.pathname === "/generate";
  const isAnalyze = req.method === "POST" && url.pathname === "/analyze";
  if (!isGenerate && !isAnalyze) {
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
    // Raised for base64 reference/input images (product photo + frozen-hero anchors).
    if (data.length > 24_000_000) req.destroy();
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
    enqueue(() => (isAnalyze ? handleAnalyze(body) : handleGenerate(body)))
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
