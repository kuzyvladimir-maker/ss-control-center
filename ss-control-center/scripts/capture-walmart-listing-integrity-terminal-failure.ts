#!/usr/bin/env -S node --env-file=.env --import tsx

/**
 * Capture one read-only Listing Quality response for a terminal Walmart repair
 * FAIL and seal an unresolved quarantine disposition.
 *
 * External effects: one OAuth POST, one read-only Listing Quality query POST,
 * immutable local evidence writes. This command has no listing/feed endpoint.
 */

import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
} from "node:fs/promises";
import path from "node:path";

import {
  buildWalmartListingIntegrityTerminalFailureDisposition,
  captureWalmartListingQualityEvidence,
} from "../src/lib/walmart/listing-integrity-terminal-failure.ts";

const HELP = `Usage:
  node --env-file=.env --import tsx \
    scripts/capture-walmart-listing-integrity-terminal-failure.ts \
    --qualification=/absolute/qualification-receipt.json \
    --expect-qualification-sha256=<sha256> \
    --output-dir=/absolute/new/directory

Effects: one OAuth POST, one read-only Listing Quality POST, immutable local
artifact writes. Walmart content writes, retries, model calls and DB writes: 0.
`;

function fail(message: string): never {
  throw new Error(message);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail(`${label} must be lowercase SHA-256`);
  }
  return value;
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || !path.isAbsolute(value)
    || path.resolve(value) !== value) {
    fail(`${label} must be an absolute normalized path`);
  }
  return value;
}

function parseArgs(argv: string[]): {
  help: boolean;
  qualification?: string;
  expectQualificationSha256?: string;
  outputDir?: string;
} {
  if (argv.length === 1 && ["--help", "help"].includes(argv[0]!)) {
    return { help: true };
  }
  const flags = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([a-z0-9-]+)=(.+)$/u.exec(argument);
    if (!match || flags.has(match[1]!)) {
      fail(`unsupported or duplicate argument: ${argument}`);
    }
    flags.set(match[1]!, match[2]!);
  }
  const required = [
    "qualification",
    "expect-qualification-sha256",
    "output-dir",
  ];
  if (flags.size !== required.length || required.some((key) => !flags.has(key))) {
    fail(`required arguments: ${required.map((key) => `--${key}=...`).join(" ")}`);
  }
  return {
    help: false,
    qualification: absolutePath(flags.get("qualification"), "--qualification"),
    expectQualificationSha256: exactSha(
      flags.get("expect-qualification-sha256"),
      "--expect-qualification-sha256",
    ),
    outputDir: absolutePath(flags.get("output-dir"), "--output-dir"),
  };
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function stableFile(file: string, maximum: number): Promise<Buffer> {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size < 1 || before.size > maximum) {
    fail(`${file}: expected one bounded regular file`);
  }
  const bytes = await readFile(file);
  const after = await lstat(file);
  if (before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs || bytes.byteLength !== before.size) {
    fail(`${file}: changed while read`);
  }
  return bytes;
}

function exactText(value: unknown, label: string, maximum = 1_024): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum) {
    fail(`${label} must be bounded exact text`);
  }
  return value;
}

function credentials(storeIndex: number) {
  return {
    client_id: exactText(
      process.env[`WALMART_CLIENT_ID_STORE${storeIndex}`],
      `WALMART_CLIENT_ID_STORE${storeIndex}`,
    ),
    client_secret: exactText(
      process.env[`WALMART_CLIENT_SECRET_STORE${storeIndex}`],
      `WALMART_CLIENT_SECRET_STORE${storeIndex}`,
      4_096,
    ),
    seller_id: exactText(
      process.env[`WALMART_STORE${storeIndex}_SELLER_ID`],
      `WALMART_STORE${storeIndex}_SELLER_ID`,
    ),
  };
}

async function writeExclusive(file: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(file, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const qualificationPath = options.qualification!;
  const qualificationBytes = await stableFile(qualificationPath, 16 * 1024 * 1024);
  const qualificationFileSha256 = sha256(qualificationBytes);
  if (qualificationFileSha256 !== options.expectQualificationSha256) {
    fail("qualification exact-file SHA differs");
  }
  const operatorReceipt = JSON.parse(qualificationBytes.toString("utf8")) as {
    listing?: { store_index?: unknown; sku?: unknown };
  };
  const storeIndex = Number(operatorReceipt.listing?.store_index);
  if (!Number.isSafeInteger(storeIndex) || storeIndex < 1) {
    fail("qualification store_index is invalid");
  }
  const sku = exactText(operatorReceipt.listing?.sku, "qualification sku", 512);
  const captured = await captureWalmartListingQualityEvidence({
    store_index: storeIndex,
    sku,
    credentials: credentials(storeIndex),
  });
  const disposition = buildWalmartListingIntegrityTerminalFailureDisposition({
    operator_receipt: operatorReceipt,
    operator_receipt_file_sha256: qualificationFileSha256,
    listing_quality_receipt: captured.receipt,
    listing_quality_response_bytes: captured.response_bytes,
    created_at: new Date().toISOString(),
  });

  const outputDir = options.outputDir!;
  await mkdir(path.dirname(outputDir), { recursive: true, mode: 0o700 });
  await mkdir(outputDir, { recursive: false, mode: 0o700 });
  const receiptBytes = jsonBytes(captured.receipt);
  const dispositionBytes = jsonBytes(disposition);
  await Promise.all([
    writeExclusive(
      path.join(outputDir, "listing-quality-response.bin"),
      captured.response_bytes,
    ),
    writeExclusive(path.join(outputDir, "listing-quality-receipt.json"), receiptBytes),
    writeExclusive(path.join(outputDir, "failure-disposition.json"), dispositionBytes),
    writeExclusive(
      path.join(outputDir, "failure-disposition.sha256"),
      Buffer.from(`${sha256(dispositionBytes)}\n`, "utf8"),
    ),
  ]);
  await chmod(outputDir, 0o500);
  process.stdout.write(`${JSON.stringify({
    status: disposition.status,
    disposition_id: disposition.disposition_id,
    listing: disposition.listing,
    classification: disposition.classification,
    next_action: disposition.next_action,
    next_listing_unblocked: disposition.sequence.next_listing_unblocked,
    evidence: {
      output_directory: outputDir,
      qualification_file_sha256: qualificationFileSha256,
      listing_quality_response_sha256: sha256(captured.response_bytes),
      listing_quality_receipt_file_sha256: sha256(receiptBytes),
      failure_disposition_file_sha256: sha256(dispositionBytes),
    },
    external_effects: captured.receipt.external_effects,
  }, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
