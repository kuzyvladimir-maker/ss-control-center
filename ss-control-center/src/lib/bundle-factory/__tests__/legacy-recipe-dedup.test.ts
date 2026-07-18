import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  buildLegacyRecipeDedupPlan,
  legacyRecipeAliasFingerprint,
  legacyRecipeSha256,
  recipeCompositionSignature,
  resolveLegacyRecipeAlias,
  verifyLegacyRecipeDedupPlan,
  type LegacyRecipeDedupLedgerLike,
  type LegacyRecipeDraftCandidate,
  type RecipeAliasInput,
} from "@/lib/bundle-factory/legacy-recipe-dedup";
import { parseLegacyRecipeDedupArgs } from "../../../../scripts/plan-legacy-recipe-dedup";

const strawberry: RecipeAliasInput = {
  brand: "Uncrustables",
  composition_type: "MIXED_FLAVOR",
  unit_count: 24,
  components: [
    { product_name: "Strawberry 10ct", qty: 12 },
    { product_name: "Grape 10ct", qty: 12 },
  ],
};

function candidate(overrides: Partial<LegacyRecipeDraftCandidate> = {}): LegacyRecipeDraftCandidate {
  return {
    id: "draft-1",
    generation_job_id: "job-1",
    brand: "Uncrustables",
    composition_type: "MIXED_FLAVOR",
    pack_count: 24,
    recipe_fingerprint: null,
    draft_components: JSON.stringify([
      { product_name: "Strawberry 10ct", qty: 12 },
      { product_name: "Grape 10ct", qty: 12 },
    ]),
    created_at: "2026-07-10T00:00:00.000Z",
    variation_matrix: null,
    ...overrides,
  };
}

function ledgerRow(input: {
  sku: string;
  asin: string;
  draftId: string;
  name: string;
  publishedAt: string | null;
  components: Array<{ product_name: string; qty: number }>;
}): Record<string, unknown> {
  const recipe: RecipeAliasInput = {
    brand: "Uncrustables",
    composition_type: input.components.length === 1 ? "SINGLE_FLAVOR" : "MIXED_FLAVOR",
    unit_count: input.components.reduce((sum, component) => sum + component.qty, 0),
    components: input.components,
  };
  return {
    sku: input.sku,
    asin: input.asin,
    canonical: {
      total_units: recipe.unit_count,
      component_qty_sum: recipe.unit_count,
      composition_signature: recipeCompositionSignature(recipe),
      components: input.components,
    },
    db: {
      draft: {
        id: input.draftId,
        generation_job_id: `job-${input.draftId}`,
        name: input.name,
        brand: recipe.brand,
        composition_type: recipe.composition_type,
        pack_count: recipe.unit_count,
        status: "PUBLISHING",
      },
      master: { id: `master-${input.draftId}` },
      channel_sku: {
        id: `channel-${input.draftId}`,
        published_at: input.publishedAt,
      },
    },
    live: { fetched: true, asin: input.asin },
  };
}

function fixtureLedger(): LegacyRecipeDedupLedgerLike {
  return {
    schema_version: "uncrustables-ledger/v1.2",
    audit_id: "fixture-ledger",
    completed_at: "2026-07-17T23:00:00.000Z",
    complete: true,
    immutable: true,
    external_mutations: false,
    rows: [
      ledgerRow({
        sku: "AA-ASAA-AAAA",
        asin: "B000000001",
        draftId: "draft-newer",
        name: "Alias title",
        publishedAt: "2026-07-11T00:00:00.000Z",
        components: [{ product_name: "Strawberry 10ct", qty: 24 }],
      }),
      ledgerRow({
        sku: "BB-ASBB-BBBB",
        asin: "B000000002",
        draftId: "draft-older",
        name: "Canonical title",
        publishedAt: "2026-07-10T00:00:00.000Z",
        components: [{ product_name: "Strawberry 10ct", qty: 24 }],
      }),
      ledgerRow({
        sku: "CC-ASCC-CCCC",
        asin: "B000000003",
        draftId: "draft-grape",
        name: "Grape title",
        publishedAt: null,
        components: [{ product_name: "Grape 10ct", qty: 24 }],
      }),
    ],
  };
}

test("exact alias fingerprint is order-independent, normalized, and quantity-sensitive", () => {
  const reordered: RecipeAliasInput = {
    ...strawberry,
    brand: "  uncrustables ",
    components: [
      { product_name: "Grape 10ct", qty: 12 },
      { product_name: "Strawberry   10ct", qty: 12 },
    ],
  };
  const changed: RecipeAliasInput = {
    ...strawberry,
    components: [
      { product_name: "Strawberry 10ct", qty: 13 },
      { product_name: "Grape 10ct", qty: 11 },
    ],
  };
  assert.equal(
    legacyRecipeAliasFingerprint(strawberry),
    legacyRecipeAliasFingerprint(reordered),
  );
  assert.notEqual(
    legacyRecipeAliasFingerprint(strawberry),
    legacyRecipeAliasFingerprint(changed),
  );
});

test("alias identity rejects incomplete, over-counted, and duplicate component recipes", () => {
  assert.throws(
    () => legacyRecipeAliasFingerprint({ ...strawberry, components: [] }),
    /non-empty array/,
  );
  assert.throws(
    () =>
      legacyRecipeAliasFingerprint({
        ...strawberry,
        components: [{ product_name: "Strawberry", qty: 12 }],
      }),
    /does not equal unit_count/,
  );
  assert.throws(
    () =>
      legacyRecipeAliasFingerprint({
        ...strawberry,
        components: [
          { product_name: "Strawberry", qty: 12 },
          { product_name: " strawberry ", qty: 12 },
        ],
      }),
    /duplicate component identity/,
  );
});

test("legacy resolver uses selected variation, chooses one canonical, and keeps aliases explicit", () => {
  const exactFingerprint = legacyRecipeAliasFingerprint(strawberry);
  const selectedVariation = candidate({
    id: "draft-selected",
    created_at: "2026-07-11T00:00:00.000Z",
    draft_components: JSON.stringify([{ product_name: "Wrong fallback", qty: 24 }]),
    variation_matrix: {
      selected_variant_idx: 1,
      variants_json: JSON.stringify([
        { idx: 0, composition: [{ product_name: "Wrong", qty: 24 }] },
        { idx: 1, composition: strawberry.components },
      ]),
    },
  });
  const reserved = candidate({
    id: "draft-reserved",
    recipe_fingerprint: exactFingerprint,
    created_at: "2026-07-12T00:00:00.000Z",
  });
  const resolution = resolveLegacyRecipeAlias(strawberry, [selectedVariation, reserved]);
  assert.equal(resolution.status, "MATCH");
  if (resolution.status !== "MATCH") return;
  assert.equal(resolution.canonical.id, "draft-reserved");
  assert.deepEqual(resolution.duplicate_siblings.map((row) => row.id), ["draft-selected"]);
});

test("legacy resolver fails closed on malformed or over-broad coarse candidates", () => {
  const malformed = candidate({ id: "draft-bad", draft_components: "not-json" });
  const blocked = resolveLegacyRecipeAlias(strawberry, [malformed]);
  assert.equal(blocked.status, "BLOCKED");
  if (blocked.status === "BLOCKED") assert.match(blocked.blockers[0], /not valid JSON/);

  const tooMany = Array.from({ length: 3 }, (_, index) =>
    candidate({ id: `draft-${index}`, generation_job_id: `job-${index}` }),
  );
  assert.equal(resolveLegacyRecipeAlias(strawberry, tooMany, 2).status, "BLOCKED");
});

test("read-only plan selects earliest live publication and never authorizes apply", () => {
  const ledger = fixtureLedger();
  const bytes = Buffer.from(`${JSON.stringify(ledger)}\n`);
  const plan = buildLegacyRecipeDedupPlan({
    ledger,
    ledgerBytes: bytes,
    ledgerPath: "/sealed/fixture.json",
    expectedLedgerSha256: legacyRecipeSha256(bytes),
    expectedLiveRows: 3,
    expectedUniqueRecipes: 2,
    expectedDuplicateGroups: 1,
  });
  verifyLegacyRecipeDedupPlan(plan);
  assert.deepEqual(plan.summary, {
    ledger_rows: 3,
    live_rows: 3,
    unique_recipes: 2,
    duplicate_groups: 1,
    duplicate_rows: 2,
    duplicate_siblings: 1,
    canonical_reservations: 2,
    proposed_field_updates: 2,
    apply_authorized: false,
    blockers: 0,
  });
  const duplicate = plan.reservations.find((entry) => entry.duplicate_siblings.length === 1)!;
  assert.equal(duplicate.canonical.draft_id, "draft-older");
  assert.equal(duplicate.duplicate_siblings[0].draft_id, "draft-newer");
  assert.equal(duplicate.recommended_update.expected_current_value, null);
  assert.equal(plan.policy.destructive_actions, false);
  assert.equal(plan.apply_gate.authorized, false);
});

test("plan verifier rejects any tampering", () => {
  const ledger = fixtureLedger();
  const bytes = Buffer.from(JSON.stringify(ledger));
  const plan = buildLegacyRecipeDedupPlan({
    ledger,
    ledgerBytes: bytes,
    ledgerPath: "/sealed/fixture.json",
  });
  const tampered = structuredClone(plan);
  tampered.reservations[0].recommended_update.desired_value = "0".repeat(64);
  assert.throws(() => verifyLegacyRecipeDedupPlan(tampered), /SHA-256 is invalid/);
});

test("CLI requires an exact source SHA and has no apply mode", () => {
  const sha = "a".repeat(64);
  assert.deepEqual(
    parseLegacyRecipeDedupArgs([
      "--ledger=sealed.json",
      `--ledger-sha256=${sha}`,
      "--expect-duplicate-groups=0",
    ]),
    {
      ledger_path: "sealed.json",
      ledger_sha256: sha,
      output_path: null,
      expected_live: undefined,
      expected_unique: undefined,
      expected_duplicate_groups: 0,
    },
  );
  assert.throws(
    () => parseLegacyRecipeDedupArgs(["--ledger=sealed.json"]),
    /ledger-sha256/,
  );
  assert.throws(
    () =>
      parseLegacyRecipeDedupArgs([
        "--ledger=sealed.json",
        `--ledger-sha256=${sha}`,
        "--apply",
      ]),
    /Unknown or forbidden option: --apply/,
  );
});

test("real sealed cohort is exactly 164 live / 144 recipes / 20 duplicate pairs", () => {
  const ledgerPath = path.resolve(
    "data/audits/uncrustables-ledger-20260717T232140568Z-offline.json",
  );
  const bytes = readFileSync(ledgerPath);
  const ledger = JSON.parse(bytes.toString("utf8")) as LegacyRecipeDedupLedgerLike;
  const plan = buildLegacyRecipeDedupPlan({
    ledger,
    ledgerBytes: bytes,
    ledgerPath,
    expectedLedgerSha256: "46a80e727880d83bd9e52a1c58c753eeeede0cb8cbdd3443e825aba9cbaaa02f",
    expectedLiveRows: 164,
    expectedUniqueRecipes: 144,
    expectedDuplicateGroups: 20,
  });
  verifyLegacyRecipeDedupPlan(plan);
  assert.equal(plan.summary.duplicate_rows, 40);
  assert.equal(plan.summary.duplicate_siblings, 20);
  assert.equal(plan.duplicate_pairs.length, 20);
  assert.ok(plan.reservations.every((entry) => entry.duplicate_siblings.length <= 1));
  assert.equal(plan.blockers.length, 0);
});
