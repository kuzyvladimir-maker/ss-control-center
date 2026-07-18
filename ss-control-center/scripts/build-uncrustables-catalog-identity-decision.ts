/**
 * Build the immutable seven-SKU catalog identity decision that narrows the
 * final Amazon apply scope from 164 to 162. Local files only; no gateways.
 */

import {
  prepareCatalogIdentityDecision,
  writeCatalogIdentityDecisionArtifact,
} from "@/lib/bundle-factory/repair/uncrustables-catalog-title-alignment";

interface Options {
  seal: boolean;
  createdAt: string | null;
  sourcePlan: string | null;
  desiredManifest: string | null;
  sourceLedger: string | null;
  donorEnrichment: string | null;
  vnCheckpoint: string | null;
  catalogEvidence: string | null;
  catalogEvidenceFileSha256: string | null;
  catalogEvidenceBodySha256: string | null;
  outputDirectory: string;
}

function usage(): string {
  return [
    "Usage: node ... scripts/build-uncrustables-catalog-identity-decision.ts --seal [options]",
    "",
    "Required:",
    "  --created-at=ISO",
    "  --source-plan=PATH",
    "  --desired-manifest=PATH",
    "  --source-ledger=PATH",
    "  --donor-enrichment=PATH",
    "  --vn-checkpoint=PATH",
    "  --catalog-evidence=PATH",
    "  --catalog-evidence-file-sha256=SHA",
    "  --catalog-evidence-body-sha256=SHA",
    "  --seal",
    "",
    "Optional:",
    "  --output-dir=DIR (default data/audits)",
    "",
    "The builder is create-only and performs zero external mutations.",
  ].join("\n");
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    seal: false,
    createdAt: null,
    sourcePlan: null,
    desiredManifest: null,
    sourceLedger: null,
    donorEnrichment: null,
    vnCheckpoint: null,
    catalogEvidence: null,
    catalogEvidenceFileSha256: null,
    catalogEvidenceBodySha256: null,
    outputDirectory: "data/audits",
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--seal") options.seal = true;
    else if (arg.startsWith("--created-at=")) options.createdAt = arg.slice("--created-at=".length).trim();
    else if (arg.startsWith("--source-plan=")) options.sourcePlan = arg.slice("--source-plan=".length).trim();
    else if (arg.startsWith("--desired-manifest=")) options.desiredManifest = arg.slice("--desired-manifest=".length).trim();
    else if (arg.startsWith("--source-ledger=")) options.sourceLedger = arg.slice("--source-ledger=".length).trim();
    else if (arg.startsWith("--donor-enrichment=")) options.donorEnrichment = arg.slice("--donor-enrichment=".length).trim();
    else if (arg.startsWith("--vn-checkpoint=")) options.vnCheckpoint = arg.slice("--vn-checkpoint=".length).trim();
    else if (arg.startsWith("--catalog-evidence=")) options.catalogEvidence = arg.slice("--catalog-evidence=".length).trim();
    else if (arg.startsWith("--catalog-evidence-file-sha256=")) {
      options.catalogEvidenceFileSha256 = arg.slice("--catalog-evidence-file-sha256=".length).trim();
    } else if (arg.startsWith("--catalog-evidence-body-sha256=")) {
      options.catalogEvidenceBodySha256 = arg.slice("--catalog-evidence-body-sha256=".length).trim();
    } else if (arg.startsWith("--output-dir=")) options.outputDirectory = arg.slice("--output-dir=".length).trim();
    else throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
  }
  if (!options.seal) throw new Error(`Refusing to write without --seal.\n\n${usage()}`);
  for (const [label, value] of [
    ["--created-at", options.createdAt],
    ["--source-plan", options.sourcePlan],
    ["--desired-manifest", options.desiredManifest],
    ["--source-ledger", options.sourceLedger],
    ["--donor-enrichment", options.donorEnrichment],
    ["--vn-checkpoint", options.vnCheckpoint],
    ["--catalog-evidence", options.catalogEvidence],
    ["--catalog-evidence-file-sha256", options.catalogEvidenceFileSha256],
    ["--catalog-evidence-body-sha256", options.catalogEvidenceBodySha256],
  ] as const) {
    if (!value) throw new Error(`${label} is required.\n\n${usage()}`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const prepared = await prepareCatalogIdentityDecision({
    createdAt: options.createdAt as string,
    sourcePlanPath: options.sourcePlan as string,
    desiredManifestPath: options.desiredManifest as string,
    sourceLedgerPath: options.sourceLedger as string,
    donorEnrichmentPath: options.donorEnrichment as string,
    vnCheckpointPath: options.vnCheckpoint as string,
    catalogEvidencePath: options.catalogEvidence as string,
    expectedCatalogEvidenceFileSha256: options.catalogEvidenceFileSha256 as string,
    expectedCatalogEvidenceBodySha256: options.catalogEvidenceBodySha256 as string,
  });
  const written = await writeCatalogIdentityDecisionArtifact(
    options.outputDirectory,
    prepared,
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: "OFFLINE_LOCAL_ONLY",
        scope: prepared.artifact.scope,
        decisions: prepared.artifact.decisions.map((decision) => ({
          sku: decision.sku,
          decision: decision.decision,
        })),
        ...written,
        external_mutations: 0,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
