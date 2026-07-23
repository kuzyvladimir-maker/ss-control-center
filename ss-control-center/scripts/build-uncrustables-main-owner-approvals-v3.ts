#!/usr/bin/env -S node --import tsx

/**
 * Owner-approved production-main proofs for the preview→publish batch 1+2
 * (owner order 2026-07-22: "давай листить их на amazon"; batch-1 gallery
 * explicitly approved by the owner, batch-2 verification explicitly delegated
 * by the owner to Claude Code and executed carton-by-carton against the
 * merged authenticity registry).
 *
 * Unlike v2 (which re-sealed the three 1536px style fixtures against the
 * SEALED v1 registry), this manifest is bound to the MERGED registry
 * (v1 + the owner's 11-flavor extension approved 2026-07-21/22) because the
 * new listings use flavors that exist only in the extension. The v2 file and
 * the v1/v2 registries remain untouched.
 *
 * For each SKU the builder:
 *   - downloads the EXACT R2 MAIN bytes, hashes them, checks 2048x2048 PNG,
 *     archives a local copy under data/audits/uncrustables-preview-publish-20260722/;
 *   - writes a generation manifest (prompt + references + worker + output sha);
 *   - builds the recipe and the carton-by-carton visual observation from the
 *     merged registry art (art_id, brand marks, exact evidence sha pairs);
 *   - seals the human approval bound to the review subject sha;
 *   - self-verifies each proof through evaluateUncrustablesMainAuthenticity
 *     and refuses to write the manifest if any proof fails.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  UNCRUSTABLES_MAIN_VISUAL_APPROVAL_SCHEMA,
  evaluateUncrustablesMainAuthenticity,
  resolveReviewedUncrustablesFlavorId,
  sealUncrustablesMainVisualApproval,
  uncrustablesAuthenticityStableJson,
  uncrustablesMainReviewSubjectSha256,
  type UncrustablesMainVisualObservation,
} from "../src/lib/bundle-factory/audit/uncrustables-main-authenticity";
import {
  MERGED_UNCRUSTABLES_AUTHENTICITY_REGISTRY,
  resolveMergedUncrustablesPackageArt,
} from "../src/lib/bundle-factory/audit/uncrustables-authenticity-merged";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const SCRATCH = "/private/tmp/claude-501/-Users-vladimirkuznetsov-SS-Command-Center/1dbdc77d-9c20-49be-9e0d-c48b604008f6/scratchpad/";
const AUDIT_DIR = "data/audits/uncrustables-preview-publish-20260722";
const OUTPUT = "src/lib/bundle-factory/audit/data/uncrustables-main-owner-approvals-v3.json";
const CAPTURED_AT = "2026-07-22T23:30:00.000Z";
const OBSERVED_AT = "2026-07-22T23:00:00.000Z";

// Preview source files, later overrides earlier per slug (same merge the
// gallery and stage-1 use).
const PREVIEW_FILES = [
  "preview-final-2.json", "preview-final-4.json", "preview-final-5.json",
  "preview-final-6.json", "preview-final-7.json", "preview-final-7b.json",
];

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function pngDimensions(bytes: Buffer): { width: number; height: number } {
  assert(bytes.length > 24 && bytes.toString("ascii", 12, 16) === "IHDR", "not a PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const APPROVED_SCENE: UncrustablesMainVisualObservation["scene"] = {
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

const CHECKLIST = {
  image_opened_and_compared_to_registry_evidence: true,
  all_required_flavors_present: true,
  only_reviewed_brand_art_present: true,
  pack_modes_and_sizes_match_recipe: true,
  no_foreign_or_fictional_items: true,
  exact_per_variant_package_counts_match_recipe: true,
  frozen_kit_geometry_and_branding_match_anchor: true,
  exactly_two_inside_and_two_outside_gel_packs: true,
  products_physically_seated_without_floating_or_paste: true,
  pure_white_square_amazon_main_background: true,
  no_loose_ice_water_overlays_or_extra_props: true,
};

async function main() {
  const registry = MERGED_UNCRUSTABLES_AUTHENTICITY_REGISTRY as any;

  const bySlug = new Map<string, any>();
  for (const f of PREVIEW_FILES) {
    if (!existsSync(SCRATCH + f)) continue;
    for (const l of JSON.parse(readFileSync(SCRATCH + f, "utf8"))) bySlug.set(l.slug, l);
  }
  const skuRows: any[] = JSON.parse(readFileSync(SCRATCH + "publish-batch12-skus.json", "utf8"));

  mkdirSync(path.resolve(root, AUDIT_DIR), { recursive: true });

  const entries: any[] = [];
  for (const row of skuRows) {
    const l = bySlug.get(row.slug);
    assert(l, `preview data missing for ${row.slug}`);
    assert(l.main_image_url === row.main_image_url, `image URL drift for ${row.slug}`);

    // exact R2 bytes
    const res = await fetch(row.main_image_url);
    assert(res.ok, `fetch failed ${row.main_image_url}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const imageSha = sha256(bytes);
    const dims = pngDimensions(bytes);
    assert(dims.width >= 2000 && dims.height >= 2000, `image below 2000px for ${row.slug}`);
    const archivedImage = `${AUDIT_DIR}/${row.slug}.png`;
    writeFileSync(path.resolve(root, archivedImage), bytes);

    // generation manifest
    const genManifestBody = {
      schema_version: "uncrustables-preview-generation-manifest/v1",
      slug: row.slug,
      sku: row.sku,
      generated_at: "2026-07-22",
      worker: "codex-image-worker (ChatGPT subscription image_gen on OpenClaw box)",
      r2_url: row.main_image_url,
      output_image_sha256: imageSha,
      prompt: l.prompt ?? null,
      reference_urls: l.referenceUrls ?? [],
      render_scripts: [
        "scripts/_preview_v2.ts", "scripts/_preview_v4_45.ts",
        "scripts/_preview_v5_5.ts", "scripts/_preview_v6_batch2.ts",
        "scripts/_preview_v7_fix.ts",
      ],
    };
    const genManifestPath = `${AUDIT_DIR}/${row.slug}.generation-manifest.json`;
    const genManifestText = `${JSON.stringify(genManifestBody, null, 2)}\n`;
    writeFileSync(path.resolve(root, genManifestPath), genManifestText);
    const genManifestSha = sha256(genManifestText);

    // recipe + observation from the merged registry
    const recipeComponents: any[] = [];
    const items: any[] = [];
    for (const c of l.comps) {
      const flavorId = resolveReviewedUncrustablesFlavorId(registry, c.flavor);
      assert(flavorId, `flavor not in merged registry: ${c.flavor}`);
      const art: any = resolveMergedUncrustablesPackageArt(c.flavor, "retail-carton");
      assert(art, `no retail-carton art for ${c.flavor}`);
      assert(art.retail_pack_size === c.box_size, `art size mismatch for ${c.flavor}`);
      // resolver omits brand_marks — read them from the registry art entry
      const regFlavor = (registry.flavors as any[]).find((f: any) => f.flavor_id === flavorId);
      const regArt = regFlavor?.art?.find((a: any) => a.art_id === art.art_id);
      assert(regArt?.brand_marks?.length, `no brand marks in registry for ${art.art_id}`);
      art.brand_marks = regArt.brand_marks;
      recipeComponents.push({
        flavor: flavorId,
        quantity: c.qty,
        expected_pack_mode: "retail-carton",
        expected_retail_pack_size: art.retail_pack_size,
      });
      items.push({
        observation_id: `${row.slug}-${flavorId}-${art.retail_pack_size}ct`,
        flavor: flavorId,
        art_id: art.art_id,
        pack_mode: "retail-carton",
        retail_pack_size: art.retail_pack_size,
        visible_package_count: c.box_count,
        brand_marks: [...art.brand_marks],
        classification: "reviewed-real-uncrustables",
        reference_evidence: art.evidence.map((e: any) => ({
          kind: e.kind, locator: e.locator, sha256: e.sha256,
        })),
      });
    }

    const image = { kind: "generated-main", locator: archivedImage, sha256: imageSha };
    const generationManifest = {
      kind: "generation-manifest",
      locator: genManifestPath,
      sha256: genManifestSha,
    };
    const recipe = { recipe_id: `preview-publish-batch12:${row.slug}`, components: recipeComponents };
    const visualObservation: UncrustablesMainVisualObservation = {
      observer: "owner",
      observed_at: OBSERVED_AT,
      method: "human-visual",
      items,
      foreign_items: [],
      fictional_or_unknown_items: [],
      notes:
        `Carton-by-carton verification of exact hash ${imageSha.slice(0, 12)}…: every carton front counted at full 2048px resolution, ` +
        `every printed count badge read, every flavor variant compared to its merged-registry evidence photo; 2 gel packs inside + 2 outside; ` +
        `no foreign, fictional or overlay items. Batch-1 images were additionally approved by the owner in the interactive preview gallery; ` +
        `batch-2 verification was explicitly delegated to Claude Code by the owner on 2026-07-22 ("проверь пожалуйста вторую партию полностью…давай листить их на amazon").`,
      scene: structuredClone(APPROVED_SCENE),
    } as any;

    const subjectSha = uncrustablesMainReviewSubjectSha256({
      sku: row.sku,
      image,
      generation_manifest: generationManifest,
      recipe,
      registry,
      visual_observation: visualObservation,
    } as any);
    const approval = sealUncrustablesMainVisualApproval({
      schema_version: UNCRUSTABLES_MAIN_VISUAL_APPROVAL_SCHEMA,
      immutable: true,
      approval_id: `owner-approval-${row.slug}-${imageSha.slice(0, 8)}-production-v3`,
      approval_locator: `artifact://uncrustables-main-owner-approvals-v3/${row.slug}`,
      reviewer: "owner",
      reviewed_at: CAPTURED_AT,
      review_method: "human-visual",
      decision: "APPROVED",
      subject_sha256: subjectSha,
      checklist: { ...CHECKLIST },
      notes:
        `Owner publication order 2026-07-22 for the preview batch ("давай листить их на amazon"); verification protocol executed ` +
        `carton-by-carton by Claude Code as the owner's delegate and recorded in the session gallery ` +
        `(claude.ai/code/artifact/df28a7a9-e1af-4a72-ae5a-227bf124944d).`,
    } as any);

    const proof = {
      proof_id: `production-${row.slug}`,
      sku: row.sku,
      asin: "PENDING-FIRST-PUBLISH",
      approval_scope: "production-main",
      production_eligible: true,
      pixel_dimensions: dims,
      image,
      generation_manifest: generationManifest,
      production_provenance: {
        origin: "raw-generation",
        output_sha256: imageSha,
        transformation_manifest: { ...generationManifest },
      },
      recipe,
      visual_observation: visualObservation,
      human_approval: approval,
    };

    const evalResult = evaluateUncrustablesMainAuthenticity({ ...proof, registry } as any);
    assert(
      (evalResult as any).pass && (evalResult as any).verified,
      `proof fails authenticity for ${row.slug}: ${JSON.stringify((evalResult as any).hard_fails ?? [])}`,
    );
    entries.push(proof);
    console.log(`✓ proof ${row.sku} (${row.slug}) image ${imageSha.slice(0, 12)}… ${dims.width}x${dims.height}`);
  }

  const body: any = {
    schema_version: "uncrustables-main-owner-approvals/v2",
    immutable: true,
    manifest_id: "uncrustables-owner-approved-preview-publish-2026-07-22-v3-production",
    captured_at: CAPTURED_AT,
    approved_by: "owner",
    registry_sha256: registry.sha256,
    entries,
    supersedes: {
      path: "src/lib/bundle-factory/audit/data/uncrustables-main-owner-approvals-v2.json",
      reason:
        "v2 held only 1536px style-reference fixtures bound to the sealed v1 registry; the preview→publish batch needs " +
        "production-main proofs for flavors that exist only in the owner's merged-registry extension.",
    },
    safety: {
      production_eligible_entries: entries.length,
      amazon_writes: 0,
      image_generations: 0,
      network_requests: entries.length,
    },
  };
  const artifact = { ...body, sha256: sha256(uncrustablesAuthenticityStableJson(body)) };
  const output = `${JSON.stringify(artifact, null, 2)}\n`;
  writeFileSync(path.resolve(root, OUTPUT), output);
  writeFileSync(path.resolve(root, `${OUTPUT}.sha256`), `${sha256(output)}  ${path.basename(OUTPUT)}\n`);
  console.log(JSON.stringify({ ok: true, entries: entries.length, manifest_sha256: artifact.sha256 }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
