/**
 * Seal an offline Amazon-catalog-title-aligned desired manifest.
 *
 * This CLI never calls Amazon, Prisma, R2, or ChannelMAX. It requires exact
 * expected SHAs and an explicit --seal flag so a still-growing diagnostic
 * checkpoint directory cannot be consumed accidentally.
 */

import {
  prepareCatalogTitleAlignment,
  writeCatalogTitleAlignmentArtifact,
} from "@/lib/bundle-factory/repair/uncrustables-catalog-title-alignment";

interface CliOptions {
  seal: boolean;
  planPath: string | null;
  planInternalSha256: string | null;
  planFileSha256: string | null;
  manifestPath: string | null;
  manifestFileSha256: string | null;
  checkpointDirectory: string | null;
  catalogEvidencePath: string | null;
  catalogEvidenceFileSha256: string | null;
  catalogEvidenceBodySha256: string | null;
  outputDirectory: string;
  reviewedAt: string | null;
  requiredRows: number;
}

function usage(): string {
  return [
    "Usage: npx tsx scripts/align-uncrustables-amazon-catalog-titles.ts --seal [options]",
    "",
    "Required exact local inputs:",
    "  --plan=PATH                       Exact sealed source URP JSON.",
    "  --plan-internal-sha256=SHA         Exact URP internal stable SHA-256.",
    "  --plan-file-sha256=SHA             Exact URP file-bytes SHA-256.",
    "  --manifest=PATH                   Exact 164-row desired manifest.",
    "  --manifest-file-sha256=SHA         Exact desired-manifest file SHA-256.",
    "  --checkpoints=DIR                 Complete diagnostic checkpoint directory.",
    "  --catalog-evidence=PATH           Exact reviewed Catalog Items API evidence JSON.",
    "  --catalog-evidence-file-sha256=SHA Exact evidence file-bytes SHA-256.",
    "  --catalog-evidence-body-sha256=SHA Exact evidence canonical-body SHA-256.",
    "  --reviewed-at=ISO                 Canonical ISO timestamp for the new review.",
    "  --seal                            Explicitly allow immutable local artifact writes.",
    "",
    "Optional:",
    "  --output-dir=DIR                  Output directory (default data/repairs).",
    "  --required-rows=N                 Exact scope (default 164; tests only use smaller).",
    "  --help                            Show this help.",
    "",
    "No network client is imported by this workflow.",
  ].join("\n");
}

function positiveInt(label: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    seal: false,
    planPath: null,
    planInternalSha256: null,
    planFileSha256: null,
    manifestPath: null,
    manifestFileSha256: null,
    checkpointDirectory: null,
    catalogEvidencePath: null,
    catalogEvidenceFileSha256: null,
    catalogEvidenceBodySha256: null,
    outputDirectory: "data/repairs",
    reviewedAt: null,
    requiredRows: 164,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--seal") {
      options.seal = true;
    } else if (arg.startsWith("--plan=")) {
      options.planPath = arg.slice("--plan=".length).trim();
    } else if (arg.startsWith("--plan-internal-sha256=")) {
      options.planInternalSha256 = arg.slice("--plan-internal-sha256=".length).trim();
    } else if (arg.startsWith("--plan-file-sha256=")) {
      options.planFileSha256 = arg.slice("--plan-file-sha256=".length).trim();
    } else if (arg.startsWith("--manifest=")) {
      options.manifestPath = arg.slice("--manifest=".length).trim();
    } else if (arg.startsWith("--manifest-file-sha256=")) {
      options.manifestFileSha256 = arg.slice("--manifest-file-sha256=".length).trim();
    } else if (arg.startsWith("--checkpoints=")) {
      options.checkpointDirectory = arg.slice("--checkpoints=".length).trim();
    } else if (arg.startsWith("--catalog-evidence=")) {
      options.catalogEvidencePath = arg.slice("--catalog-evidence=".length).trim();
    } else if (arg.startsWith("--catalog-evidence-file-sha256=")) {
      options.catalogEvidenceFileSha256 = arg
        .slice("--catalog-evidence-file-sha256=".length)
        .trim();
    } else if (arg.startsWith("--catalog-evidence-body-sha256=")) {
      options.catalogEvidenceBodySha256 = arg
        .slice("--catalog-evidence-body-sha256=".length)
        .trim();
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDirectory = arg.slice("--output-dir=".length).trim();
    } else if (arg.startsWith("--reviewed-at=")) {
      options.reviewedAt = arg.slice("--reviewed-at=".length).trim();
    } else if (arg.startsWith("--required-rows=")) {
      options.requiredRows = positiveInt("--required-rows", arg.slice("--required-rows=".length));
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }
  if (!options.seal) {
    throw new Error(`Refusing to write without explicit --seal.\n\n${usage()}`);
  }
  for (const [label, value] of [
    ["--plan", options.planPath],
    ["--plan-internal-sha256", options.planInternalSha256],
    ["--plan-file-sha256", options.planFileSha256],
    ["--manifest", options.manifestPath],
    ["--manifest-file-sha256", options.manifestFileSha256],
    ["--checkpoints", options.checkpointDirectory],
    ["--catalog-evidence", options.catalogEvidencePath],
    ["--catalog-evidence-file-sha256", options.catalogEvidenceFileSha256],
    ["--catalog-evidence-body-sha256", options.catalogEvidenceBodySha256],
    ["--reviewed-at", options.reviewedAt],
  ] as const) {
    if (!value) throw new Error(`${label} is required.\n\n${usage()}`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const prepared = await prepareCatalogTitleAlignment({
    planPath: options.planPath as string,
    expectedPlanInternalSha256: options.planInternalSha256 as string,
    expectedPlanFileSha256: options.planFileSha256 as string,
    desiredManifestPath: options.manifestPath as string,
    expectedDesiredManifestFileSha256: options.manifestFileSha256 as string,
    checkpointDirectory: options.checkpointDirectory as string,
    catalogEvidencePath: options.catalogEvidencePath as string,
    expectedCatalogEvidenceFileSha256: options.catalogEvidenceFileSha256 as string,
    expectedCatalogEvidenceBodySha256: options.catalogEvidenceBodySha256 as string,
    reviewedAt: options.reviewedAt as string,
    requiredManifestRows: options.requiredRows,
  });
  const written = await writeCatalogTitleAlignmentArtifact(
    options.outputDirectory,
    prepared,
  );
  process.stdout.write(
    `${JSON.stringify({
      mode: "OFFLINE_LOCAL_ONLY",
      source_plan_internal_sha256: prepared.sourcePlan.sha256,
      source_plan_file_sha256: prepared.sourcePlanFileSha256,
      source_manifest_file_sha256: prepared.sourceDesiredManifestFileSha256,
      checkpoint_set_sha256: prepared.checkpointSetSha256,
      aligned_skus: prepared.reviews.map((review) => review.sku),
      staged_dependency_exceptions: prepared.stagedDependencyExceptions.map(
        (exception) => ({
          sku: exception.sku,
          action_id: exception.action_id,
          submission_id: exception.submission_id,
          checkpoint_event_sha256: exception.checkpoint_event_sha256,
        }),
      ),
      reviewed_catalog_api_overrides: prepared.reviews
        .filter((review) => review.identity_validation === "REVIEWED_CATALOG_API_EVIDENCE")
        .map((review) => review.sku),
      ...written,
      external_mutations: {
        amazon_calls: 0,
        database_writes: 0,
        r2_writes: 0,
        channelmax_writes: 0,
      },
    }, null, 2)}\n`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
