// node --test src/lib/bundle-factory/__tests__/uncrustables-main-production-readiness.test.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";

const ROOT = process.cwd();
const MANIFEST_PATH =
  "data/audits/uncrustables-main-production-readiness-20260718-v1.json";

function bytes(localPath) {
  return readFileSync(join(ROOT, localPath));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readManifest() {
  return JSON.parse(bytes(MANIFEST_PATH).toString("utf8"));
}

test("MAIN production-readiness artifact is sealed and partitions all 34 repairs", () => {
  const manifest = readManifest();
  const { seal, ...body } = manifest;
  assert.equal(manifest.schema_version, "uncrustables-main-production-readiness/v1.0.0");
  assert.equal(manifest.immutable, true);
  assert.equal(sha256(JSON.stringify(body)), seal.body_sha256);
  assert.equal(manifest.safety.image_model_calls, 0);
  assert.equal(manifest.safety.amazon_writes, 0);
  assert.equal(manifest.safety.marketplace_write_authorized, false);
  assert.deepEqual(manifest.summary, {
    repair_rows: 34,
    reuse_exact_good: 0,
    blocked_reuse_qa: 5,
    planned_gpt_image_2_candidates: 28,
    identity_blocked: 1,
    generation_reference_ready: 0,
    generation_blocked_by_reference_gaps: 28,
    prompt_specs_built: 28,
    images_generated: 0,
    amazon_rows_changed: 0,
    official_package_art_files_verified: 14,
    registry_evidence_files_verified: 3,
  });
  assert.equal(new Set(manifest.rows.map((row) => row.sku)).size, 34);
  assert.equal(
    manifest.rows.filter((row) => row.action === "REUSE_EXACT_GOOD").length,
    0,
  );
  assert.equal(
    manifest.rows.filter((row) => row.action === "BLOCKED_REUSE_QA").length,
    5,
  );
  assert.equal(
    manifest.rows.filter((row) => row.action === "GENERATE_GPT_IMAGE_2").length,
    28,
  );
  assert.equal(
    manifest.rows.filter((row) => row.action === "BLOCKED_IDENTITY").length,
    1,
  );

  const sidecar = bytes(`${MANIFEST_PATH}.sha256`).toString("utf8").trim();
  assert.equal(sidecar.split(/\s+/)[0], sha256(bytes(MANIFEST_PATH)));
});

test("all 28 deterministic GPT Image 2 specs are SHA-bound and fail closed", () => {
  const manifest = readManifest();
  const fixtureByClass = new Map(
    manifest.owner_approved_style_fixtures.map((fixture) => [
      fixture.presentation_class,
      fixture,
    ]),
  );
  assert.deepEqual([...fixtureByClass.keys()].sort(), [
    "individual_wraps",
    "retail_boxes_mix",
    "retail_boxes_single",
  ]);
  for (const fixture of fixtureByClass.values()) {
    assert.equal(sha256(bytes(fixture.path)), fixture.sha256);
    assert.equal(fixture.scope, "CLASS_STYLE_ONLY_NOT_PRODUCTION_OUTPUT");
  }

  const generationRows = manifest.rows.filter(
    (row) => row.action === "GENERATE_GPT_IMAGE_2",
  );
  for (const row of generationRows) {
    const spec = row.prompt_spec;
    const { sha256: claimedSpecSha, ...specBody } = spec;
    assert.equal(sha256(JSON.stringify(specBody)), claimedSpecSha, row.sku);
    assert.equal(sha256(spec.prompt), spec.prompt_sha256, row.sku);
    assert.equal(spec.required_model, "gpt-image-2");
    assert.deepEqual(spec.output, {
      width: 2048,
      height: 2048,
      format: "png",
    });
    const inputContract = spec.model_input_contract;
    assert.equal(inputContract.fail_closed, true);
    assert.equal(spec.ordered_reference_contract[0].path, manifest.kit_anchor.path);
    assert.equal(
      spec.ordered_reference_contract[0].sha256,
      manifest.kit_anchor.sha256,
    );
    assert.equal(sha256(bytes(manifest.kit_anchor.path)), manifest.kit_anchor.sha256);
    assert.deepEqual(
      spec.selected_owner_approved_class_fixture,
      fixtureByClass.get(spec.presentation.presentation_class),
    );
    const selectedFixture = spec.selected_owner_approved_class_fixture;
    const fixtureInput = inputContract.style_class_fixture_reference;
    assert.equal(fixtureInput.presentation_class, selectedFixture.presentation_class);
    assert.equal(fixtureInput.proof_id, selectedFixture.proof_id);
    assert.equal(fixtureInput.path, selectedFixture.path);
    assert.equal(fixtureInput.sha256, selectedFixture.sha256);
    assert.equal(fixtureInput.scope, "CLASS_STYLE_ONLY_NOT_PRODUCTION_OUTPUT");
    assert.equal(fixtureInput.authority, "STYLE_CLASS_ONLY_NEVER_PRODUCT_IDENTITY");
    assert.equal(sha256(bytes(fixtureInput.path)), fixtureInput.sha256);
    assert.match(spec.prompt, new RegExp(fixtureInput.path.replaceAll(".", "\\.")));
    assert.match(spec.prompt, new RegExp(fixtureInput.sha256));
    assert.deepEqual(spec.owner_approved_style_fixture_set, [
      fixtureByClass.get("retail_boxes_single"),
      fixtureByClass.get("retail_boxes_mix"),
      fixtureByClass.get("individual_wraps"),
    ]);
    assert.equal(row.generated_output, null);
    assert.equal(row.amazon_write_authorized, false);
    assert.equal(row.generation_allowed, false);
    assert.ok(row.generation_blockers.length > 0, row.sku);
    assert.match(spec.prompt, /^DRAFT ONLY — DO NOT SUBMIT/);

    assert.deepEqual(inputContract.kit_anchor_reference, spec.ordered_reference_contract[0]);
    assert.deepEqual(
      inputContract.product_identity_references,
      spec.ordered_reference_contract.slice(1),
    );
    assert.equal(
      inputContract.product_identity_references.length,
      spec.components.length,
    );
    assert.deepEqual(
      inputContract.ordered_model_inputs.map((input) => input.model_input_index),
      Array.from(
        { length: spec.components.length + 2 },
        (_, index) => index + 1,
      ),
    );
    assert.equal(inputContract.ordered_model_inputs[0].input_class, "KIT_ANCHOR");
    assert.equal(
      inputContract.ordered_model_inputs.at(-1).input_class,
      "STYLE_CLASS_FIXTURE",
    );
    assert.equal(
      inputContract.ordered_model_inputs.at(-1).path,
      selectedFixture.path,
    );

    for (const [index, component] of spec.components.entries()) {
      if (component.official_package_art) {
        assert.equal(
          component.official_package_art.production_authority,
          "AUDIT_METADATA_ONLY_NEVER_A_MODEL_INPUT",
        );
        assert.equal(
          sha256(bytes(component.official_package_art.path)),
          component.official_package_art.sha256,
          `${row.sku} ${component.canonical_flavor_id}`,
        );
      }
      const selectedReference =
        component.production_registry?.selected_reference ?? null;
      const modelReference = inputContract.product_identity_references[index];
      assert.equal(modelReference.recipe_component_index, index + 1);
      assert.equal(modelReference.path, selectedReference?.path ?? null, row.sku);
      assert.equal(modelReference.sha256, selectedReference?.sha256 ?? null, row.sku);
      assert.notEqual(modelReference.path, selectedFixture.path, row.sku);
      assert.notEqual(modelReference.sha256, selectedFixture.sha256, row.sku);
      if (selectedReference) {
        assert.equal(
          modelReference.authority,
          "UNIQUE_PRODUCTION_REGISTRY_PRESENTATION_REFERENCE",
        );
        assert.equal(sha256(bytes(selectedReference.path)), selectedReference.sha256);
      } else {
        assert.equal(modelReference.path, null);
        assert.equal(modelReference.sha256, null);
        assert.equal(
          modelReference.authority,
          "MISSING_NO_OFFICIAL_CARTON_FALLBACK_ALLOWED",
        );
      }
    }
  }
});

test("AJ wrapper input uses the unique registry-selected wrapper and never carton fallback", () => {
  const manifest = readManifest();
  const aj = manifest.rows.find((row) => row.sku === "AJ-ASRB-HKC3");
  const spec = aj.prompt_spec;
  assert.equal(spec.presentation.presentation_class, "individual_wraps");

  const raspberry = spec.components[0];
  const raspberryInput = spec.model_input_contract.product_identity_references[0];
  assert.ok(raspberry.official_package_art);
  assert.equal(raspberry.production_registry, null);
  assert.equal(raspberryInput.path, null);
  assert.equal(raspberryInput.sha256, null);
  assert.notEqual(raspberryInput.path, raspberry.official_package_art.path);

  const berry = spec.components[1];
  const berryInput = spec.model_input_contract.product_identity_references[1];
  assert.equal(berry.production_registry.pack_mode, "individual-wrapper");
  assert.deepEqual(berryInput, spec.ordered_reference_contract[2]);
  assert.equal(
    berryInput.path,
    "data/audits/uncrustables-approved-reference-qa-20260718/B0H85P9F3R-live.jpg",
  );
  assert.equal(
    berryInput.sha256,
    "846005feea2a43108672aa5d4c65f272511d4332c5f7d449ba2ee437633c4e2b",
  );
  assert.equal(
    berry.official_package_art.sha256,
    "9d36138ccb6069872bea6d9605aba73a7054f72b3ce268354bace975c3e51ae2",
  );
  assert.notEqual(berryInput.path, berry.official_package_art.path);
  assert.notEqual(berryInput.sha256, berry.official_package_art.sha256);
  assert.equal(aj.generation_allowed, false);
});

test("TY and all five previously reusable donors remain explicitly blocked", () => {
  const manifest = readManifest();
  const ty = manifest.rows.find((row) => row.sku === "TY-AST2-JE9P");
  assert.equal(ty.action, "BLOCKED_IDENTITY");
  assert.equal(ty.readiness, "BLOCKED_BEFORE_GENERATION");
  assert.equal(ty.identity_block.same_identity, false);
  assert.equal(ty.prompt_spec, null);
  assert.equal(ty.generation_allowed, false);
  assert.match(ty.identity_block.reason, /2 oz Each/);
  assert.match(ty.identity_block.reason, /2\.8 oz each/);

  assert.equal(
    manifest.rows.some((row) => row.action === "REUSE_EXACT_GOOD"),
    false,
  );
  const expectedFailureCodes = new Map([
    ["PJ-ASDX-E8LW", ["GEL_PACK_COUNT_AND_LAYOUT_MISMATCH"]],
    ["RL-AS64-Q8QX", ["ALTERED_OR_CARTON_DERIVED_WRAPPER_ART"]],
    [
      "RM-ASCV-DVA5",
      [
        "MIXED_RETAIL_PACK_SIZE_CONSISTENCY_REVIEW_REQUIRED",
        "RETAILER_MARK_POLICY_VIOLATION",
      ],
    ],
    ["VH-ASHZ-TJEE", ["VISIBLE_COMPONENT_QUANTITY_MISMATCH"]],
    [
      "ZE-AS5W-FKH3",
      [
        "PACKAGE_CONFIGURATION_AUTHENTICITY_REVIEW_REQUIRED",
        "VISIBLE_COMPONENT_QUANTITY_MISMATCH",
      ],
    ],
  ]);
  const blockedRows = manifest.rows.filter(
    (row) => row.action === "BLOCKED_REUSE_QA",
  );
  assert.deepEqual(
    blockedRows.map((row) => row.sku).sort(),
    [...expectedFailureCodes.keys()].sort(),
  );
  for (const row of blockedRows) {
    const observation = row.image_bound_observation;
    assert.equal(sha256(bytes(row.donor.path)), row.donor.sha256, row.sku);
    assert.equal(
      row.donor.recipe_fingerprint_sha256,
      row.recipe.fingerprint_sha256,
    );
    assert.deepEqual(observation.asset_binding, {
      path: row.donor.path,
      sha256: row.donor.sha256,
      width: row.donor.width,
      height: row.donor.height,
      recipe_fingerprint_sha256: row.recipe.fingerprint_sha256,
    });
    assert.equal(observation.decision, "BLOCK");
    assert.equal(observation.complete_exact_good_check_set, false);
    assert.equal(observation.qualifies_for_reuse_exact_good, false);
    assert.deepEqual(
      observation.blocking_findings.map((finding) => finding.code).sort(),
      expectedFailureCodes.get(row.sku).slice().sort(),
    );
    for (const reference of observation.comparison_references) {
      assert.equal(sha256(bytes(reference.path)), reference.sha256);
    }
    assert.equal(row.amazon_write_authorized, false);
    assert.equal(row.generation_allowed, false);
  }

  const pj = blockedRows.find((row) => row.sku === "PJ-ASDX-E8LW");
  assert.match(pj.image_bound_observation.blocking_findings[0].observed, /Five gel packs/);
  const rl = blockedRows.find((row) => row.sku === "RL-AS64-Q8QX");
  assert.match(rl.image_bound_observation.blocking_findings[0].observed, /carton-derived/);
  assert.match(rl.image_bound_observation.blocking_findings[0].observed, /thirty/);
  const vh = blockedRows.find((row) => row.sku === "VH-ASHZ-TJEE");
  assert.match(vh.image_bound_observation.blocking_findings[0].observed, /28 visible units/);
  const ze = blockedRows.find((row) => row.sku === "ZE-AS5W-FKH3");
  assert.match(ze.image_bound_observation.blocking_findings[0].observed, /= 16, not 24/);
  const rm = blockedRows.find((row) => row.sku === "RM-ASCV-DVA5");
  assert.match(
    rm.image_bound_observation.blocking_findings.find(
      (finding) => finding.code === "RETAILER_MARK_POLICY_VIOLATION",
    ).observed,
    /Walmart-exclusive badge/,
  );
  assert.match(
    rm.image_bound_observation.blocking_findings.find(
      (finding) =>
        finding.code === "MIXED_RETAIL_PACK_SIZE_CONSISTENCY_REVIEW_REQUIRED",
    ).observed,
    /10 \+ 10 \+ 4 = 24/,
  );

  const gate = manifest.reuse_exact_good_gate;
  assert.equal(gate.fail_closed, true);
  assert.equal(gate.required_decision, "PASS");
  assert.equal(new Set(gate.required_asset_binding).size, 5);
  assert.equal(new Set(gate.required_image_bound_checks).size, 7);
  assert.match(gate.acceptance_rule, /every required image-bound check is explicitly PASS/);

  const satisfiesGate = (observation, donor) => {
    const binding = observation.asset_binding;
    const checks = new Map(
      (observation.check_results ?? []).map((check) => [check.code, check.status]),
    );
    return Boolean(
      binding &&
        observation.schema_version === gate.required_observation_schema_version &&
        binding.path === donor.path &&
        binding.sha256 === donor.sha256 &&
        binding.width === donor.width &&
        binding.height === donor.height &&
        binding.recipe_fingerprint_sha256 === donor.recipe_fingerprint_sha256 &&
        sha256(bytes(binding.path)) === binding.sha256 &&
        observation.review_method === gate.required_review_method &&
        observation.decision === gate.required_decision &&
        observation.complete_exact_good_check_set === true &&
        (observation.check_results ?? []).length ===
          gate.required_image_bound_checks.length &&
        checks.size === gate.required_image_bound_checks.length &&
        gate.required_image_bound_checks.every((code) => checks.get(code) === "PASS"),
    );
  };
  for (const row of blockedRows) {
    assert.equal(satisfiesGate(row.image_bound_observation, row.donor), false);
  }
  const example = blockedRows[0];
  const hypotheticalCompletePass = {
    schema_version: gate.required_observation_schema_version,
    review_method: gate.required_review_method,
    decision: gate.required_decision,
    complete_exact_good_check_set: true,
    asset_binding: { ...example.image_bound_observation.asset_binding },
    check_results: gate.required_image_bound_checks.map((code) => ({
      code,
      status: "PASS",
    })),
  };
  assert.equal(satisfiesGate(hypotheticalCompletePass, example.donor), true);
  hypotheticalCompletePass.asset_binding.sha256 = "0".repeat(64);
  assert.equal(satisfiesGate(hypotheticalCompletePass, example.donor), false);
});

test("the manifest exposes every current authenticity gap instead of inventing art", () => {
  const manifest = readManifest();
  const missing = new Set(
    manifest.missing_authenticity_mappings.map(
      (entry) => entry.canonical_flavor_id,
    ),
  );
  assert.deepEqual([...missing].sort(), [
    "bright-eyed-berry-protein",
    "burstin-blueberry-protein",
    "peanut-butter",
    "peanut-butter-blackberry",
    "peanut-butter-grape",
    "peanut-butter-honey",
    "peanut-butter-mixed-berry-legacy",
    "peanut-butter-raspberry",
    "peanut-butter-strawberry",
    "reduced-sugar-grape-on-wheat",
    "reduced-sugar-strawberry-on-wheat",
    "up-and-apple-protein",
  ]);

  const officialMissing = manifest.blocker_summary.find(
    (entry) => entry.code === "OFFICIAL_PACKAGE_ART_MISSING",
  );
  assert.equal(officialMissing, undefined);
  const legacyMixedBerry = manifest.missing_authenticity_mappings.find(
    (entry) =>
      entry.canonical_flavor_id === "peanut-butter-mixed-berry-legacy",
  );
  assert.equal(
    legacyMixedBerry.official_package_art.sha256,
    "c3b232fa682c02a98c3640437dd5dd2f6254eb7cb9f583c053aad77098fe3b4f",
  );
  assert.equal(
    sha256(bytes(legacyMixedBerry.official_package_art.path)),
    legacyMixedBerry.official_package_art.sha256,
  );
  const registryFlavorMissing = manifest.blocker_summary.find(
    (entry) => entry.code === "PRODUCTION_REGISTRY_FLAVOR_MAPPING_MISSING",
  );
  assert.equal(registryFlavorMissing.affected_sku_count, 27);
  const presentationMissing = manifest.blocker_summary.find(
    (entry) => entry.code === "PRODUCTION_REGISTRY_PRESENTATION_ART_MISSING",
  );
  assert.deepEqual(presentationMissing.affected_skus, [
    "BH-ASTN-S4XJ",
    "JC-ASM4-XXW7",
    "VT-ASTH-B6LM",
    "WK-AS2R-FJUW",
  ]);
});
