/**
 * Phase 2.0 Compliance Gate — smoke test (4 realistic cases).
 *
 * Runs the gate orchestrator against four hand-built ComplianceInputs
 * that exercise the four canonical scenarios:
 *
 *   1. CLEAN              — should return CAN_PUBLISH with all 8 rules
 *                            passing.
 *   2. INCIDENT_REPLAY    — recreates the 2026-05-17 Kraft / Spongebob
 *                            title pattern; should hit rule-1 (title
 *                            foreign brand) and rule-7 (permanent
 *                            blocklist, if the BrandConflict seed is
 *                            present).
 *   3. AUTO_FIX           — missing disclaimer; autoFix:true; should
 *                            auto-inject and return CAN_PUBLISH.
 *   4. PROMOTIONAL        — promotional adjectives + health claims;
 *                            should hit rule-8.
 *
 * No DB writes: the script does NOT pass `bundle_draft_id`. Vision check
 * is skipped via `skip_image_check: true` to keep this $0.
 *
 * Run:
 *   set -a; source .env.local; set +a
 *   npx tsx scripts/smoke-test-compliance-gate.ts
 */

import "dotenv/config";
import { runComplianceGate } from "@/lib/bundle-factory/compliance/gate";
import type { ComplianceInput } from "@/lib/bundle-factory/compliance/types";

interface Case {
  name: string;
  expected: "CAN_PUBLISH" | "BLOCKED";
  expectedFailedRules?: string[];
  autoFix?: boolean;
  input: ComplianceInput;
}

const cases: Case[] = [
  {
    name: "CLEAN",
    expected: "CAN_PUBLISH",
    input: {
      title: "Salutem Vita Curated Snack Variety Gift Basket",
      brand: "Salutem Vita",
      bullets: [
        "Curated and assembled by Salutem Solutions LLC as a gift basket.",
        "Includes 5 different shelf-stable snack varieties.",
        "Each item retains its original retail packaging.",
        "Packaged in a recyclable gift box for direct shipping.",
      ],
      description:
        "Variety snack gift basket. This gift basket is curated and " +
        "assembled by Salutem Solutions LLC. The included items are " +
        "packaged by their original manufacturers.",
      browse_node: "12011207011",
      main_image_url: null,
      bundle_components: [{ brand: "Salutem Vita", product_name: "Snack mix" }],
      skip_image_check: true,
    },
  },
  {
    name: "INCIDENT_REPLAY",
    expected: "BLOCKED",
    expectedFailedRules: ["rule-1-title-foreign-brands"],
    input: {
      title:
        "Salutem Vita Spongebob Shapes Mac & Cheese Microwavable Cups Gift Set",
      brand: "Salutem Vita",
      bullets: [
        "Curated and assembled by Salutem Solutions LLC as a gift basket.",
        "Includes 4 microwavable cups of Spongebob-shaped mac & cheese.",
      ],
      description:
        "Gift set containing 4 Kraft Spongebob Mac & Cheese microwavable " +
        "cups. This gift basket is curated and assembled by Salutem " +
        "Solutions LLC. The included items are packaged by their original " +
        "manufacturers.",
      browse_node: "12011207011",
      main_image_url: null,
      bundle_components: [{ brand: "Kraft", product_name: "Mac & Cheese Cups" }],
      skip_image_check: true,
    },
  },
  {
    name: "AUTO_FIX",
    expected: "CAN_PUBLISH",
    autoFix: true,
    input: {
      title: "Salutem Vita Coffee & Tea Variety Gift Basket",
      brand: "Salutem Vita",
      bullets: [
        "Includes 6 coffee pods and 6 tea bags.",
        "Variety of regular and decaf options.",
        "Ready for direct shipping in a recyclable gift box.",
      ],
      description: "A variety pack of coffee and tea for gifting.",
      browse_node: "23900459011",
      main_image_url: null,
      bundle_components: [
        { brand: "Salutem Vita", product_name: "Coffee Pods" },
      ],
      skip_image_check: true,
    },
  },
  {
    name: "PROMOTIONAL",
    expected: "BLOCKED",
    expectedFailedRules: ["rule-8-promotional-language"],
    input: {
      title:
        "Salutem Vita Ultimate Premium Best Snack Gift Basket (#1 Bestseller)",
      brand: "Salutem Vita",
      bullets: [
        "Curated and assembled by Salutem Solutions LLC as a gift basket.",
        "Includes the perfect selection of premium snacks for any occasion.",
        "An incredible, delightful variety for the discerning gift recipient.",
      ],
      description:
        "Discover the ultimate snack experience. This gift basket is " +
        "curated and assembled by Salutem Solutions LLC. The included " +
        "items are packaged by their original manufacturers.",
      browse_node: "12011207011",
      main_image_url: null,
      bundle_components: [{ brand: "Salutem Vita" }],
      skip_image_check: true,
    },
  },
];

function summarise(decision: Awaited<ReturnType<typeof runComplianceGate>>) {
  return {
    decision: decision.decision,
    cost_cents: decision.cost_cents,
    failed: decision.rules
      .filter((r) => !r.passed)
      .map((r) => ({
        rule_id: r.rule_id,
        reason: r.reason ?? null,
      })),
    detected_brands: decision.detected_brands,
    detected_logos: decision.detected_logos,
  };
}

async function main() {
  console.log("Phase 2.0 Compliance Gate — smoke test\n");
  let failures = 0;
  for (const c of cases) {
    process.stdout.write(`Case "${c.name}" → `);
    const decision = await runComplianceGate(c.input, {
      autoFix: c.autoFix ?? false,
      actor: "claude_code:smoke",
    });
    const result = summarise(decision);
    const ok = decision.decision === c.expected;
    const ruleOk = c.expectedFailedRules
      ? c.expectedFailedRules.every((rid) =>
          result.failed.some((f) => f.rule_id === rid),
        )
      : true;
    if (ok && ruleOk) {
      console.log("[32mPASS[0m");
    } else {
      failures += 1;
      console.log("[31mFAIL[0m");
      console.log(
        `   expected ${c.expected}` +
          (c.expectedFailedRules
            ? ` with rules: ${c.expectedFailedRules.join(", ")}`
            : ""),
      );
    }
    console.log("  " + JSON.stringify(result, null, 2).replace(/\n/g, "\n  "));
    console.log("");
  }
  if (failures > 0) {
    console.error(`\n${failures}/${cases.length} case(s) failed.`);
    process.exit(1);
  }
  console.log(`All ${cases.length} cases passed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
