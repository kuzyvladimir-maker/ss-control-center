#!/usr/bin/env -S node --import tsx

/**
 * Re-seal the strict 112-row MAIN repair queue against corrected strict audit
 * v6. The repair partition and reference readiness do not change: only the
 * false mixed-carton defect is replaced by the real independent defects on
 * ordinals 1/2/38/97. No generation or external operation occurs.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const checkOnly = process.argv.includes("--check");

const predecessorPath =
  "data/audits/uncrustables-main-repair-readiness-20260718-v4.json";
const predecessorFileSha =
  "57f94af114369cb8e8f51bf653987a0cc579c699f249c7e7483155f3ab1a3661";
const predecessorBodySha =
  "73be915aea5d61ae6b6ef199d9f03f1d2784f677407b1cc5fc6b220f1d0843b9";
const strictAuditPath =
  "data/audits/uncrustables-live-main-strict-reaudit-20260718-v6.json";
const strictAuditFileSha =
  "87d9adf66cc322becccd0eb214e13d073272c3c11405e4bdd15e93c98f08eb4c";
const strictAuditBodySha =
  "befae9606c9dca01175c555f181cfcff53bd248aa5060ee2194e3e611739ff8e";
const correctedSpecPath = "../docs/BUNDLE_FACTORY_FROZEN_MAIN_IMAGE_v2.0.md";
const correctedSpecFileSha =
  "641d38e418f14e0550432c388c363045fc319a6fd61b515de7db56e4b9ad3ff2";
const outputJson =
  "data/audits/uncrustables-main-repair-readiness-20260718-v6.json";
const outputCsv =
  "data/audits/uncrustables-main-repair-readiness-20260718-v6.csv";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function absolute(localPath: string): string {
  return path.resolve(root, localPath);
}

function fileSha(localPath: string): string {
  return sha256(readFileSync(absolute(localPath)));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const predecessorBytes = readFileSync(absolute(predecessorPath));
assert(sha256(predecessorBytes) === predecessorFileSha, "v4 readiness file SHA drifted");
const predecessor = JSON.parse(predecessorBytes.toString("utf8"));
const predecessorSeal = predecessor.seal?.body_sha256;
const predecessorBody = { ...predecessor };
delete predecessorBody.seal;
assert(predecessorSeal === predecessorBodySha, "v4 readiness seal changed");
assert(sha256(JSON.stringify(predecessorBody)) === predecessorBodySha, "v4 readiness nested seal is invalid");

const strictBytes = readFileSync(absolute(strictAuditPath));
assert(sha256(strictBytes) === strictAuditFileSha, "v6 strict audit file SHA drifted");
const strictAudit = JSON.parse(strictBytes.toString("utf8"));
const strictBody = { ...strictAudit };
delete strictBody.body_sha256;
assert(strictAudit.body_sha256 === strictAuditBodySha, "v6 strict audit body SHA changed");
assert(sha256(JSON.stringify(strictBody)) === strictAuditBodySha, "v6 strict audit nested seal is invalid");
assert(fileSha(correctedSpecPath) === correctedSpecFileSha, "corrected frozen spec SHA drifted");

const strictBySku = new Map(
  strictAudit.rows.map((row: { sku: string }) => [row.sku, row]),
);
assert(strictBySku.size === 164, "strict v6 must cover 164 unique SKU rows");
const strictRepairSkus = new Set(
  strictAudit.rows
    .filter((row: { decision: string }) => row.decision === "REPAIR")
    .map((row: { sku: string }) => row.sku),
);
assert(strictRepairSkus.size === 112, "strict v6 repair partition must remain 112");

interface ReadinessComponent {
  quantity: number;
  canonical_flavor_id?: string | null;
  exact_product_name: string;
  selected_pack_mode: string;
  visible_package_count: number;
}

interface ReadinessRow {
  queue_rank: number;
  queue_stage: number;
  ordinal: number;
  sku: string;
  asin: string;
  readiness: string;
  reference_gate: string;
  catalog_identity_gate: string;
  exact_recipe: { effective_total_units: number };
  presentation: { presentation_class: string; pack_mode: string };
  components: ReadinessComponent[];
  blockers: Array<{ code: string }>;
  generation_authorized: boolean;
  amazon_write_authorized: boolean;
  strict_audit: Record<string, unknown>;
  [key: string]: unknown;
}

const rows = (predecessor.rows as ReadinessRow[]).map((row) => {
  const strict = strictBySku.get(row.sku) as {
    decision: string;
    severity: string;
    reason_codes: string[];
    observation: string;
    evidence: Record<string, unknown>;
  } | undefined;
  assert(strict, `strict v6 row missing for ${row.sku}`);
  assert(strict.decision === "REPAIR", `${row.sku} no longer belongs in repair readiness`);
  return {
    ...row,
    strict_audit: {
      ...row.strict_audit,
      decision: strict.decision,
      severity: strict.severity,
      reason_codes: strict.reason_codes,
      observation: strict.observation,
      live_main_asset: strict.evidence,
      source_audit: {
        path: strictAuditPath,
        file_sha256: strictAuditFileSha,
        body_sha256: strictAuditBodySha,
      },
    },
  };
});
assert(rows.length === 112, "readiness queue must remain 112 rows");
assert(
  rows.every((row: { sku: string }) => strictRepairSkus.has(row.sku)),
  "readiness queue and strict REPAIR partition differ",
);

const defectGroups = Object.entries(
  strictAudit.reason_catalog as Record<string, string>,
).map(([code, description]) => {
  const affected = strictAudit.rows.filter(
    (row: { reason_codes: string[] }) => row.reason_codes.includes(code),
  );
  return {
    code,
    description,
    affected_count: affected.length,
    affected_asins: affected.map((row: { asin: string }) => row.asin).sort(),
    affected_skus: affected.map((row: { sku: string }) => row.sku).sort(),
  };
}).filter((group) => group.affected_count > 0);

const sources = predecessor.sources
  .filter((source: { role: string }) =>
    !source.role.startsWith("STRICT_MAIN_ORIGINAL_RESOLUTION_AUDIT") &&
    !source.role.startsWith("FROZEN_MAIN_SPEC") &&
    !source.role.startsWith("PREDECESSOR_READINESS_QUEUE"))
  .concat([
    {
      role: "STRICT_MAIN_ORIGINAL_RESOLUTION_AUDIT_CORRECTED_V6",
      path: strictAuditPath,
      sha256: strictAuditFileSha,
      body_sha256: strictAuditBodySha,
    },
    {
      role: "FROZEN_MAIN_SPEC_V2_CORRECTED_CARTON_RULE",
      path: correctedSpecPath,
      sha256: correctedSpecFileSha,
    },
    {
      role: "PREDECESSOR_READINESS_QUEUE_V4",
      path: predecessorPath,
      sha256: predecessorFileSha,
      body_sha256: predecessorBodySha,
    },
  ]);

const summary = {
  ...predecessor.summary,
  corrected_false_rule_rows: 4,
  loose_ice_repairs: 2,
  retailer_badge_only_repairs: 2,
  visible_text_integrity_repairs: 1,
};
const body = {
  ...predecessorBody,
  schema_version: "uncrustables-main-repair-readiness/v6.0.0",
  artifact_id: "UMRR-20260718-V6-STRICT112-CARTON-RULE-CORRECTION",
  deterministic_build: {
    runtime_timestamp_omitted: true,
    builder_path: path.relative(root, fileURLToPath(import.meta.url)),
  },
  contract: {
    strict_partition: "164 = 52 strict visual KEEP + 112 strict visual REPAIR",
    reference_rule:
      "Only exact presentation-specific reviewed artifacts for the exact flavor may authorize package designs; live-audit authenticity observations do not extend the sealed generation registry.",
    presentation_rule:
      "For each exact flavor, use the fewest cartons whose registry-reviewed pack sizes sum exactly to its quantity, with stable registry order as tie-breaker. Mixed genuine pack sizes such as 10+10+4 are allowed; unreviewed, cross-flavor, ambiguous, or inexact plans fail closed.",
    readiness_rule:
      "REFERENCE_READY is not generation authorization. Every output still needs image-bound QA, owner approval, production permit, and fresh Amazon compare-and-swap.",
  },
  sources,
  summary,
  defect_groups: defectGroups,
  rows,
  correction: {
    predecessor_path: predecessorPath,
    predecessor_file_sha256: predecessorFileSha,
    predecessor_body_sha256: predecessorBodySha,
    corrected_strict_audit_path: strictAuditPath,
    affected_ordinals: [1, 2, 38, 97],
    queue_membership_changed: false,
    readiness_counts_changed: false,
    external_mutations: 0,
  },
};
const artifact = {
  ...body,
  seal: {
    algorithm: "sha256",
    scope:
      "Compact JSON serialization of every top-level field before seal, in emitted key order",
    body_sha256: sha256(JSON.stringify(body)),
  },
};
const jsonText = `${JSON.stringify(artifact, null, 2)}\n`;
const csvHeader = [
  "queue_rank", "queue_stage", "ordinal", "sku", "asin", "readiness",
  "reference_gate", "catalog_identity_gate", "effective_total_units",
  "presentation_class", "pack_mode", "component_plan", "reason_codes",
  "blocker_codes", "generation_authorized", "amazon_write_authorized",
] as const;
const csvText = `${[
  csvHeader.join(","),
  ...rows.map((row) => [
    row.queue_rank,
    row.queue_stage,
    row.ordinal,
    row.sku,
    row.asin,
    row.readiness,
    row.reference_gate,
    row.catalog_identity_gate,
    row.exact_recipe.effective_total_units,
    row.presentation.presentation_class,
    row.presentation.pack_mode,
    row.components.map((component) =>
      `${component.quantity}x ${component.canonical_flavor_id ?? component.exact_product_name} as ${component.selected_pack_mode} (${component.visible_package_count} visible packages)`,
    ).join(" | "),
    row.strict_audit.reason_codes.join("|"),
    [...new Set(row.blockers.map((blocker) => blocker.code))].sort().join("|"),
    row.generation_authorized,
    row.amazon_write_authorized,
  ].map(csvCell).join(",")),
].join("\n")}\n`;

const outputs = [[outputJson, jsonText], [outputCsv, csvText]] as const;
for (const [localPath, text] of outputs) {
  const sidecar = `${sha256(text)}  ${path.basename(localPath)}\n`;
  if (checkOnly) {
    assert(existsSync(absolute(localPath)), `missing output ${localPath}`);
    assert(readFileSync(absolute(localPath), "utf8") === text, `stale output ${localPath}`);
    assert(readFileSync(absolute(`${localPath}.sha256`), "utf8") === sidecar, `stale sidecar ${localPath}.sha256`);
  } else {
    writeFileSync(absolute(localPath), text);
    writeFileSync(absolute(`${localPath}.sha256`), sidecar);
  }
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  check_only: checkOnly,
  external_mutations: 0,
  body_sha256: artifact.seal.body_sha256,
  summary,
  outputs: outputs.map(([localPath]) => localPath),
}, null, 2)}\n`);
