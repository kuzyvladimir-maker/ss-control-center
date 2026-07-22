import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadListingIntegrityShadowData } from "../listing-integrity-shadow.server.ts";

const ROOT = path.resolve(
  import.meta.dirname,
  "../../../..",
  "data/audits/walmart-listing-integrity-fresh-controls",
);

test("projects the fresh quantity-confusion control into read-only Command Center data", async () => {
  const data = await loadListingIntegrityShadowData(ROOT);
  assert.equal(data.mode, "SHADOW_READ_ONLY");
  assert.equal(data.engine.closedLoopTestsPassed, 109);
  assert.equal(data.engine.focusedTestsPassed, 37);
  assert.equal(data.engine.shadowTestsPassed, 4);
  assert.equal(data.engine.walmartWrites, 0);
  assert.equal(data.gates.liveCanary, "LOCKED");
  assert.equal(data.gates.massRun, "LOCKED");
  assert.equal(data.cases.length, 1);

  const control = data.cases[0];
  assert.equal(control.sku, "FaisalX-1183");
  assert.equal(control.itemId, "8419413379");
  assert.equal(control.expectedOuterUnits, 6);
  assert.equal(control.observedMainUnits, 1);
  assert.equal(control.beforeVerdict, "BAD");
  assert.equal(control.proposedMainVerdict, "PASS");
  assert.equal(control.proposedMain.representedOuterUnits, 6);
  assert.equal(control.byteCustodyStatus, "VERIFIED");
  assert.equal(control.visualAttestationStatus, "PENDING");
  assert.deepEqual(control.changedFields, ["MAIN"]);
  assert.equal(control.currentImages.length, 3);
});

test("missing evidence root remains a safe empty shadow view", async () => {
  const data = await loadListingIntegrityShadowData(path.join(ROOT, "does-not-exist"));
  assert.deepEqual(data.cases, []);
  assert.equal(data.gates.massRun, "LOCKED");
});

test("finds MAIN by slot instead of trusting image order", async (t) => {
  const source = JSON.parse(await readFile(
    path.join(ROOT, "FaisalX-1183-20260722T122025Z/manifest.json"),
    "utf8",
  ));
  source.current_images.reverse();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "listing-integrity-shadow-"));
  t.after(async () => {
    await rm(tempRoot, { recursive: true });
  });
  const caseRoot = path.join(tempRoot, "reordered-control");
  await mkdir(caseRoot);
  const manifestBytes = Buffer.from(JSON.stringify(source));
  await writeFile(path.join(caseRoot, "manifest.json"), manifestBytes);
  const preview = JSON.parse(await readFile(
    path.join(ROOT, "FaisalX-1183-20260722T122025Z/canary-preview.json"),
    "utf8",
  ));
  preview.source_manifest.sha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const previewBytes = Buffer.from(JSON.stringify(preview));
  await writeFile(path.join(caseRoot, "canary-preview.json"), previewBytes);
  await writeFile(
    path.join(caseRoot, "canary-preview.sha256"),
    createHash("sha256").update(previewBytes).digest("hex"),
  );
  await writeFile(
    path.join(tempRoot, "_verification.json"),
    await readFile(path.join(ROOT, "_verification.json")),
  );
  await writeFile(
    path.join(tempRoot, "_verification.sha256"),
    await readFile(path.join(ROOT, "_verification.sha256")),
  );

  const data = await loadListingIntegrityShadowData(tempRoot);
  assert.equal(data.cases[0].observedMainUnits, 1);
});
