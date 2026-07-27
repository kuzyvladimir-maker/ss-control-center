/**
 * Build the immutable second reviewed Uncrustables override manifest.
 *
 * Offline only: exact pinned reads plus an immutable local artifact write.
 * No Amazon, database, object-storage, or network client is imported.
 *
 * Run:
 *   node --experimental-strip-types --experimental-transform-types \
 *     --loader ./scripts/node-native-ts-loader.mjs \
 *     scripts/build-uncrustables-reviewed-overrides-v2.ts
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  UNCRUSTABLES_SOURCE_LEDGER_SHA256,
  buildUncrustablesReviewedOverridesV2,
  type UncrustablesLedgerForReviewedOverrides,
} from "../src/lib/bundle-factory/repair/uncrustables-reviewed-overrides-v2";
import type { DesiredRepairManifest } from "../src/lib/bundle-factory/repair/uncrustables-surgical";

const LEDGER_PATH =
  "data/audits/uncrustables-ledger-20260717T232140568Z-offline.json";
const BASE_OVERRIDES_PATH =
  "data/repairs/uncrustables-reviewed-overrides-20260717.json";
const BASE_OVERRIDES_SHA256 =
  "170250cb1761a8dbf9a10d18a83a4c38ca9758ec3294bb1341c2a23106e02238";
const OUTPUT_PATH =
  "data/repairs/uncrustables-reviewed-overrides-20260718-v2.json";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeIdenticalOrCreate(
  absolutePath: string,
  bytes: Buffer,
): Promise<void> {
  try {
    const existing = await readFile(absolutePath);
    assert(
      existing.equals(bytes),
      `Refusing to overwrite immutable artifact with different bytes: ${absolutePath}`,
    );
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(path.dirname(absolutePath), { recursive: true });
  const temporary = `${absolutePath}.tmp-${process.pid}`;
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, absolutePath);
}

async function main(): Promise<void> {
  assert(
    process.argv.length === 2,
    "This deterministic builder does not accept runtime input overrides.",
  );
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const [ledgerBytes, baseBytes] = await Promise.all([
    readFile(path.resolve(root, LEDGER_PATH)),
    readFile(path.resolve(root, BASE_OVERRIDES_PATH)),
  ]);
  assert(
    sha256(ledgerBytes) === UNCRUSTABLES_SOURCE_LEDGER_SHA256,
    `Source ledger SHA-256 mismatch: ${sha256(ledgerBytes)}`,
  );
  assert(
    sha256(baseBytes) === BASE_OVERRIDES_SHA256,
    `Base reviewed overrides SHA-256 mismatch: ${sha256(baseBytes)}`,
  );

  const manifest = buildUncrustablesReviewedOverridesV2({
    ledger: JSON.parse(
      ledgerBytes.toString("utf8"),
    ) as UncrustablesLedgerForReviewedOverrides,
    baseManifest: JSON.parse(baseBytes.toString("utf8")) as DesiredRepairManifest,
  });
  const outputBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const output = path.resolve(root, OUTPUT_PATH);
  await writeIdenticalOrCreate(output, outputBytes);

  process.stdout.write(
    `${JSON.stringify({
      output: OUTPUT_PATH,
      sha256: sha256(outputBytes),
      repairs: manifest.repairs.length,
      full_text_repairs: manifest.repairs.filter((repair) => repair.text_count?.title).length,
    })}\n`,
  );
}

await main();
