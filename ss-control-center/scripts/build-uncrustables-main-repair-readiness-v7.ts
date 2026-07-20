#!/usr/bin/env -S node --import tsx

/**
 * Re-seal MAIN repair readiness against strict audit v7.
 *
 * Eight false retailer-badge-only repairs leave the queue. Ordinal 30 stays in
 * the queue with the corrected loose-ice defect. No image generation or
 * external operation occurs.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const checkOnly = process.argv.includes("--check");

const predecessorPath =
  "data/audits/uncrustables-main-repair-readiness-20260718-v6.json";
const predecessorFileSha =
  "1d308f001bcb88656a849b2e5b81073e1f30d96331139c8c8902a9783be0a429";
const predecessorBodySha =
  "e64df30b219a79c9c4d66e41ca4dc238266d8411b45f6fa14900fd7b24509d7f";
const strictAuditPath =
  "data/audits/uncrustables-live-main-strict-reaudit-20260718-v7.json";
const strictAuditFileSha =
  "4113b64013fef51c345b904bbebd46ed78c646396d8ff6937c6c7ffa9393c637";
const strictAuditBodySha =
  "f5edfd2b655e83cca1c10549db1b064fd34187a6e865e431ba4ff8be05b44290";
const outputJson =
  "data/audits/uncrustables-main-repair-readiness-20260718-v7.json";
const outputCsv =
  "data/audits/uncrustables-main-repair-readiness-20260718-v7.csv";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function absolute(localPath: string): string {
  return path.resolve(root, localPath);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

interface Blocker {
  code: string;
  [key: string]: unknown;
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
  components: Array<{
    quantity: number;
    canonical_flavor_id?: string | null;
    exact_product_name: string;
    selected_pack_mode: string;
    visible_package_count: number;
  }>;
  blockers: Blocker[];
  generation_authorized: boolean;
  amazon_write_authorized: boolean;
  strict_audit: Record<string, unknown>;
  [key: string]: unknown;
}

const predecessorBytes = readFileSync(absolute(predecessorPath));
assert(sha256(predecessorBytes) === predecessorFileSha, "v6 readiness file SHA drifted");
const predecessor = JSON.parse(predecessorBytes.toString("utf8"));
const predecessorSeal = predecessor.seal?.body_sha256;
const predecessorBody = { ...predecessor };
delete predecessorBody.seal;
assert(predecessorSeal === predecessorBodySha, "v6 readiness body SHA changed");
assert(
  sha256(JSON.stringify(predecessorBody)) === predecessorBodySha,
  "v6 readiness nested seal is invalid",
);
assert(predecessor.rows.length === 112, "v6 readiness must contain 112 rows");

const strictBytes = readFileSync(absolute(strictAuditPath));
assert(sha256(strictBytes) === strictAuditFileSha, "v7 strict audit file SHA drifted");
const strictAudit = JSON.parse(strictBytes.toString("utf8"));
const strictBody = { ...strictAudit };
delete strictBody.body_sha256;
assert(strictAudit.body_sha256 === strictAuditBodySha, "v7 strict body SHA changed");
assert(
  sha256(JSON.stringify(strictBody)) === strictAuditBodySha,
  "v7 strict nested seal is invalid",
);

const strictBySku = new Map<string, Record<string, unknown>>(
  strictAudit.rows.map((row: { sku: string }) => [row.sku, row]),
);
const strictRepairSkus = new Set<string>(
  strictAudit.rows
    .filter((row: { decision: string }) => row.decision === "REPAIR")
    .map((row: { sku: string }) => row.sku),
);
assert(strictRepairSkus.size === 104, "v7 strict repair partition must be 104");

const removedOrdinals = [1, 22, 31, 33, 74, 75, 97, 129];
const rows = (predecessor.rows as ReadinessRow[])
  .filter((row) => strictRepairSkus.has(row.sku))
  .map((row, index): ReadinessRow => {
    const strict = strictBySku.get(row.sku) as {
      decision: string;
      severity: string;
      reason_codes: string[];
      observation: string;
      evidence: Record<string, unknown>;
    } | undefined;
    assert(strict?.decision === "REPAIR", `${row.sku} must remain strict REPAIR`);
    return {
      ...row,
      queue_rank: index + 1,
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
assert(rows.length === 104, "v7 readiness queue must contain 104 rows");
assert(
  removedOrdinals.every((ordinal) => !rows.some((row) => row.ordinal === ordinal)),
  "promoted KEEP row remains in readiness queue",
);
assert(
  JSON.stringify(
    (rows.find((row) => row.ordinal === 30)?.strict_audit.reason_codes),
  ) === JSON.stringify(["LOOSE_ICE_VISIBLE"]),
  "ordinal 30 strict defect was not corrected",
);

const rowSkuSet = new Set(rows.map((row) => row.sku));
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

const blockerCodes = new Set(
  rows.flatMap((row) => row.blockers.map((blocker) => blocker.code)),
);
const blockerSummary = [...blockerCodes].sort().map((code) => {
  const affected = rows.filter((row) =>
    row.blockers.some((blocker) => blocker.code === code),
  );
  return {
    code,
    affected_asins: affected.map((row) => row.asin).sort(),
    affected_skus: affected.map((row) => row.sku).sort(),
    affected_count: affected.length,
  };
});

const referenceGapGroups = predecessor.reference_gap_groups
  .map((group: Record<string, unknown>) => {
    const priorSkus = (group.affected_skus as string[]) ?? [];
    const keptSkus = priorSkus.filter((sku) => rowSkuSet.has(sku)).sort();
    const asinBySku = new Map(rows.map((row) => [row.sku, row.asin]));
    return {
      ...group,
      affected_asins: keptSkus.map((sku) => asinBySku.get(sku)!).sort(),
      affected_skus: keptSkus,
      affected_count: keptSkus.length,
    };
  })
  .filter((group: { affected_count: number }) => group.affected_count > 0);

const readinessCounts = Object.fromEntries(
  [...new Set(rows.map((row) => row.readiness))]
    .sort()
    .map((readiness) => [readiness, rows.filter((row) => row.readiness === readiness).length]),
);
assert(
  readinessCounts.REFERENCE_READY_PENDING_EXPLICIT_CONTROLLED_GENERATION === 6,
  "reference-ready count must be 6",
);
assert(
  readinessCounts.BLOCKED_AUTHENTICITY_PROVENANCE === 96,
  "authenticity-blocked count must be 96",
);
assert(readinessCounts.BLOCKED_CATALOG_IDENTITY === 2, "catalog-blocked count must be 2");

const sources = predecessor.sources
  .filter((source: { role: string }) =>
    !source.role.startsWith("STRICT_MAIN_ORIGINAL_RESOLUTION_AUDIT") &&
    !source.role.startsWith("PREDECESSOR_READINESS_QUEUE"))
  .concat([
    {
      role: "STRICT_MAIN_ORIGINAL_RESOLUTION_AUDIT_CORRECTED_V7",
      path: strictAuditPath,
      sha256: strictAuditFileSha,
      body_sha256: strictAuditBodySha,
    },
    {
      role: "PREDECESSOR_READINESS_QUEUE_V6",
      path: predecessorPath,
      sha256: predecessorFileSha,
      body_sha256: predecessorBodySha,
    },
  ]);

const summary = {
  ...predecessor.summary,
  strict_keep_rows_not_queued: 60,
  strict_repair_rows_queued: 104,
  reference_ready_pending_explicit_generation: 6,
  blocked_authenticity_provenance: 96,
  blocked_catalog_identity: 2,
  corrected_false_rule_rows: 13,
  authentic_retailer_mark_keep_promotions: 8,
  loose_ice_repairs: 3,
  retailer_badge_only_repairs: 0,
  visible_text_integrity_repairs: 1,
};
const body = {
  ...predecessorBody,
  schema_version: "uncrustables-main-repair-readiness/v7.0.0",
  artifact_id: "UMRR-20260718-V7-STRICT104-AUTHENTIC-RETAILER-MARK-CORRECTION",
  deterministic_build: {
    runtime_timestamp_omitted: true,
    builder_path: path.relative(root, fileURLToPath(import.meta.url)),
  },
  contract: {
    ...predecessor.contract,
    strict_partition: "164 = 60 strict visual KEEP + 104 strict visual REPAIR",
    retailer_mark_rule:
      "An exact manufacturer-printed retailer-exclusive mark on authentic product packaging is product art, not an overlay. Model-added, mismatched, or altered marks remain forbidden under package-authenticity rules.",
  },
  sources,
  summary,
  blocker_summary: blockerSummary,
  reference_gap_groups: referenceGapGroups,
  defect_groups: defectGroups,
  rows,
  correction: {
    predecessor_path: predecessorPath,
    predecessor_file_sha256: predecessorFileSha,
    predecessor_body_sha256: predecessorBodySha,
    corrected_strict_audit_path: strictAuditPath,
    removed_promoted_keep_ordinals: removedOrdinals,
    residual_loose_ice_ordinal: 30,
    queue_membership_changed: true,
    readiness_counts_changed: true,
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
    (row.strict_audit.reason_codes as string[]).join("|"),
    [...new Set(row.blockers.map((blocker) => blocker.code))].sort().join("|"),
    row.generation_authorized,
    row.amazon_write_authorized,
  ].map(csvCell).join(",")),
].join("\n")}\n`;

for (const [localPath, text] of [[outputJson, jsonText], [outputCsv, csvText]] as const) {
  const sidecar = `${sha256(text)}  ${path.basename(localPath)}\n`;
  if (checkOnly) {
    assert(existsSync(absolute(localPath)), `missing output ${localPath}`);
    assert(readFileSync(absolute(localPath), "utf8") === text, `stale output ${localPath}`);
    assert(
      readFileSync(absolute(`${localPath}.sha256`), "utf8") === sidecar,
      `stale sidecar ${localPath}.sha256`,
    );
  } else {
    writeFileSync(absolute(localPath), text);
    writeFileSync(absolute(`${localPath}.sha256`), sidecar);
  }
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  check_only: checkOnly,
  external_reads: 0,
  external_mutations: 0,
  predecessor_file_sha256: predecessorFileSha,
  strict_audit_file_sha256: strictAuditFileSha,
  body_sha256: artifact.seal.body_sha256,
  summary,
}, null, 2)}\n`);
