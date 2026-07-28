#!/usr/bin/env node

/**
 * Builds a deterministic, offline-only BD Default -> Manual 59021 canary
 * package. The package deliberately contains no rollback TSV and authorizes no
 * upload because the exact import encoding for restoring null/Default is not
 * proven by the pinned local evidence.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CHANNELMAX_BD_DEFAULT_MANUAL_PINNED_SOURCES,
  buildChannelMaxBdDefaultManualCanaryPackage,
  type BuildChannelMaxBdDefaultManualCanaryInput,
  type ChannelMaxBdDefaultManualSource,
} from "../src/lib/channelmax-agent/uncrustables-default-manual-roundtrip-canary";

const DEFAULT_OUTPUT_DIR =
  "data/repairs/channelmax-manual/" +
  "uncrustables-bd-default-manual-roundtrip-canary-20260719-v1";
const DEFAULT_CREATED_AT = "2026-07-19T06:18:00.000Z";

interface Options {
  outputDir: string;
  createdAt: Date;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    outputDir: DEFAULT_OUTPUT_DIR,
    createdAt: new Date(DEFAULT_CREATED_AT),
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: node --import tsx scripts/build-uncrustables-channelmax-default-manual-canary.ts [options]",
          "",
          `  --output-dir=NEW_DIR  Default ${DEFAULT_OUTPUT_DIR}`,
          `  --created-at=ISO       Default ${DEFAULT_CREATED_AT}`,
          "",
          "Offline only: emits a blocked forward package and no rollback TSV.",
        ].join("\n") + "\n",
      );
      process.exit(0);
    }
    if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length).trim();
    } else if (arg.startsWith("--created-at=")) {
      options.createdAt = new Date(arg.slice("--created-at=".length));
    } else {
      throw new Error(`Unknown argument ${arg}.`);
    }
  }
  if (!options.outputDir || !Number.isFinite(options.createdAt.getTime())) {
    throw new Error("A new --output-dir and valid --created-at are required.");
  }
  return options;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function loadSource(
  binding: { path: string },
): Promise<ChannelMaxBdDefaultManualSource> {
  return {
    path: binding.path,
    bytes: await readFile(binding.path),
  };
}

async function loadSources(): Promise<
  BuildChannelMaxBdDefaultManualCanaryInput["sources"]
> {
  const entries = await Promise.all(
    Object.entries(CHANNELMAX_BD_DEFAULT_MANUAL_PINNED_SOURCES).map(
      async ([key, binding]) => [key, await loadSource(binding)] as const,
    ),
  );
  return Object.fromEntries(entries) as BuildChannelMaxBdDefaultManualCanaryInput["sources"];
}

async function writeArtifact(
  outputDir: string,
  fileName: string,
  bytes: Buffer,
): Promise<void> {
  const artifactPath = path.join(outputDir, fileName);
  await writeFile(artifactPath, bytes, { flag: "wx" });
  await writeFile(
    `${artifactPath}.sha256`,
    `${sha256(bytes)}  ${fileName}\n`,
    { flag: "wx" },
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const pkg = buildChannelMaxBdDefaultManualCanaryPackage({
    sources: await loadSources(),
    createdAt: options.createdAt,
  });
  await mkdir(path.dirname(options.outputDir), { recursive: true });
  await mkdir(options.outputDir, { recursive: false });
  const manifestBytes = Buffer.from(
    `${JSON.stringify(pkg.manifest, null, 2)}\n`,
    "utf8",
  );
  await Promise.all([
    writeArtifact(
      options.outputDir,
      pkg.manifest.forward_artifact.file,
      Buffer.from(pkg.forwardTsv, "utf8"),
    ),
    writeArtifact(
      options.outputDir,
      pkg.manifest.rollback_evidence_requirements.file,
      pkg.evidenceRequirementsBytes,
    ),
    writeArtifact(options.outputDir, "manifest.json", manifestBytes),
  ]);
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: "OFFLINE_ONLY",
        verdict: pkg.manifest.verdict,
        output_dir: options.outputDir,
        forward_sha256: pkg.manifest.forward_artifact.sha256,
        forward_may_upload: pkg.manifest.forward_artifact.may_upload,
        rollback_artifact: pkg.manifest.rollback_artifact,
        execution_authorized: pkg.manifest.execution_authorized,
        external_mutations: pkg.manifest.external_mutations,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

