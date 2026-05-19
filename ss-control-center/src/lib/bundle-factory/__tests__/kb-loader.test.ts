// Unit tests for kb-loader. Run with:
//   npx tsx --test src/lib/bundle-factory/__tests__/kb-loader.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadKnowledgeBase,
  enforceCacheMarkerLimit,
  type SystemBlockWithCache,
} from "../kb-loader";

test("loadKnowledgeBase('amazon') returns ≥1 block + all four amazon KB files", async () => {
  const r = await loadKnowledgeBase("amazon");
  assert.equal(r.template, "amazon");
  // We baked 4 files in src/lib/bundle-factory/kb-content/amazon/.
  assert.ok(r.blocks.length >= 3, `expected ≥3 blocks, got ${r.blocks.length}`);
  // No file should be missing in dev.
  assert.equal(r.missing.length, 0, `unexpected missing files: ${r.missing.join(", ")}`);
  // Each block carries cache_control: ephemeral.
  for (const b of r.blocks) {
    assert.equal(b.type, "text");
    assert.deepEqual(b.cache_control, { type: "ephemeral" });
    assert.ok(b.text.length > 10);
  }
});

test("loadKnowledgeBase('walmart') returns walmart blocks", async () => {
  const r = await loadKnowledgeBase("walmart");
  assert.equal(r.template, "walmart");
  assert.ok(r.blocks.length >= 3);
  assert.equal(r.missing.length, 0);
});

test("enforceCacheMarkerLimit collapses tail into one block when over limit", () => {
  const blocks: SystemBlockWithCache[] = Array.from({ length: 6 }, (_, i) => ({
    type: "text",
    text: `block ${i}`,
    cache_control: { type: "ephemeral" },
  }));
  const out = enforceCacheMarkerLimit(blocks, 4);
  assert.equal(out.length, 4);
  // Final block contains the merged tail content.
  assert.ok(out[3].text.includes("block 3"));
  assert.ok(out[3].text.includes("block 5"));
});

test("enforceCacheMarkerLimit is identity below limit", () => {
  const blocks: SystemBlockWithCache[] = [
    { type: "text", text: "a", cache_control: { type: "ephemeral" } },
    { type: "text", text: "b", cache_control: { type: "ephemeral" } },
  ];
  const out = enforceCacheMarkerLimit(blocks, 4);
  assert.equal(out.length, 2);
  assert.deepEqual(out, blocks);
});
