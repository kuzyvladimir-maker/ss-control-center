#!/usr/bin/env -S node --import tsx

/**
 * Upgrade the three owner-approved GPT Image 2 style fixtures to the v2
 * scene-bound approval schema. The immutable v1 source remains untouched.
 * This local deterministic builder performs no network or marketplace action.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  UNCRUSTABLES_MAIN_VISUAL_APPROVAL_SCHEMA,
  sealUncrustablesMainVisualApproval,
  uncrustablesAuthenticityStableJson,
  uncrustablesMainReviewSubjectSha256,
  type UncrustablesAuthenticityRegistry,
  type UncrustablesMainVisualObservation,
} from "../src/lib/bundle-factory/audit/uncrustables-main-authenticity";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const checkOnly = process.argv.includes("--check");

const sourcePath =
  "src/lib/bundle-factory/audit/data/uncrustables-main-owner-approvals-v1.json";
const sourceFileSha =
  "d8cdd824c769ce01f923791bc83c1afebaecf45dff20c6561582332294d036e6";
const registryPath =
  "src/lib/bundle-factory/audit/data/uncrustables-authenticity-registry-v1.json";
const registryFileSha =
  "10cc967a28643c86653e713729952cac12aba083d83dd2a2608be120e6aeae11";
const outputPath =
  "src/lib/bundle-factory/audit/data/uncrustables-main-owner-approvals-v2.json";

function absolute(localPath: string): string {
  return path.resolve(root, localPath);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sourceBytes = readFileSync(absolute(sourcePath));
assert(sha256(sourceBytes) === sourceFileSha, "v1 approval manifest SHA drifted");
const source = JSON.parse(sourceBytes.toString("utf8"));

const registryBytes = readFileSync(absolute(registryPath));
assert(sha256(registryBytes) === registryFileSha, "registry SHA drifted");
const registry = JSON.parse(
  registryBytes.toString("utf8"),
) as UncrustablesAuthenticityRegistry;
assert(source.registry_sha256 === registry.sha256, "v1 manifest registry changed");
assert(source.entries.length === 3, "expected exactly three approved class fixtures");

const approvedScene: UncrustablesMainVisualObservation["scene"] = {
  background_is_pure_white: true,
  square_one_to_one: true,
  cooler_is_white_textured_eps: true,
  cooler_lid_leans_behind: true,
  salutem_cooler_branding_matches_anchor: true,
  gel_packs_total: 4,
  gel_packs_inside: 2,
  gel_packs_outside: 2,
  gel_packs_all_match_anchor: true,
  products_all_seated_inside_behind_front_rim: true,
  product_perspective_contact_and_shadows_believable: true,
  floating_pasted_halo_or_wall_intersection_items: [],
  loose_ice_snow_or_water_items: [],
  forbidden_overlay_or_extra_prop_items: [],
};

const entries = source.entries.map((entry: Record<string, any>) => {
  assert(
    entry.approval_scope === "style-reference-only" &&
      entry.production_eligible === false,
    `${entry.proof_id} is not a style-only fixture`,
  );
  const visualObservation: UncrustablesMainVisualObservation = {
    ...entry.visual_observation,
    scene: structuredClone(approvedScene),
    notes: `${entry.visual_observation.notes} The v2 record explicitly binds the approved pixels to exact kit geometry, 2+2 gel-pack arithmetic, physical seating, pure-white square background, and an affirmative no-loose-ice/no-overlay review.`,
  };
  const subjectSha256 = uncrustablesMainReviewSubjectSha256({
    sku: entry.sku,
    image: entry.image,
    generation_manifest: entry.generation_manifest,
    recipe: entry.recipe,
    registry,
    visual_observation: visualObservation,
  });
  const { sha256: _priorApprovalSha, ...priorApprovalBody } =
    entry.human_approval;
  const approval = sealUncrustablesMainVisualApproval({
    ...priorApprovalBody,
    schema_version: UNCRUSTABLES_MAIN_VISUAL_APPROVAL_SCHEMA,
    approval_id: `${entry.human_approval.approval_id}-scene-v2`,
    approval_locator: entry.human_approval.approval_locator.replace(
      "owner-approvals-v1",
      "owner-approvals-v2",
    ),
    subject_sha256: subjectSha256,
    checklist: {
      ...entry.human_approval.checklist,
      exact_per_variant_package_counts_match_recipe: true,
      frozen_kit_geometry_and_branding_match_anchor: true,
      exactly_two_inside_and_two_outside_gel_packs: true,
      products_physically_seated_without_floating_or_paste: true,
      pure_white_square_amazon_main_background: true,
      no_loose_ice_water_overlays_or_extra_props: true,
    },
    notes: `${entry.human_approval.notes} Re-sealed under scene-complete approval schema v2; style-reference-only status is unchanged.`,
  });
  return {
    ...entry,
    visual_observation: visualObservation,
    human_approval: approval,
  };
});

const body = {
  ...source,
  schema_version: "uncrustables-main-owner-approvals/v2",
  manifest_id: "uncrustables-owner-approved-gpt-image-2-previews-2026-07-18-v2-scene-complete",
  entries,
  supersedes: {
    path: sourcePath,
    file_sha256: sourceFileSha,
    reason:
      "v1 proved exact product identity/count but omitted the frozen-kit geometry, gel-pack layout, physical-seating, loose-ice, and overlay observations required by the frozen MAIN v2.0 contract.",
  },
  safety: {
    production_eligible_entries: 0,
    amazon_writes: 0,
    image_generations: 0,
    network_requests: 0,
  },
};
delete (body as Record<string, unknown>).sha256;
const artifact = {
  ...body,
  sha256: sha256(uncrustablesAuthenticityStableJson(body)),
};
const output = `${JSON.stringify(artifact, null, 2)}\n`;
const sidecarPath = `${outputPath}.sha256`;
const sidecar = `${sha256(output)}  ${path.basename(outputPath)}\n`;

if (checkOnly) {
  assert(existsSync(absolute(outputPath)), `missing ${outputPath}`);
  assert(readFileSync(absolute(outputPath), "utf8") === output, `stale ${outputPath}`);
  assert(
    readFileSync(absolute(sidecarPath), "utf8") === sidecar,
    `stale ${sidecarPath}`,
  );
} else {
  writeFileSync(absolute(outputPath), output);
  writeFileSync(absolute(sidecarPath), sidecar);
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    check_only: checkOnly,
    entries: entries.length,
    production_eligible_entries: 0,
    manifest_sha256: artifact.sha256,
    output_file_sha256: sha256(output),
    external_mutations: 0,
  }, null, 2)}\n`,
);
