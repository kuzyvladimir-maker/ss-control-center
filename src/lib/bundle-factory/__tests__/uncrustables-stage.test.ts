/**
 * Stage-lib tests: mocked prisma/gate/promote, no DB, no network.
 * Run: npx tsx --test src/lib/bundle-factory/__tests__/uncrustables-stage.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  stageUncrustablesCandidate,
  DEFAULT_OPERATOR_DECLARED_QTY,
  type UncrustablesStageDeps,
} from "../uncrustables-stage";

const CANDIDATE = {
  slug: "test-60",
  title: "Test Bundle 60ct",
  bullets: ["b1", "b2"],
  description: "desc",
  mainImageUrl: "https://pub-abc.r2.dev/prod/test-60/main.png",
  packCount: 60,
  costCents: 7000,
  comps: [
    { flavor: "Peanut Butter & Chocolate Flavored Spread", qty: 20, donor_title: "choc donor" },
    { flavor: "Peanut Butter & Blueberry", qty: 40, donor_title: "blueberry donor" },
  ],
  briefSource: "uncrustables-studio-test",
  ownerOrder: "test order",
  actor: "test-actor",
};

function makeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Record<string, unknown[]> = {
    donorFind: [], jobCreate: [], draftCreate: [], contentCreate: [],
    contentUpdate: [], gate: [], promote: [], mbUpdate: [], skuUpdate: [],
  };
  const deps: UncrustablesStageDeps = {
    prisma: {
      donorProduct: {
        findFirst: async (args: any) => {
          calls.donorFind.push(args);
          return {
            id: `donor-${calls.donorFind.length}`,
            title: args.where.title,
            upc: "051500000000",
            mainImageUrl: "https://img/donor.png",
            offers: [{ price: 5.99, packSizeSeen: 8, pricePerUnit: 0.75 }],
          } as never;
        },
      },
      generationJob: {
        create: async (args: unknown) => (calls.jobCreate.push(args), { id: "job-1" }),
      },
      bundleDraft: {
        create: async (args: unknown) => (calls.draftCreate.push(args), { id: "draft-1" }),
        findUnique: async () => ({ master_bundle_id: "mb-1" }),
      },
      generatedContent: {
        create: async (args: unknown) => (calls.contentCreate.push(args), { id: "gc-1" }),
        update: async (args: unknown) => calls.contentUpdate.push(args),
      },
      masterBundle: {
        findUnique: async () => ({ packaging_spec: null }),
        update: async (args: unknown) => calls.mbUpdate.push(args),
      },
      channelSKU: {
        findMany: async () => [
          { id: "csku-1", sku: "AB-TEST-0001", upc: "756441000000", price_cents: 15399 },
        ],
        update: async (args: unknown) => calls.skuUpdate.push(args),
      },
    },
    donorUnitPriceCents: () => 98,
    runComplianceGate: async (payload: unknown) => {
      calls.gate.push(payload);
      return { decision: "CAN_PUBLISH", compliance_check_id: "cc-1", rules: [] };
    },
    promoteDraftToChannelSkus: async (draftId: string) => calls.promote.push(draftId),
    withVerifiedPhysicalPackageSpecs: (_spec, band) => ({ verified: band }),
    now: () => new Date("2026-07-27T00:00:00Z"),
    ...(overrides as object),
  };
  return { deps, calls };
}

test("happy path: job→draft→content→gate→promote→specs/qty, band by packCount", async () => {
  const { deps, calls } = makeDeps();
  const result = await stageUncrustablesCandidate(CANDIDATE, deps);
  assert.ok(result.ok);
  assert.equal(result.masterBundleId, "mb-1");
  assert.equal(result.skus[0].sku, "AB-TEST-0001");
  assert.equal(calls.promote[0], "draft-1");
  // 60ct → M band 13x13x15 / 256oz; qty = operator-declared default
  const skuUpdate = calls.skuUpdate[0] as { data: Record<string, unknown> };
  assert.equal(skuUpdate.data.package_height_in, 15);
  assert.equal(skuUpdate.data.package_weight_oz, 256);
  assert.equal(skuUpdate.data.available_quantity, DEFAULT_OPERATOR_DECLARED_QTY);
  // draft carries official allergens + ingredients in draft_components
  const draftData = (calls.draftCreate[0] as { data: { draft_components: string } }).data;
  const comps = JSON.parse(draftData.draft_components);
  assert.equal(comps[0].allergen_declaration.contains.includes("Peanuts"), true);
  assert.ok(comps[0].ingredients.length > 100);
});

test("R2-pattern guard: non-R2 MAIN rejected before any DB write", async () => {
  const { deps, calls } = makeDeps();
  const result = await stageUncrustablesCandidate(
    { ...CANDIDATE, mainImageUrl: "https://evil.example/main.png" },
    deps,
  );
  assert.ok(!result.ok && result.stage === "INPUT");
  assert.equal(calls.jobCreate.length, 0);
});

test("packCount must equal component sum", async () => {
  const { deps } = makeDeps();
  const result = await stageUncrustablesCandidate(
    { ...CANDIDATE, packCount: 61 },
    deps,
  );
  assert.ok(!result.ok && result.stage === "INPUT");
});

test("missing donor UPC without override blocks at DONOR stage", async () => {
  const { deps, calls } = makeDeps();
  (deps.prisma.donorProduct as { findFirst: unknown }).findFirst = async () =>
    ({ id: "d", title: "t", upc: null, mainImageUrl: null, offers: [] }) as never;
  const result = await stageUncrustablesCandidate(CANDIDATE, deps);
  assert.ok(!result.ok && result.stage === "DONOR");
  assert.match(result.error, /UPC/);
  assert.equal(calls.jobCreate.length, 0);
});

test("compliance BLOCKED stops before promote and reports failed rule ids", async () => {
  const { deps, calls } = makeDeps({
    runComplianceGate: async () => ({
      decision: "BLOCKED",
      rules: [
        { rule_id: "SALE_SHIPPING_CLAIM_BANNED", passed: false },
        { rule_id: "R2", passed: true },
      ],
    }),
  });
  const result = await stageUncrustablesCandidate(CANDIDATE, deps);
  assert.ok(!result.ok && result.stage === "COMPLIANCE");
  assert.deepEqual(result.blockedRuleIds, ["SALE_SHIPPING_CLAIM_BANNED"]);
  assert.equal(result.draftId, "draft-1");
  assert.equal(calls.promote.length, 0);
});

test("promote without master bundle → PROMOTE failure with draft kept for retry", async () => {
  const { deps } = makeDeps();
  (deps.prisma.bundleDraft as { findUnique: unknown }).findUnique = async () =>
    ({ master_bundle_id: null }) as never;
  const result = await stageUncrustablesCandidate(CANDIDATE, deps);
  assert.ok(!result.ok && result.stage === "PROMOTE");
  assert.equal(result.draftId, "draft-1");
});
