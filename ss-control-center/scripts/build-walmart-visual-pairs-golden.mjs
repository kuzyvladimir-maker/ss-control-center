#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateAuditManifest } from "../src/lib/walmart/catalog-visual-audit.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "data/audits/walmart-visual-pilot-golden-pairs-v3.json");

const SPECS = [
  {
    sku: "FaisalX-1130",
    identity: {
      brand_aliases: ["pepperidge farm"],
      product_marker_groups: [["whole grain", "bread"]],
      variant_marker_groups: [["15 grain"], ["thin sliced"]],
      forbidden_markers: [{ role: "variant", aliases: ["oatmeal"] }],
    },
    package_facts: [{ kind: "net_content", value: 22, unit: "oz", requirement: "required" }],
    defects: ["wrong_variant", "wrong_size"],
  },
  {
    sku: "FaisalX-1160",
    identity: {
      brand_aliases: ["pepperidge farm"],
      product_marker_groups: [["farmhouse", "bread"]],
      variant_marker_groups: [["multigrain"]],
      forbidden_markers: [{ role: "variant", aliases: ["homestyle oat", "oat"] }],
    },
    package_facts: [{ kind: "net_content", value: 24, unit: "oz", requirement: "required" }],
    defects: ["wrong_variant"],
  },
  {
    sku: "FaisalX-1181",
    identity: {
      brand_aliases: ["pepperidge farm"],
      product_marker_groups: [["hot dog buns", "hot dog bun"]],
      variant_marker_groups: [["butter"], ["top sliced"]],
      forbidden_markers: [
        { role: "product", aliases: ["hamburger buns", "hamburger bun"] },
        { role: "variant", aliases: ["sesame"] },
      ],
    },
    package_facts: [{ kind: "inner_item_count", value: 8, unit: "count", requirement: "required" }],
    defects: ["wrong_product_form", "wrong_variant"],
  },
  {
    sku: "FaisalX-1183",
    identity: {
      brand_aliases: ["pepperidge farm"],
      product_marker_groups: [["hot dog buns", "hot dog bun"]],
      variant_marker_groups: [["butter"], ["top sliced"]],
      forbidden_markers: [{ role: "product", aliases: ["chessmen", "cookies", "cookie"] }],
    },
    package_facts: [{ kind: "inner_item_count", value: 8, unit: "count", requirement: "required" }],
    defects: ["wrong_product_identity", "wrong_product_category"],
  },
  {
    sku: "FaisalX-1208",
    identity: {
      brand_aliases: ["sara lee"],
      product_marker_groups: [["bakery buns", "hamburger buns", "buns"]],
      variant_marker_groups: [["artesano"]],
      forbidden_markers: [
        { role: "product", aliases: ["classic bread", "classic white"] },
        { role: "variant", aliases: ["sliced bread"] },
      ],
    },
    package_facts: [
      { kind: "inner_item_count", value: 8, unit: "count", requirement: "required" },
      { kind: "net_content", value: 19, unit: "oz", requirement: "if_visible" },
    ],
    defects: ["wrong_product_form", "wrong_variant", "wrong_size"],
  },
  {
    sku: "FaisalX-1755",
    identity: {
      brand_aliases: ["dr pepper"],
      product_marker_groups: [],
      variant_marker_groups: [],
      forbidden_markers: [
        { role: "product", aliases: ["diet", "zero sugar", "zero"] },
        { role: "variant", aliases: ["diet", "zero sugar", "zero"] },
      ],
    },
    package_facts: [{ kind: "net_content", value: 2, unit: "l", requirement: "required" }],
    defects: ["wrong_variant", "wrong_formulation"],
  },
  {
    sku: "FaisalX-2223",
    identity: {
      brand_aliases: ["gatorade"],
      product_marker_groups: [["sports drink", "advanced rehydration"]],
      variant_marker_groups: [["cool blue"]],
      forbidden_markers: [
        { role: "product", aliases: ["g zero", "zero sugar", "zero"] },
        { role: "variant", aliases: ["glacier cherry"] },
      ],
    },
    package_facts: [{ kind: "net_content", value: 28, unit: "fl_oz", requirement: "required" }],
    defects: ["wrong_variant", "wrong_formulation"],
  },
  {
    sku: "FaisalX-3545",
    identity: {
      brand_aliases: ["hamburger helper"],
      product_marker_groups: [["four cheese"], ["lasagna"]],
      variant_marker_groups: [["value size"]],
      forbidden_markers: [],
    },
    package_facts: [{ kind: "net_content", value: 8.8, unit: "oz", requirement: "if_visible" }],
    defects: ["wrong_size", "wrong_package_tier"],
  },
  {
    sku: "FaisalX-3865",
    identity: {
      brand_aliases: ["jack link's", "jack links"],
      product_marker_groups: [["beef jerky", "jerky"]],
      variant_marker_groups: [["teriyaki"]],
      forbidden_markers: [
        { role: "product", aliases: ["duos"] },
        { role: "variant", aliases: ["original teriyaki", "original and teriyaki"] },
      ],
    },
    package_facts: [{ kind: "net_content", value: 2.85, unit: "oz", requirement: "required" }],
    defects: ["wrong_variant", "wrong_product_configuration"],
  },
  {
    sku: "FaisalX-4007",
    identity: {
      brand_aliases: ["hershey's", "hersheys"],
      product_marker_groups: [["kisses"]],
      variant_marker_groups: [["milk chocolate"], ["with almonds", "almonds"]],
      forbidden_markers: [],
    },
    package_facts: [{ kind: "net_content", value: 4.48, unit: "oz", requirement: "required" }],
    defects: ["wrong_variant", "wrong_size"],
  },
  {
    sku: "FaisalX-4215",
    identity: {
      brand_aliases: ["old el paso"],
      product_marker_groups: [["stand n stuff"]],
      variant_marker_groups: [["family size"]],
      forbidden_markers: [{ role: "variant", aliases: ["zesty ranch"] }],
    },
    package_facts: [{ kind: "inner_item_count", value: 20, unit: "count", requirement: "required" }],
    defects: ["wrong_variant", "wrong_inner_count", "wrong_package_tier"],
  },
  {
    sku: "FaisalX-4779",
    identity: {
      brand_aliases: ["oreo"],
      product_marker_groups: [["sandwich cookies", "cookies"]],
      variant_marker_groups: [["golden"], ["family size"]],
      forbidden_markers: [{ role: "product", aliases: ["double stuf", "double stuff"] }],
    },
    package_facts: [{ kind: "net_content", value: 18.12, unit: "oz", requirement: "if_visible" }],
    defects: ["wrong_variant", "wrong_size"],
  },
];

async function readJson(name) {
  return JSON.parse(await readFile(path.join(ROOT, name), "utf8"));
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function caseFor(spec, source, kind) {
  const isBad = kind === "bad";
  const imageUrl = isBad ? source.req.url : source.fix.newUrl;
  return {
    case_id: `${isBad ? "bad" : "pass"}-pair-${spec.sku.toLowerCase()}`,
    sku: spec.sku,
    expected: {
      title: source.req.listing,
      outer_units: source.req.qty,
      identity: spec.identity,
      package_facts: spec.package_facts,
      truth_source: "manual_verified",
    },
    images: [{
      slot: "main",
      url: imageUrl,
      buyer_facing_verified: false,
      surface: "last_applied_artifact",
    }],
    ground_truth: {
      verdict: isBad ? "BAD" : "PASS",
      defect_types: isBad ? spec.defects : [],
      basis: isBad
        ? `${source.req.reason.trim()} Historical BAD artifact donor: ${source.req.donorTitle}.`
        : `Manually checked corrected artifact built from ${source.fix.newDonorTitle}; local generation and publish records are GEN_OK/applied.`,
    },
  };
}

async function main() {
  const [reqc, badGen, badPublish, fixGen, fixPublish] = await Promise.all([
    readJson("_reqc_state.json"),
    readJson("_gen_enriched_state.json"),
    readJson("_publish_gen_state.json"),
    readJson("_fix_gen_state.json"),
    readJson("_publish_fix_state.json"),
  ]);

  const sources = new Map();
  for (const spec of SPECS) {
    const req = reqc[spec.sku];
    const bad = badGen[spec.sku];
    const badPub = badPublish[spec.sku];
    const fix = fixGen[spec.sku];
    const fixPub = fixPublish[spec.sku];
    invariant(req?.verdict === "BAD", `${spec.sku}: REQC is not BAD`);
    invariant(bad?.status === "GEN_OK" && fix?.status === "GEN_OK", `${spec.sku}: generation not GEN_OK`);
    invariant(badPub?.status === "applied" && badPub?.ok === true, `${spec.sku}: BAD publish not applied`);
    invariant(fixPub?.status === "applied" && fixPub?.ok === true, `${spec.sku}: PASS publish not applied`);
    invariant(req.listing === fix.listing, `${spec.sku}: listing title mismatch`);
    invariant(req.qty === bad.qty && req.qty === fix.qty, `${spec.sku}: quantity mismatch`);
    invariant(req.url === bad.newUrl, `${spec.sku}: BAD URL mismatch`);
    sources.set(spec.sku, { req, bad, badPub, fix, fixPub });
  }

  const badCases = SPECS.map((spec) => caseFor(spec, sources.get(spec.sku), "bad"));
  const passCases = SPECS.map((spec) => caseFor(spec, sources.get(spec.sku), "pass"));
  const manifest = validateAuditManifest({
    schema_version: "walmart-visual-audit/v3",
    manifest_id: "walmart-main-artifact-pairs-12x2-20260718-v3",
    purpose: "golden-pilot",
    cases: [...badCases, ...passCases],
    layouts: [
      { name: "batch-4", batch_size: 4, shuffle_seed: null },
      { name: "batch-4-shuffled", batch_size: 4, shuffle_seed: 20260718 },
      { name: "singleton", batch_size: 1, shuffle_seed: null },
    ],
  });

  const temp = `${OUTPUT}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(temp, OUTPUT);
  console.log(`wrote ${path.relative(ROOT, OUTPUT)} (${SPECS.length} BAD/PASS pairs, ${manifest.cases.length} images)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
