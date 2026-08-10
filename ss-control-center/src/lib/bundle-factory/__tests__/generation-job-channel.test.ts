import assert from "node:assert/strict";
import test from "node:test";

import { generationJobTargetsWalmart } from "@/lib/bundle-factory/generation-job-channel";

test("identifies every explicit Walmart generation-job shape", () => {
  for (const job of [
    { current_stage: "WALMART_DRAFT_QUEUE", brief: "{}" },
    { current_stage: "IN_PROGRESS", brief: JSON.stringify({ channel: "WALMART" }) },
    { current_stage: "IN_PROGRESS", brief: JSON.stringify({ marketplace: "walmart" }) },
    { current_stage: "IN_PROGRESS", brief: JSON.stringify({ target_channels: ["AMAZON_SALUTEM", "WALMART"] }) },
    { current_stage: "IN_PROGRESS", brief: JSON.stringify({ workflow: "CANONICAL_WALMART_NEW_SKU" }) },
    { current_stage: "IN_PROGRESS", brief: JSON.stringify({ walmart_shipping: {} }) },
  ]) {
    assert.equal(generationJobTargetsWalmart(job), true);
  }
});

test("does not suppress Amazon jobs or prompt prose", () => {
  assert.equal(generationJobTargetsWalmart({
    current_stage: "IN_PROGRESS",
    brief: JSON.stringify({ channel: "AMAZON_SALUTEM", prompt: "compare with Walmart" }),
  }), false);
  assert.equal(generationJobTargetsWalmart({ current_stage: "IN_PROGRESS", brief: "not-json" }), false);
});
