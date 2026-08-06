import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  WALMART_STUCK_AFTER_HOURS,
} from "../walmart-exception-queue";

test("the queue shows only what needs a person", async () => {
  const source = await readFile(
    new URL("../walmart-exception-queue.ts", import.meta.url),
    "utf8",
  );

  // A listing Walmart is still processing is NOT an exception: new items take
  // 60-90 minutes, measured. The threshold is what separates normal from stuck.
  assert.ok(WALMART_STUCK_AFTER_HOURS >= 2, "shorter than Walmart's own latency would cry wolf");
  assert.match(source, /processing \+= 1/u);

  // The worst case earns the loudest treatment: a page that exists and cannot
  // be bought earns nothing and complains to no one.
  assert.match(source, /PUBLISHED_NOT_BUYABLE/u);
  assert.match(source, /published && !observation\.buyable/u);

  // An unknown submission is read, never resent.
  assert.match(source, /never by sending again/u);

  // Oldest hurt first — two days broken outranks ten minutes broken.
  assert.match(source, /left\.since\.getTime\(\) - right\.since\.getTime\(\)/u);

  // Costs nothing to compute: every case comes from state we already recorded.
  assert.doesNotMatch(source, /oxylabs|unwrangle|fetch\(/iu);
});

test("healthy listings are a number, not rows", async () => {
  const page = await readFile(
    new URL("../../../app/bundle-factory/exceptions/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(page, /live and healthy/u);
  assert.match(page, /still processing/u);
  // Every row must say what to do, not just what is wrong.
  assert.match(page, /What to do/u);
});
