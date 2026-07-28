// Orchestrator-level tests for runComplianceGate. Run with:
//   npx tsx --test src/lib/bundle-factory/compliance/__tests__/gate.test.ts
//
// We exercise 6 fixture scenarios. None of them pass `bundle_draft_id`,
// so persistence is skipped and the test does not require a database.
// (The DB-write path is covered indirectly by the smoke test, which runs
// against a real Turso connection.)

import { test } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "@/lib/prisma";
import { runComplianceGate } from "../gate";
import type { ComplianceInput } from "../types";

// All gate tests bypass Rule 7's DB query.
const origBcFind = prisma.brandConflict.findMany;
(prisma.brandConflict as { findMany: unknown }).findMany = async () => [];

function clean(): ComplianceInput {
  return {
    title: "Salutem Vita Curated Snack Variety Gift Basket",
    brand: "Salutem Vita",
    bullets: [
      "Curated and assembled by Salutem Solutions LLC as a gift basket.",
      "Includes 5 different shelf-stable snack varieties.",
      "Each item retains its original retail packaging.",
    ],
    description:
      "Variety snack gift basket. " +
      "This gift basket is curated and assembled by Salutem Solutions LLC. " +
      "The included items are packaged by their original manufacturers.",
    browse_node: "12011207011",
    main_image_url: null,
    bundle_components: [{ brand: "Salutem Vita" }],
    skip_image_check: true,
  };
}

test("clean fixture → CAN_PUBLISH, all 8 rules pass", async () => {
  const d = await runComplianceGate(clean());
  assert.equal(d.decision, "CAN_PUBLISH");
  assert.equal(d.rules.length, 8);
  assert.equal(d.rules.every((r) => r.passed), true);
});

test("5-ASIN incident replay → BLOCKED with title_foreign_brand", async () => {
  const input = clean();
  input.title =
    "Salutem Vita Spongebob Shapes Mac & Cheese Microwavable Cups Gift Set";
  const d = await runComplianceGate(input);
  assert.equal(d.decision, "BLOCKED");
  const failed = d.rules.filter((r) => !r.passed).map((r) => r.rule_id);
  assert.ok(
    failed.includes("rule-1-title-foreign-brands"),
    `expected rule-1 in failed, got ${failed.join(", ")}`,
  );
});

test("missing disclaimer + autoFix=true → CAN_PUBLISH with injected disclaimer", async () => {
  const input = clean();
  input.bullets = ["Includes 5 snack varieties.", "Each item shelf-stable."];
  input.description = "Variety pack of snacks.";
  const d = await runComplianceGate(input, { autoFix: true });
  assert.equal(d.decision, "CAN_PUBLISH");
  assert.equal(d.final_bullets.length, 3);
  assert.match(
    d.final_bullets[d.final_bullets.length - 1],
    /curated and assembled by salutem/i,
  );
  assert.match(d.final_description, /curated and assembled by salutem/i);
});

test("missing disclaimer + autoFix=false → BLOCKED on rules 3 + 4", async () => {
  const input = clean();
  input.bullets = ["Includes 5 snack varieties."];
  input.description = "Plain description.";
  const d = await runComplianceGate(input);
  assert.equal(d.decision, "BLOCKED");
  const failed = d.rules.filter((r) => !r.passed).map((r) => r.rule_id);
  assert.ok(failed.includes("rule-3-disclaimer-bullets"));
  assert.ok(failed.includes("rule-4-disclaimer-description"));
});

test("multi-brand under non-exception node → BLOCKED on rule 5", async () => {
  const input = clean();
  input.bundle_components = [
    { brand: "Salutem Vita" },
    { brand: "Hershey's" },
    { brand: "Lindt" },
  ];
  input.browse_node = "16310091"; // grocery, not gift basket
  const d = await runComplianceGate(input);
  assert.equal(d.decision, "BLOCKED");
  const failed = d.rules.filter((r) => !r.passed).map((r) => r.rule_id);
  assert.ok(failed.includes("rule-5-browse-node"));
});

test("promotional words → BLOCKED on rule 8", async () => {
  const input = clean();
  input.title = "Salutem Vita Premium Ultimate Gift Basket";
  const d = await runComplianceGate(input);
  assert.equal(d.decision, "BLOCKED");
  const failed = d.rules.filter((r) => !r.passed).map((r) => r.rule_id);
  assert.ok(failed.includes("rule-8-promotional-language"));
});

// Restore prisma stub at end so other test files don't inherit it.
test("[cleanup] restore prisma.brandConflict.findMany", () => {
  (prisma.brandConflict as { findMany: unknown }).findMany = origBcFind;
  assert.ok(true);
});
