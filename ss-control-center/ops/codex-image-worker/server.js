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
const { createHash } = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { buildPrompt, REQUIRED_IMAGE_MODEL } = require("./prompt");
const { hasSupportedImageSignature } = require("./image-preflight");

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
const WORKER_BUILD =
  "sha256:" + createHash("sha256")
    .update(fs.readFileSync(__filename))
    .update("\0")
    .update(fs.readFileSync(require.resolve("./image-preflight")))
    .digest("hex");

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

// --- SECOND lane: Claude CLI vision (its own serial queue) ---------------------
// The Claude Max-subscription worker runs on a SEPARATE chain so it executes
// CONCURRENTLY with the Codex lane — two subscriptions = two parallel vision
// workers (~2x throughput on a big backlog sweep). Both are $0/call.
let claudeChain = Promise.resolve();
function enqueueClaude(fn) {
  const run = claudeChain.then(fn, fn);
  claudeChain = run.then(() => {}, () => {});
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
async function writeRefs(refs, urls, runDir, options = {}) {
  const files = [];
  const failures = [];
  let i = 0;
  const base64Refs = Array.isArray(refs) ? refs : [];
  const urlRefs = Array.isArray(urls) ? urls : [];
  for (let index = 0; index < base64Refs.length; index++) {
    const b64 = base64Refs[index];
    try {
      const clean = String(b64).replace(/^data:image\/\w+;base64,/, "");
      const buf = Buffer.from(clean, "base64");
      if (buf.length === 0) throw new Error("decoded image is empty");
      if (!hasSupportedImageSignature(buf)) throw new Error("decoded bytes are not a supported raster image");
      const p = path.join(runDir, `ref-${++i}.png`);
      await fsp.writeFile(p, buf);
      files.push(p);
    } catch (error) {
      failures.push(`reference_images[${index}]: ${error && error.message ? error.message : "invalid image"}`);
    }
  }
  for (let index = 0; index < urlRefs.length; index++) {
    const u = urlRefs[index];
    try {
      const res = await fetch(String(u));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error("downloaded image is empty");
      if (!hasSupportedImageSignature(buf)) throw new Error("downloaded bytes are not a supported raster image");
      const p = path.join(runDir, `ref-${++i}.png`);
      await fsp.writeFile(p, buf);
      files.push(p);
    } catch (error) {
      failures.push(`reference_urls[${index}]: ${error && error.message ? error.message : "unreachable image"}`);
    }
  }
  if (options.strict && failures.length > 0) {
    throw new Error(`reference preflight failed: ${failures.join("; ")}`);
  }
  return files;
}

async function stageVisionImages(body, runDir) {
  const refs = body && (body.images || body.reference_images);
  const urls = body && (body.image_urls || body.reference_urls);
  const expected =
    (Array.isArray(refs) ? refs.length : 0) +
    (Array.isArray(urls) ? urls.length : 0);
  if (expected < 1) throw new Error("no images");
  const files = await writeRefs(refs, urls, runDir, { strict: true });
  if (files.length !== expected) {
    throw new Error(`input image count mismatch: expected ${expected}, staged ${files.length}`);
  }
  return files;
}

function visionMetadata(provider, inputImageCount) {
  return {
    input_image_count: inputImageCount,
    vision_provider: provider,
    worker_build: WORKER_BUILD,
  };
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

async function handleGenerate(body) {
  const prompt = String((body && body.prompt) || "").trim();
  if (!prompt) return { status: 400, json: { error: "missing prompt" } };
  const requiredModel = String(
    (body && body.required_model) || REQUIRED_IMAGE_MODEL,
  ).trim();
  if (requiredModel !== REQUIRED_IMAGE_MODEL) {
    return {
      status: 422,
      json: {
        error: `unsupported required_model ${requiredModel}; this worker is pinned to ${REQUIRED_IMAGE_MODEL}`,
      },
    };
  }
  const size = body && body.size;

  // Per-run working dir so reference images are isolated + auto-cleaned.
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-img-"));
  let refFiles = [];
  try {
    refFiles = await writeRefs(
      body && body.reference_images,
      body && body.reference_urls,
      runDir,
      { strict: true },
    );
  } catch (error) {
    try { await fsp.rm(runDir, { recursive: true, force: true }); } catch {}
    return {
      status: 422,
      json: {
        error: error && error.message ? error.message : "reference preflight failed",
      },
    };
  }

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
  return { status: 200, png, imageModel: REQUIRED_IMAGE_MODEL, referenceCount: refFiles.length };
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

    // `-i, --image <FILE>...` is VARIADIC — a trailing positional prompt would be
    // swallowed as another image file. So we pass images via -i and feed the PROMPT
    // on STDIN (codex exec reads the prompt from stdin when no positional is given).
    const args = ["exec", "--skip-git-repo-check"];
    for (const f of imgFiles) { args.push("-i", f); }

    const child = spawn(CODEX_BIN, args, { env, cwd: cwd || os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    try { child.stdin.write(prompt); child.stdin.end(); } catch { /* child may have exited */ }
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
    imgFiles = await stageVisionImages(body, runDir);
  } catch (error) {
    try { await fsp.rm(runDir, { recursive: true, force: true }); } catch {}
    return {
      status: 422,
      json: {
        ok: false,
        error: error && error.message ? error.message : "image preflight failed",
        ...visionMetadata("codex_cli_subscription", 0),
      },
    };
  }

  const names = imgFiles.map((f) => path.basename(f)).join(", ");
  const wrapped =
    `${prompt}\n\n` +
    `The image file(s) ${names} are attached to this message — look at them. ` +
    `Respond with ONLY a single JSON object (no markdown, no code fences, no prose, no explanation). ` +
    `Do NOT generate or create any image. Do NOT ask questions or request confirmation.`;

  const { code, stdout, stderr } = await runCodexVision(imgFiles, wrapped, runDir);
  try { await fsp.rm(runDir, { recursive: true, force: true }); } catch {}

  if (code !== 0) {
    return {
      status: 502,
      json: {
        ok: false,
        error: `codex vision exited with code ${code}`,
        ...visionMetadata("codex_cli_subscription", imgFiles.length),
        stderr: stderr.slice(-1500),
        stdout: stdout.slice(-1500),
      },
    };
  }

  const result = extractLastJson(stdout);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return {
      status: 502,
      json: {
        ok: false,
        error: "codex produced no json object",
        ...visionMetadata("codex_cli_subscription", imgFiles.length),
        code,
        stderr: stderr.slice(-1500),
        stdout: stdout.slice(-1500),
      },
    };
  }
  return {
    status: 200,
    json: {
      ok: true,
      result,
      ...visionMetadata("codex_cli_subscription", imgFiles.length),
    },
  };
}

// --- VISION via the Claude Code CLI (SECOND subscription worker) ----------------
// Mirrors the Codex analyze path but on the Claude Max subscription ($0/call).
// Claude Code READS the attached image files (its Read tool renders images
// visually) and answers with JSON. `--output-format json` wraps the answer as
// { result: "<text>", ... }; we unwrap then extract the JSON object from the text.
// Uses a STRONG model (sonnet) — cheap tiers mis-identify products. ANTHROPIC_API_KEY
// is stripped so it uses the subscription OAuth (in ~/.claude/.credentials.json),
// never the paid API.
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CLAUDE_VISION_MODEL = process.env.CLAUDE_VISION_MODEL || "sonnet";
function runClaudeVision(imgFiles, prompt) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // subscription OAuth only, never the paid API
    const args = [
      "-p", prompt, "--output-format", "json",
      "--allowedTools", "Read", "--permission-mode", "bypassPermissions",
      "--model", CLAUDE_VISION_MODEL, "--max-turns", "6",
    ];
    const child = spawn(CLAUDE_BIN, args, { env, cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const cap = (s, d) => { s += d.toString(); return s.length > 400000 ? s.slice(-400000) : s; };
    child.stdout.on("data", (d) => { stdout = cap(stdout, d); });
    child.stderr.on("data", (d) => { stderr = cap(stderr, d); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve({ code: -1, stdout, stderr: stderr + "\n[worker] claude vision timed out" }); }, VISION_TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + "\n[worker] claude spawn error: " + e.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function handleAnalyzeClaude(body) {
  const prompt = String((body && body.prompt) || "").trim();
  if (!prompt) return { status: 400, json: { error: "missing prompt" } };
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "claude-vis-"));
  let imgFiles = [];
  try {
    imgFiles = await stageVisionImages(body, runDir);
  } catch (error) {
    try { await fsp.rm(runDir, { recursive: true, force: true }); } catch {}
    return {
      status: 422,
      json: {
        ok: false,
        error: error && error.message ? error.message : "image preflight failed",
        ...visionMetadata("claude_cli_subscription", 0),
      },
    };
  }

  const wrapped =
    `${prompt}\n\n` +
    `Use the Read tool to view the image file(s): ${imgFiles.join(", ")}. ` +
    `Then respond with ONLY a single JSON object — no markdown, no code fences, no prose. ` +
    `Do NOT create, edit, or write any file; only read the image(s) and answer.`;

  const { code, stdout, stderr } = await runClaudeVision(imgFiles, wrapped);
  try { await fsp.rm(runDir, { recursive: true, force: true }); } catch {}

  if (code !== 0) {
    return {
      status: 502,
      json: {
        ok: false,
        error: `claude vision exited with code ${code}`,
        ...visionMetadata("claude_cli_subscription", imgFiles.length),
        stderr: stderr.slice(-1500),
        stdout: stdout.slice(-1500),
      },
    };
  }

  // Unwrap the Claude Code JSON envelope, then pull the JSON object out of .result.
  let text = stdout;
  try { const envlp = JSON.parse(stdout); if (envlp && typeof envlp.result === "string") text = envlp.result; } catch { /* not the envelope — scan raw */ }
  const result = extractLastJson(text) || extractLastJson(stdout);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return {
      status: 502,
      json: {
        ok: false,
        error: "claude produced no json object",
        ...visionMetadata("claude_cli_subscription", imgFiles.length),
        code,
        stderr: stderr.slice(-1500),
        stdout: stdout.slice(-1500),
      },
    };
  }
  return {
    status: 200,
    json: {
      ok: true,
      result,
      ...visionMetadata("claude_cli_subscription", imgFiles.length),
    },
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      genDir: GEN_DIR,
      vision: true,
      worker_build: WORKER_BUILD,
      vision_providers: ["codex_cli_subscription", "claude_cli_subscription"],
    }));
    return;
  }

  const isGenerate = req.method === "POST" && url.pathname === "/generate";
  const isAnalyze = req.method === "POST" && url.pathname === "/analyze";
  const isAnalyzeClaude = req.method === "POST" && url.pathname === "/analyze-claude";
  if (!isGenerate && !isAnalyze && !isAnalyzeClaude) {
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
    (isAnalyzeClaude
      ? enqueueClaude(() => handleAnalyzeClaude(body))
      : enqueue(() => (isAnalyze ? handleAnalyze(body) : handleGenerate(body))))
      .then((result) => {
        if (result.png) {
          res.writeHead(200, {
            "content-type": "image/png",
            "content-length": result.png.length,
            "x-image-model": result.imageModel || REQUIRED_IMAGE_MODEL,
            "x-image-reference-count": String(result.referenceCount || 0),
          });
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
