/**
 * Build the exact 164-row Amazon Uncrustables completion matrix from pinned,
 * immutable local evidence. This script performs no network, database,
 * browser, Amazon, ChannelMAX, or other external read/write operation.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDefaultUncrustablesCompletionMatrix,
  sha256,
} from "../src/lib/bundle-factory/repair/uncrustables-completion-matrix";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const defaultOutputDir = path.join(
  repoRoot,
  "data/audits/uncrustables-completion-matrix-20260718-v5",
);

function parseOutputDir(argv: readonly string[]): string {
  let outputDir = defaultOutputDir;
  for (const argument of argv) {
    if (argument.startsWith("--output-dir=")) {
      const requested = argument.slice("--output-dir=".length).trim();
      if (!requested) throw new Error("--output-dir requires a path.");
      outputDir = path.resolve(repoRoot, requested);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return outputDir;
}

async function atomicWrite(target: string, content: string): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  await rename(temporary, target);
}

async function writeWithSidecar(
  target: string,
  content: string,
): Promise<{ path: string; sha256: string }> {
  await atomicWrite(target, content);
  const digest = sha256(content);
  const sidecar = `${digest}  ${path.basename(target)}\n`;
  await atomicWrite(`${target}.sha256`, sidecar);
  return { path: path.relative(repoRoot, target), sha256: digest };
}

async function main(): Promise<void> {
  const outputDir = parseOutputDir(process.argv.slice(2));
  await mkdir(outputDir, { recursive: true });
  const built = await buildDefaultUncrustablesCompletionMatrix(repoRoot);
  const prefix = built.matrix.matrix_id;
  const json = `${JSON.stringify(built.matrix, null, 2)}\n`;

  const outputs = await Promise.all([
    writeWithSidecar(path.join(outputDir, `${prefix}.json`), json),
    writeWithSidecar(path.join(outputDir, `${prefix}.csv`), built.csv),
    writeWithSidecar(
      path.join(outputDir, `${prefix}.summary.md`),
      built.summaryMarkdown,
    ),
  ]);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        read_only: true,
        external_mutations: false,
        matrix_id: built.matrix.matrix_id,
        body_sha256: built.matrix.body_sha256,
        deterministic_as_of: built.matrix.deterministic_as_of,
        summary: built.matrix.summary,
        outputs,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
