import { open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";

import { sha256 } from "../src/lib/amazon-sp-api/uncrustables-order-history";

const CAPTURE_SCHEMA = "uncrustables-batch200-amazon-listings-capture/v1";
const RECEIPT_SCHEMA = "uncrustables-batch200-asin-backfill/v1";

interface CaptureEntry {
  status?: unknown;
  sku?: unknown;
  channelSkuId?: unknown;
  asin?: unknown;
}

interface Capture {
  schemaVersion?: unknown;
  scope?: { storeIndex?: unknown; expectedTargets?: unknown };
  counts?: { targets?: unknown; captured?: unknown; failed?: unknown; withAsin?: unknown };
  entries?: CaptureEntry[];
}

function fail(message: string): never {
  throw new Error(message);
}

function exactArg(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1 || args.indexOf(name, index + 1) >= 0) {
    return fail(`${name} is required exactly once`);
  }
  const value = args[index + 1];
  if (!value || value !== value.trim() || value.startsWith("--")) {
    return fail(`${name} must have one exact value`);
  }
  return value;
}

async function writeNew(path: string, value: string): Promise<void> {
  try {
    await stat(path);
    fail(`receipt already exists: ${path}`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const handle = await open(path, "wx", 0o400);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.chmod(0o400);
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Verify and optionally backfill exact batch-200 ASINs into ChannelSKU.\n"
      + "Required: --capture /ABS/capture.json --capture-sha256 SHA --receipt /ABS/NEW.json\n"
      + "Optional: --apply (without it, performs a read-only preflight).",
    );
    return;
  }
  const allowed = new Set(["--capture", "--capture-sha256", "--receipt", "--apply"]);
  if (args.some((arg) => arg.startsWith("--") && !allowed.has(arg))) fail("unknown argument");
  if (args.filter((arg) => arg === "--apply").length > 1) fail("--apply may occur at most once");
  const apply = args.includes("--apply");
  const capturePath = exactArg(args, "--capture");
  const expectedSha = exactArg(args, "--capture-sha256").toLowerCase();
  const receiptPath = exactArg(args, "--receipt");
  for (const [name, path] of [["--capture", capturePath], ["--receipt", receiptPath]]) {
    if (!isAbsolute(path) || normalize(path) !== path) fail(`${name} must be a normalized absolute path`);
  }
  if (await realpath(dirname(receiptPath)) !== dirname(receiptPath)) {
    fail("receipt parent must be a real path");
  }
  const captureBytes = await readFile(await realpath(capturePath));
  const actualSha = sha256(captureBytes);
  if (!/^[a-f0-9]{64}$/u.test(expectedSha) || actualSha !== expectedSha) {
    fail("capture SHA-256 mismatch");
  }
  const capture = JSON.parse(captureBytes.toString("utf8")) as Capture;
  if (
    capture.schemaVersion !== CAPTURE_SCHEMA
    || capture.scope?.storeIndex !== 1
    || capture.scope.expectedTargets !== 200
    || capture.counts?.targets !== 200
    || capture.counts.captured !== 200
    || capture.counts.failed !== 0
    || capture.counts.withAsin !== 200
    || !Array.isArray(capture.entries)
    || capture.entries.length !== 200
  ) fail("capture is not a complete exact batch-200 listing capture");
  const targets = capture.entries.map((entry, index) => {
    if (
      entry.status !== "CAPTURED"
      || typeof entry.sku !== "string" || !entry.sku
      || typeof entry.channelSkuId !== "string" || !entry.channelSkuId
      || typeof entry.asin !== "string" || !/^B0[A-Z0-9]{8}$/u.test(entry.asin)
    ) fail(`capture entry ${index + 1} has invalid identity`);
    return { sku: entry.sku, channelSkuId: entry.channelSkuId, asin: entry.asin };
  });
  if (new Set(targets.map((target) => target.sku)).size !== 200) fail("capture SKUs are not unique");
  if (new Set(targets.map((target) => target.channelSkuId)).size !== 200) {
    fail("capture ChannelSKU ids are not unique");
  }
  if (new Set(targets.map((target) => target.asin)).size !== 200) fail("capture ASINs are not unique");

  const prismaModule = await import("../src/lib/prisma");
  const prisma = prismaModule.prisma ?? prismaModule.default?.prisma;
  if (!prisma) fail("Prisma client unavailable");
  try {
    const rows = await prisma.channelSKU.findMany({
      where: { id: { in: targets.map((target) => target.channelSkuId) } },
      select: { id: true, sku: true, asin: true, channel: true },
    });
    if (rows.length !== 200) fail(`database scope mismatch: expected 200 rows, found ${rows.length}`);
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const target of targets) {
      const row = byId.get(target.channelSkuId);
      if (!row || row.sku !== target.sku || row.channel !== "AMAZON_SALUTEM") {
        fail(`database identity mismatch for ${target.sku}`);
      }
      if (row.asin && row.asin !== target.asin) fail(`existing ASIN conflict for ${target.sku}`);
    }
    const alreadyCorrect = targets.filter((target) => byId.get(target.channelSkuId)?.asin === target.asin);
    const missing = targets.filter((target) => !byId.get(target.channelSkuId)?.asin);
    if (alreadyCorrect.length + missing.length !== 200) fail("database preflight partition mismatch");

    let updated = 0;
    if (apply && missing.length > 0) {
      // Turso expires a transaction after 5 seconds; 200 remote statements in
      // one transaction exceed that boundary. Short exact chunks remain
      // atomic and the null-only predicate makes a resumed apply idempotent.
      const chunkSize = 20;
      for (let offset = 0; offset < missing.length; offset += chunkSize) {
        const chunk = missing.slice(offset, offset + chunkSize);
        const operations = chunk.map((target) => prisma.channelSKU.updateMany({
          where: { id: target.channelSkuId, sku: target.sku, asin: null },
          data: { asin: target.asin },
        }));
        const results = await prisma.$transaction(operations);
        if (results.some((result) => result.count !== 1)) {
          fail("atomic ASIN backfill chunk lost an identity race");
        }
        updated += results.reduce((sum, result) => sum + result.count, 0);
        console.log(JSON.stringify({
          event: "ASIN_BACKFILL_PROGRESS",
          updated,
          remaining: missing.length - updated,
        }));
      }
    }
    const verification = await prisma.channelSKU.findMany({
      where: { id: { in: targets.map((target) => target.channelSkuId) } },
      select: { id: true, sku: true, asin: true },
    });
    const verifiedById = new Map(verification.map((row) => [row.id, row]));
    const verified = targets.filter((target) => {
      const row = verifiedById.get(target.channelSkuId);
      return row?.sku === target.sku && row.asin === target.asin;
    }).length;
    if (apply && verified !== 200) fail(`post-write verification failed: ${verified}/200`);
    const receipt = {
      schemaVersion: RECEIPT_SCHEMA,
      completedAt: new Date().toISOString(),
      mode: apply ? "APPLY" : "PREFLIGHT",
      capture: { path: capturePath, sha256: actualSha },
      scope: { storeIndex: 1, channel: "AMAZON_SALUTEM", targets: 200 },
      result: {
        alreadyCorrect: alreadyCorrect.length,
        missingBefore: missing.length,
        databaseRowsUpdated: updated,
        verifiedAfter: verified,
      },
      claims: { marketplaceCalls: 0, marketplaceMutations: 0 },
    };
    const receiptJson = `${JSON.stringify(receipt, null, 2)}\n`;
    await writeNew(receiptPath, receiptJson);
    console.log(JSON.stringify({
      status: apply ? "APPLIED_AND_VERIFIED" : "PREFLIGHT_READY",
      receipt: receiptPath,
      receiptSha256: sha256(receiptJson),
      ...receipt.result,
      marketplaceMutations: 0,
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
