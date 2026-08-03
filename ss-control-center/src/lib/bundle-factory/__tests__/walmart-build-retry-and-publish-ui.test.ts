import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

test("a failed build can be re-queued without touching the database", async () => {
  const route = await read(
    "../../../app/api/bundle-factory/walmart/builds/[id]/retry/route.ts",
  );
  // Only FAILED items of THIS build, and the attempt budget starts over —
  // otherwise the engine would burn the retry immediately on its old count.
  assert.match(route, /status: "FAILED"/u);
  assert.match(route, /attempts: 0/u);
  assert.match(route, /generation_job_id: job\.id/u);
  // A non-Walmart build must not be reset through this route.
  assert.match(route, /WALMART_STUDIO_WORKFLOWS\.has\(workflow\)/u);
  // The lane cannot reach a marketplace, which is why re-running is allowed
  // at all; keep that reasoning attached to the code.
  assert.match(route, /cannot mutate a\n \* marketplace/u);

  const progress = await read(
    "../../../components/bundle-factory/BatchProgress.tsx",
  );
  assert.match(progress, /canRetryFailed/u);
  assert.match(progress, /builds\/\$\{batchId\}\/retry/u);
});

test("the drafts list publishes one row or a whole batch, but asks first", async () => {
  const cell = await read("../../../components/bundle-factory/DraftsTable.tsx");
  // Publishing is irreversible: the row confirms before it posts.
  assert.match(cell, /confirming \? \(/u);
  assert.match(cell, /approvalConfirmed: true/u);
  assert.match(cell, /dryRun=false/u);
  // Only a PASSED SKU that has not gone out offers the button at all.
  assert.match(cell, /validation_status === "PASSED"/u);
  // Progress is visible rather than a silent request.
  assert.match(cell, /publishing…/u);

  // Batch: tick a selection, one press, and the confirmation states the count
  // and that it cannot be undone.
  assert.match(cell, /Publish selected \(\{selectedPublishable\.length\}\)/u);
  assert.match(cell, /cannot be undone/u);
  // Each listing is its own claim and its own POST — never one shared request.
  assert.match(cell, /for \(const \[index, row\] of selectedPublishable\.entries\(\)\)/u);
});
