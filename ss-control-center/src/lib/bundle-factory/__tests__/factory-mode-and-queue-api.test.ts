import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FACTORY_MODE_DEFAULT,
  FACTORY_MODES,
  isFactoryMode,
} from "../factory-mode";

async function read(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

test("the factory starts semi-automatic and never publishes unasked", () => {
  // Publication is the owner's decision until he flips the switch himself; a
  // freshly deployed schedule must not surprise anyone with live listings.
  assert.equal(FACTORY_MODE_DEFAULT, "SEMI_AUTO");
  assert.deepEqual([...FACTORY_MODES], ["SEMI_AUTO", "AUTO"]);
  assert.equal(isFactoryMode("AUTO"), true);
  assert.equal(isFactoryMode("auto"), false, "the stored value is exact");
  assert.equal(isFactoryMode("ON"), false);
});

test("only AUTO lets the schedule start a batch by itself", async () => {
  const cron = await read("../../../app/api/cron/bundle-factory-publish/route.ts");
  assert.match(cron, /mode === "AUTO" && cap\.remaining > 0/u);
  // Open batches are advanced in BOTH modes — a batch a person queued is
  // already their decision, and the backstop is what makes it survive a closed
  // tab.
  assert.match(cron, /listOpenPublishBatches\(5\)/u);
  // A listing whose product ID is dead cannot succeed; the ceiling must not be
  // spent on it.
  assert.match(cron, /status: "QUARANTINED"/u);
  // The endpoint can start marketplace writes, so it is gated like every cron.
  assert.match(cron, /CRON_SECRET/u);
});

test("queueing a batch states the decision once, for a known count", async () => {
  const route = await read("../../../app/api/bundle-factory/publish-batches/route.ts");
  assert.match(route, /approvalConfirmed !== true/u);
  assert.match(route, /enqueuePublishBatch/u);

  const table = await read("../../../components/bundle-factory/DraftsTable.tsx");
  // The batch must live on the server, not in a loop inside the page.
  assert.match(table, /api\/bundle-factory\/publish-batches/u);
  assert.doesNotMatch(
    table,
    /for \(const \[index, row\] of selectedPublishable\.entries\(\)\)/u,
    "the browser no longer walks the batch itself",
  );
});
