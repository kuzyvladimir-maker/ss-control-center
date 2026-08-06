/**
 * A standing rule needs a guard, not a memo.
 *
 * Owner instruction 2026-08-06: no paid API tokens, ever. Every language-model
 * call rides his Claude Max / ChatGPT Pro subscription through the box worker.
 *
 * The rule was already half-true and nobody noticed: content generation
 * "preferred" the subscription and silently fell back to the paid API, and the
 * subscription endpoint it called had never been deployed — so every call went
 * to the paid path, which had no credit. A fallback hid a dead endpoint for
 * weeks. This test exists so that cannot happen quietly again.
 *
 * ALLOWED is the debt that has not been paid down yet, listed by name. It may
 * only ever shrink. Adding a file to it is not a fix.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Tests run from the app root, and this file must not care how it was loaded.
const ROOT = path.resolve(process.cwd(), "src");

/** Constructing a client, or hitting a provider endpoint directly. */
const PAID_CALL = /new\s+Anthropic\s*\(|new\s+OpenAI\s*\(|api\.anthropic\.com|api\.openai\.com/;

/**
 * Empty, and it must stay that way.
 *
 * Every language-model call in this platform — text and vision — runs on a
 * subscription through the box worker. There is nothing left to exempt, so a
 * name appearing here again means someone reintroduced a paid API call.
 */
const ALLOWED = new Set([
]);

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "generated") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
    } else if (/\.tsx?$/.test(entry) && !full.includes("__tests__")) {
      found.push(full);
    }
  }
  return found;
}

test("no new file reaches a paid language-model API", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(ROOT)) {
    const relative = path.relative(ROOT, file);
    if (ALLOWED.has(relative)) continue;
    if (PAID_CALL.test(readFileSync(file, "utf8"))) offenders.push(relative);
  }
  assert.deepEqual(
    offenders,
    [],
    "These files call a paid language-model API. Route them through the "
    + "subscription worker (src/lib/llm/subscription.ts or "
    + "src/lib/text-gen/claude-text-worker.ts) instead:\n  "
    + offenders.join("\n  "),
  );
});

test("the allow-list only ever shrinks", () => {
  // A name left here after the file stopped offending is a stale exemption that
  // would silently re-permit a paid call if someone reintroduced one.
  const stale: string[] = [];
  for (const relative of ALLOWED) {
    let source: string;
    try {
      source = readFileSync(path.join(ROOT, relative), "utf8");
    } catch {
      stale.push(`${relative} (gone)`);
      continue;
    }
    if (!PAID_CALL.test(source)) stale.push(`${relative} (already clean)`);
  }
  assert.deepEqual(stale, [], `Remove these from ALLOWED:\n  ${stale.join("\n  ")}`);
});
