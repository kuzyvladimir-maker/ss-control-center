#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const PLAN_PATH = "data/audits/uncrustables-live-gallery-surgical-plan-20260718-v4.json";
const PLAN_SHA256 = "ae345407a4b95232941cdcaa3836fc85ba87ca6d9cf94988f797253d90025469";
const VISUAL_PATH = "data/audits/uncrustables-live-gallery-visual-audit-20260718.json";
const VISUAL_SHA256 = "ae7d818178d663a20ca0058f20ad68a5cb5137e8a8e26c2bf01407e2111dcc94";
const LIVE_MANIFEST_PATH = "data/audits/uncrustables-live-gallery-fetch-20260718/manifest.json";
const LIVE_MANIFEST_SHA256 = "aeea0813c67584d5d082186fca92535487b7a96de1dedd9e0e0bb67930944f02";
const CHECKPOINT_DIR = "data/repairs/checkpoints/8badb989fc9bc5ee9c7c";
const OUTPUT_DIR = "data/audits/uncrustables-final-gallery-gate-20260718-v1";
const OUTPUT_STEM = "UFGG-20260718T150050701Z-v1";
const FIXED_CARD = {
  url: "https://m.media-amazon.com/images/I/81OibsvvU0L.jpg",
  sha256: "0becbfd6f8d54afcb84a183f6829fe78f234360df0a76149845263d5eafbb7eb",
  path: "data/audits/uncrustables-live-gallery-fetch-20260718/assets/sha256-0becbfd6f8d54afcb84a183f6829fe78f234360df0a76149845263d5eafbb7eb.jpg",
};
const SHARED_FALLBACK_SHA256 = new Set([
  "09e96cd0c9e270c588d480e2232a5d69115f0b75748edfc5278873044831ef3e",
  "eca4b46ee9583ea5836574ac88816536a3314ab27ec6b9944ed7ea7f762c8f9f",
  "43e494be94fc441ea3f6467c15bb2f4731304b54abed318d6dadefe49318167f",
  "668d4486eeef1366970855fc3bf2e538aa50aba3a477ea5dea17b062bb27e0e9",
]);
const DISALLOWED_SHA256 = new Set([
  "c853706f6c23c5fa5b686d0c57947130b7ea0e9d726f76f0f0a60869fb9c1ea1",
  "8618f3c2f1b432e5ce3e3ca051d932effee4390716214c2879c11a08fb12d9f4",
  "f63f70d84b9aed42c3ced1ad85d7f1e54c3bb804e54d4aadd702a14b3d3dcbf4",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function bodySha(value) {
  return sha256(JSON.stringify(canonical(value)));
}

async function readPinned(relativePath, expectedSha) {
  const bytes = await readFile(path.join(ROOT, relativePath));
  const actualSha = sha256(bytes);
  if (actualSha !== expectedSha) {
    throw new Error(`${relativePath} SHA mismatch: expected ${expectedSha}, got ${actualSha}`);
  }
  return { json: JSON.parse(bytes.toString("utf8")), bytes: bytes.length, sha256: actualSha };
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join(";") : String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function unique(values) {
  return [...new Set(values)];
}

async function loadVerifiedMediaCheckpoints() {
  const names = (await readdir(path.join(ROOT, CHECKPOINT_DIR)))
    .filter((name) => /_media-VERIFIED-.*\.json$/.test(name))
    .sort();
  const bySku = new Map();
  for (const name of names) {
    const relativePath = `${CHECKPOINT_DIR}/${name}`;
    const bytes = await readFile(path.join(ROOT, relativePath));
    const checkpoint = JSON.parse(bytes.toString("utf8"));
    if (checkpoint.status !== "VERIFIED" || checkpoint.kind !== "MEDIA") continue;
    if (bySku.has(checkpoint.sku)) throw new Error(`Duplicate verified MEDIA checkpoint for ${checkpoint.sku}`);
    bySku.set(checkpoint.sku, {
      checkpoint,
      path: relativePath,
      sha256: sha256(bytes),
      bytes: bytes.length,
    });
  }
  return bySku;
}

function stableReadCount(checkpoint) {
  return checkpoint.detail?.stable_post_write_reads ?? checkpoint.detail?.consecutive_stable_reads ?? 0;
}

function verifyCheckpointAgainstPlan(checkpointRecord, row) {
  const checks = checkpointRecord.checkpoint.detail?.checks;
  if (!Array.isArray(checks)) throw new Error(`${row.sku} verified checkpoint has no checks`);
  const expectedUrls = row.after.secondary_assets.map((asset) => asset.source_url);
  for (let index = 0; index < 8; index += 1) {
    const field = `other_product_image_locator_${index + 1}`;
    const check = checks.find((entry) => entry.field === field);
    if (!check || check.ok !== true) throw new Error(`${row.sku} missing successful ${field} readback`);
    const expected = expectedUrls[index] ?? null;
    if (check.expected !== expected || check.actual !== expected) {
      throw new Error(`${row.sku} ${field} does not match sealed desired gallery`);
    }
  }
  const reads = stableReadCount(checkpointRecord.checkpoint);
  if (reads < 3) throw new Error(`${row.sku} has only ${reads} stable MEDIA reads`);
  return reads;
}

function countRelevantAdditional(assets, row, visualBySha) {
  const represented = new Set();
  let relevant = 0;
  let exactRecipe = 0;
  let sharedContext = 0;
  for (const [index, current] of assets.entries()) {
    if (index === 0 || current.sha256 === FIXED_CARD.sha256) continue;
    const visual = visualBySha.get(current.sha256);
    if (!visual || visual.policy_issues.length > 0 || DISALLOWED_SHA256.has(current.sha256)) continue;
    if (
      visual.classification === "RECIPE_SPECIFIC_NEEDS_MAPPING" &&
      visual.source_primary_recipe_keys.length === 1 &&
      row.recipe_keys.includes(visual.source_primary_recipe_keys[0])
    ) {
      relevant += 1;
      exactRecipe += 1;
      represented.add(visual.source_primary_recipe_keys[0]);
      continue;
    }
    if (visual.classification === "KEEP_SHARED" && SHARED_FALLBACK_SHA256.has(current.sha256)) {
      relevant += 1;
      sharedContext += 1;
    }
  }
  return {
    relevant,
    exact_recipe: exactRecipe,
    shared_context: sharedContext,
    represented_recipe_components: represented.size,
  };
}

async function main() {
  const planSource = await readPinned(PLAN_PATH, PLAN_SHA256);
  const visualSource = await readPinned(VISUAL_PATH, VISUAL_SHA256);
  const liveSource = await readPinned(LIVE_MANIFEST_PATH, LIVE_MANIFEST_SHA256);
  const cardBytes = await readFile(path.join(ROOT, FIXED_CARD.path));
  if (sha256(cardBytes) !== FIXED_CARD.sha256) throw new Error("Fixed card byte SHA mismatch");

  const plan = planSource.json;
  const visual = visualSource.json;
  const liveManifest = liveSource.json;
  if (plan.rows?.length !== 164 || visual.sku_conclusions?.length !== 164 || liveManifest.rows?.length !== 164) {
    throw new Error("All three sealed inputs must contain exactly 164 rows");
  }
  const visualBySha = new Map(visual.assets.map((asset) => [asset.sha256, asset]));
  const verifiedBySku = await loadVerifiedMediaCheckpoints();
  if (verifiedBySku.size !== 2) throw new Error(`Expected exactly 2 verified MEDIA rows, found ${verifiedBySku.size}`);

  const liveObservedAt = liveManifest.source_ledger.marketplace_observed_at;
  const rows = plan.rows.map((row) => {
    const verified = verifiedBySku.get(row.sku) ?? null;
    const desiredState = verified ? row.after : row.before;
    const stateAssets = verified
      ? row.after.secondary_assets.map((asset) => ({
          slot: asset.slot,
          url: asset.source_url,
          sha256: asset.sha256,
        }))
      : row.before.secondary_assets;
    const validation = verified ? row.after.validation : row.before.validation;
    const stableReads = verified ? verifyCheckpointAgainstPlan(verified, row) : 0;
    const cardExact =
      stateAssets[0]?.slot === "GALLERY_1" &&
      stateAssets[0]?.url === FIXED_CARD.url &&
      stateAssets[0]?.sha256 === FIXED_CARD.sha256;
    const cardOccurrences = stateAssets.filter((asset) => asset.sha256 === FIXED_CARD.sha256).length;
    const additionalCount = stateAssets.filter((asset) => asset.sha256 !== FIXED_CARD.sha256).length;
    const relevantCounts = countRelevantAdditional(stateAssets, row, visualBySha);
    const requirementsPass =
      cardExact &&
      cardOccurrences === 1 &&
      additionalCount >= 4 &&
      additionalCount <= 6 &&
      relevantCounts.relevant === additionalCount &&
      validation.pass === true;

    let gateStatus;
    let readbackStatus;
    let blockers;
    let observedAt;
    let primaryEvidence;
    if (verified) {
      if (!requirementsPass) throw new Error(`${row.sku} verified readback fails gallery requirements`);
      gateStatus = "PASS";
      readbackStatus = `VERIFIED_${stableReads}_STABLE_POST_WRITE_READS`;
      blockers = [];
      observedAt = verified.checkpoint.created_at;
      primaryEvidence = {
        path: verified.path,
        file_sha256: verified.sha256,
        checkpoint_body_sha256: verified.checkpoint.sha256,
      };
    } else if (row.action === "KEEP") {
      if (!requirementsPass) throw new Error(`${row.sku} sealed KEEP row fails gallery requirements`);
      gateStatus = "BLOCKED";
      readbackStatus = "POINT_IN_TIME_PASS_LATEST_READBACK_MISSING";
      blockers = ["LATEST_LIVE_GALLERY_READBACK_REQUIRED"];
      observedAt = liveObservedAt;
      primaryEvidence = { path: LIVE_MANIFEST_PATH, file_sha256: LIVE_MANIFEST_SHA256 };
    } else {
      if (validation.pass) throw new Error(`${row.sku} unverified REBUILD row unexpectedly validates`);
      gateStatus = "FAIL";
      readbackStatus = "POINT_IN_TIME_FAIL_REPAIR_NOT_APPLIED";
      blockers = unique([
        "GALLERY_REPAIR_NOT_APPLIED",
        ...row.reason_codes,
        ...validation.errors,
        "LATEST_LIVE_GALLERY_READBACK_REQUIRED",
      ]);
      observedAt = liveObservedAt;
      primaryEvidence = { path: LIVE_MANIFEST_PATH, file_sha256: LIVE_MANIFEST_SHA256 };
    }

    const result = {
      ordinal: row.ordinal,
      sku: row.sku,
      asin: row.asin,
      gate_status: gateStatus,
      readback_status: readbackStatus,
      observed_at: observedAt,
      counts: {
        secondary_total: stateAssets.length,
        fixed_card_occurrences: cardOccurrences,
        additional_total: additionalCount,
        additional_relevant: relevantCounts.relevant,
        exact_recipe_images: relevantCounts.exact_recipe,
        shared_context_images: relevantCounts.shared_context,
        recipe_components_covered: relevantCounts.represented_recipe_components,
        recipe_components_required: row.recipe_keys.length,
      },
      checks: {
        fixed_card_exact_gallery_1: cardExact,
        fixed_card_exact_sha256: FIXED_CARD.sha256,
        additional_count_4_to_6: additionalCount >= 4 && additionalCount <= 6,
        every_additional_image_relevant: relevantCounts.relevant === additionalCount,
        sealed_gallery_validation_pass: validation.pass,
        stable_post_write_reads: stableReads,
      },
      blockers,
      desired_repair: {
        action: row.action,
        sealed_after_validation_pass: row.after.validation.pass,
        sealed_after_secondary_total: row.after.validation.secondary_count,
        sealed_after_additional_total: row.after.validation.product_or_context_count,
      },
      evidence: {
        primary: primaryEvidence,
        plan: { path: PLAN_PATH, file_sha256: PLAN_SHA256 },
        visual_audit: { path: VISUAL_PATH, file_sha256: VISUAL_SHA256 },
        row_evidence_sha256: null,
      },
    };
    result.evidence.row_evidence_sha256 = bodySha({ ...result, evidence: { ...result.evidence, row_evidence_sha256: null } });
    return result;
  });

  const statusCounts = Object.fromEntries(
    ["PASS", "FAIL", "BLOCKED"].map((status) => [status, rows.filter((row) => row.gate_status === status).length]),
  );
  if (statusCounts.PASS !== 2 || statusCounts.FAIL !== 118 || statusCounts.BLOCKED !== 44) {
    throw new Error(`Unexpected gate counts: ${JSON.stringify(statusCounts)}`);
  }

  const body = {
    schema_version: "uncrustables-final-gallery-gate/v1.0",
    gate_id: OUTPUT_STEM,
    immutable: true,
    read_only: true,
    deterministic_as_of: "2026-07-18T15:00:50.701Z",
    scope: {
      marketplace: "AMAZON_US",
      listings: 164,
      main_image_reviewed: false,
      gallery_requirement: "GALLERY_1 is the exact owner-approved price/customer-note card; 4-6 additional unique recipe-relevant or approved neutral-context images",
    },
    fixed_card_manual_visual_verification: {
      path: FIXED_CARD.path,
      file_sha256: FIXED_CARD.sha256,
      dimensions: "2000x2000",
      result: "PASS_OWNER_APPROVED_PRICE_CUSTOMER_NOTE_CARD",
      observed_copy: [
        "Dear customer",
        "We understand that our prices might be a bit higher — that's because we invest in",
        "Insulated foam cooler and gel packs",
        "Optimized delivery",
        "Dedicated customer support",
        "Gift sets for all tastes",
        "It's more than a meal — it's our way of taking care of you",
        "Warmly, the Salutem Solutions Team",
      ],
    },
    sources: {
      sealed_plan: { path: PLAN_PATH, file_sha256: PLAN_SHA256, body_sha256: plan.body_sha256 },
      visual_audit: { path: VISUAL_PATH, file_sha256: VISUAL_SHA256, body_sha256: visual.body_sha256 },
      live_gallery_manifest: {
        path: LIVE_MANIFEST_PATH,
        file_sha256: LIVE_MANIFEST_SHA256,
        body_sha256: liveManifest.body_sha256,
        marketplace_observed_at: liveObservedAt,
      },
      verified_media_checkpoints: [...verifiedBySku.values()].map((entry) => ({
        sku: entry.checkpoint.sku,
        path: entry.path,
        file_sha256: entry.sha256,
        checkpoint_body_sha256: entry.checkpoint.sha256,
        created_at: entry.checkpoint.created_at,
        stable_post_write_reads: stableReadCount(entry.checkpoint),
      })),
    },
    summary: {
      total: rows.length,
      ...statusCounts,
      pass_definition: "Exact fixed card in GALLERY_1 + 4-6 relevant additional images + sealed validation pass + at least 3 stable post-write reads",
      blocked_definition: "Gallery passed the sealed point-in-time live snapshot but has no later current readback",
      fail_definition: "Stored live snapshot fails one or more gallery requirements and the sealed repair has no verified readback",
      desired_gallery_plan_valid_rows: rows.filter((row) => row.desired_repair.sealed_after_validation_pass).length,
      mutations_performed: 0,
    },
    rows,
  };
  const artifact = { ...body, body_sha256: bodySha(body) };

  const csvHeaders = [
    "ordinal", "sku", "asin", "gate_status", "readback_status", "observed_at",
    "secondary_total", "fixed_card_occurrences", "additional_total", "additional_relevant",
    "exact_recipe_images", "shared_context_images", "recipe_components_covered",
    "recipe_components_required", "blockers", "primary_evidence_path", "primary_evidence_sha256",
    "row_evidence_sha256",
  ];
  const csvRows = rows.map((row) => [
    row.ordinal, row.sku, row.asin, row.gate_status, row.readback_status, row.observed_at,
    row.counts.secondary_total, row.counts.fixed_card_occurrences, row.counts.additional_total,
    row.counts.additional_relevant, row.counts.exact_recipe_images, row.counts.shared_context_images,
    row.counts.recipe_components_covered, row.counts.recipe_components_required, row.blockers,
    row.evidence.primary.path, row.evidence.primary.file_sha256, row.evidence.row_evidence_sha256,
  ]);
  const csv = [csvHeaders, ...csvRows].map((line) => line.map(csvCell).join(",")).join("\n") + "\n";

  const md = [
    "# Uncrustables final gallery gate — 164 Amazon listings",
    "",
    `- PASS: ${statusCounts.PASS}`,
    `- FAIL: ${statusCounts.FAIL}`,
    `- BLOCKED: ${statusCounts.BLOCKED}`,
    "- Amazon/API/database/R2 writes: 0",
    `- Fixed card SHA-256: \`${FIXED_CARD.sha256}\``,
    "",
    "PASS requires the exact fixed price/customer-note card in GALLERY_1, 4-6 relevant additional images, a sealed validation pass, and at least three stable post-write reads. BLOCKED rows passed only the older live snapshot and require a current readback. FAIL rows still show an uncorrected live defect in stored evidence.",
    "",
    "| # | SKU | ASIN | Gate | Live/readback | Sec | Add | Relevant | Blockers | Evidence |",
    "|---:|---|---|---|---|---:|---:|---:|---|---|",
    ...rows.map((row) =>
      `| ${row.ordinal} | ${row.sku} | ${row.asin} | ${row.gate_status} | ${row.readback_status} | ${row.counts.secondary_total} | ${row.counts.additional_total} | ${row.counts.additional_relevant} | ${row.blockers.join("; ") || "—"} | ${row.evidence.primary.path} @ ${row.evidence.primary.file_sha256.slice(0, 12)} |`,
    ),
    "",
  ].join("\n");

  await mkdir(path.join(ROOT, OUTPUT_DIR), { recursive: true });
  const outputs = [
    { name: `${OUTPUT_STEM}.json`, bytes: Buffer.from(JSON.stringify(artifact, null, 2) + "\n") },
    { name: `${OUTPUT_STEM}.csv`, bytes: Buffer.from(csv) },
    { name: `${OUTPUT_STEM}.md`, bytes: Buffer.from(md) },
  ];
  for (const output of outputs) {
    const outputPath = path.join(ROOT, OUTPUT_DIR, output.name);
    await writeFile(outputPath, output.bytes);
    await writeFile(`${outputPath}.sha256`, `${sha256(output.bytes)}  ${output.name}\n`);
  }
  console.log(JSON.stringify({ output_dir: OUTPUT_DIR, summary: artifact.summary, body_sha256: artifact.body_sha256 }, null, 2));
}

await main();
