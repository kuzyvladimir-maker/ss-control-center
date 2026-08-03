/**
 * Every pilot-permit dereference must be reachable only from the pilot lane.
 *
 * Why this test exists. Studio publishing was split away from the frozen pilot
 * lane in four places: the permit assertion, the durable claim, the feed POST,
 * and the permit-to-payload binding check. Three were done. The fourth was
 * keyed on `walmartApplyCandidates` — EVERY Walmart listing — and dereferenced
 * `input.walmartPilotPermit!` unconditionally, so a studio listing (which has
 * no permit and must not have one) died with:
 *
 *     Cannot read properties of undefined (reading 'signedPermit')
 *
 * Nothing caught it, because each individual site looked correct in isolation.
 * The invariant is a property of the FILE, not of any one block: a non-optional
 * read of the pilot permit may only appear where the pilot lane is already
 * established.
 *
 * This is a source-level guard on purpose. Exercising runDistribution end to end
 * would need the whole marketplace stack stood up; the defect lives in control
 * flow, and control flow is what this reads.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PIPELINE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../distribution-pipeline.ts",
);

/**
 * Things that establish "the pilot lane, or a permit that provably exists".
 *
 * Checked by proximity rather than by parsing blocks: a brace tracker over a
 * thousand lines of TypeScript drifts on object literals and template strings,
 * and a guard that quietly stops working is worse than no guard. Proximity is
 * crude but it does not lie, and it is exactly what failed in the real defect —
 * there, the nearest guard above was sixty lines and two blocks away.
 */
const PILOT_GUARDS = [
  /\bpilotApplyCandidates\b/,
  /\bisWalmartStudioLane\s*\(/,
  /\bif\s*\(\s*!input\.walmartPilotPermit\s*\)/,
  // `...(input.walmartPilotPermit ? { … } : {})` — a presence check.
  // The `m` flag matters: the window is several lines joined, and the guard
  // ends its own line rather than the window.
  /\(\s*input\.walmartPilotPermit\s*$/m,
];

/** How far above a dereference its guard may sit and still govern it. */
const GUARD_LOOKBACK = 20;

/** A read that will throw if the permit is absent. `?.` and truthiness are safe. */
function isUnsafeRead(line) {
  const stripped = line.replace(/\/\/.*$/, "");
  if (!/input\.walmartPilotPermit/.test(stripped)) return false;
  if (/input\.walmartPilotPermit\?\./.test(stripped)) return false;
  // `if (!input.walmartPilotPermit)` and `input.walmartPilotPermit ? ... : ...`
  // and `walmartPilotPermit: input.walmartPilotPermit,` are all safe reads.
  return /input\.walmartPilotPermit\s*[!.]/.test(stripped)
    && !/input\.walmartPilotPermit\s*$/.test(stripped.trim())
    && !/^\s*(if\s*\(\s*)?!input\.walmartPilotPermit/.test(stripped.trim());
}

test("no pilot-permit dereference is reachable from a studio listing", () => {
  const lines = readFileSync(PIPELINE, "utf8").split("\n");
  const violations = [];

  lines.forEach((line, index) => {
    if (!isUnsafeRead(line)) return;
    const window = lines
      .slice(Math.max(0, index - GUARD_LOOKBACK), index + 1)
      .map((text) => text.replace(/\/\/.*$/, ""))
      .join("\n");
    if (!PILOT_GUARDS.some((pattern) => pattern.test(window))) {
      violations.push(`${index + 1}: ${line.trim()}`);
    }
  });

  assert.deepEqual(
    violations,
    [],
    `A studio listing can reach a pilot-permit dereference:\n${violations.join("\n")}\n\n`
      + "Key the block on pilotApplyCandidates, not walmartApplyCandidates.",
  );
});

test("the permit-to-payload binding check is keyed on the pilot lane", () => {
  const source = readFileSync(PIPELINE, "utf8");

  // The exact regression: selecting the SKU to bind from every Walmart
  // candidate rather than from the pilot ones.
  assert.doesNotMatch(
    source,
    /const sku = walmartApplyCandidates\[0\]/,
    "The permit binding check must select from pilotApplyCandidates — "
      + "walmartApplyCandidates includes studio listings, which have no permit.",
  );
  assert.match(
    source,
    /const sku = pilotApplyCandidates\[0\]/,
    "The permit binding check must still exist for the pilot lane.",
  );
});

test("the studio lane keeps its own binding, so nothing is merely skipped", () => {
  const source = readFileSync(PIPELINE, "utf8");

  // A studio listing is not exempt from proving the payload it sends is the one
  // that was approved — the proof is just a different artifact.
  assert.match(
    source,
    /approval\.marketplace_payload_sha256/,
    "Studio publishing must still verify the prepared payload against the "
      + "sealed distribution approval.",
  );
  assert.match(
    source,
    /assertCurrentWalmartDistributionApproval/,
    "The sealed approval must be re-asserted immediately before the POST.",
  );
});
