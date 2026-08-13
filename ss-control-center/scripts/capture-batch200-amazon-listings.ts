import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { MARKETPLACE_ID, spApiGet } from "../src/lib/amazon-sp-api/client";
import { sha256 } from "../src/lib/amazon-sp-api/uncrustables-order-history";

const CAPTURE_SCHEMA = "uncrustables-batch200-amazon-listings-capture/v1";

interface StagedRow {
  slug?: unknown;
  sku?: unknown;
  channel_sku_id?: unknown;
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function writeNew(path: string, value: string | Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o400);
  try {
    await handle.writeFile(value);
    await handle.sync();
    await handle.chmod(0o400);
  } finally {
    await handle.close();
  }
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await stat(path);
    fail(`output already exists: ${path}`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Capture full live Amazon Listings Items GET evidence for exact batch-200 SKUs.\n"
      + "Required: --staged /ABS/staged.json --out-dir /ABS/NEW --store-index 1\n"
      + "Read-only: 200 GET targets, zero database or marketplace writes.",
    );
    return;
  }
  const allowed = new Set(["--staged", "--out-dir", "--store-index"]);
  if (args.some((arg) => arg.startsWith("--") && !allowed.has(arg))) fail("unknown argument");
  const stagedPath = exactArg(args, "--staged");
  const outDir = exactArg(args, "--out-dir");
  const storeIndex = Number(exactArg(args, "--store-index"));
  if (storeIndex !== 1) fail("batch-200 capture is bound to store-index 1");
  for (const [name, path] of [["--staged", stagedPath], ["--out-dir", outDir]]) {
    if (!isAbsolute(path) || normalize(path) !== path) fail(`${name} must be a normalized absolute path`);
  }
  const sellerId = process.env.AMAZON_SP_SELLER_ID_STORE1?.trim();
  if (!sellerId) fail("AMAZON_SP_SELLER_ID_STORE1 is required");
  const stagedBytes = await readFile(await realpath(stagedPath));
  const parsed = JSON.parse(stagedBytes.toString("utf8")) as StagedRow[];
  if (!Array.isArray(parsed) || parsed.length !== 200) fail("staged input must contain exact batch-200 rows");
  const targets = parsed.map((row, index) => {
    if (
      typeof row.slug !== "string" || !row.slug
      || typeof row.sku !== "string" || !/^[A-Z0-9-]{5,64}$/u.test(row.sku)
      || typeof row.channel_sku_id !== "string" || !row.channel_sku_id
    ) fail(`staged row ${index + 1} has invalid identity`);
    return {
      ordinal: index + 1,
      slug: row.slug,
      sku: row.sku,
      channelSkuId: row.channel_sku_id,
    };
  });
  if (new Set(targets.map((target) => target.sku)).size !== targets.length) fail("staged SKUs are not unique");
  if (new Set(targets.map((target) => target.channelSkuId)).size !== targets.length) {
    fail("staged ChannelSKU ids are not unique");
  }
  const parent = dirname(outDir);
  if (await realpath(parent) !== parent) fail("output parent must be a real path");
  await assertAbsent(outDir);
  const temporary = join(parent, `.${basename(outDir)}.tmp-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  const entries: Array<Record<string, unknown>> = [];
  let getCalls = 0;
  try {
    for (const target of targets) {
      let physicalStarted = false;
      try {
        const raw = await spApiGet(
          `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(target.sku)}`,
          {
            storeId: "store1",
            params: {
              marketplaceIds: MARKETPLACE_ID,
              includedData: "summaries,attributes,issues,offers,fulfillmentAvailability,procurement",
            },
            retries: 1,
            signal: AbortSignal.timeout(30_000),
            beforeRequest: () => {
              physicalStarted = true;
              getCalls += 1;
            },
          },
        ) as Record<string, unknown>;
        const rawJson = `${canonicalJson(raw)}\n`;
        const rawFile = `${String(target.ordinal).padStart(4, "0")}-${target.sku}.json`;
        await writeNew(resolve(temporary, rawFile), rawJson);
        const summary = Array.isArray(raw.summaries)
          ? raw.summaries[0] as Record<string, unknown> | undefined
          : undefined;
        const issues = Array.isArray(raw.issues) ? raw.issues : [];
        entries.push({
          ...target,
          status: "CAPTURED",
          capturedAt: new Date().toISOString(),
          asin: typeof summary?.asin === "string" ? summary.asin : null,
          productType: typeof summary?.productType === "string" ? summary.productType : null,
          listingStatus: Array.isArray(summary?.status) ? summary.status : [],
          issueCount: issues.length,
          errorIssueCount: issues.filter((issue) =>
            issue && typeof issue === "object" && (issue as Record<string, unknown>).severity === "ERROR").length,
          rawFile,
          rawSha256: sha256(rawJson),
          rawByteLength: Buffer.byteLength(rawJson),
        });
      } catch (error) {
        entries.push({
          ...target,
          status: "GET_FAILED",
          capturedAt: new Date().toISOString(),
          physicalRequestStarted: physicalStarted,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (target.ordinal % 20 === 0) {
        console.log(JSON.stringify({ event: "BATCH200_CAPTURE_PROGRESS", attempted: target.ordinal }));
      }
      await sleep(220);
    }
    const capture = {
      schemaVersion: CAPTURE_SCHEMA,
      capturedAt: new Date().toISOString(),
      scope: { storeIndex, marketplaceId: MARKETPLACE_ID, expectedTargets: 200 },
      source: {
        stagedPath,
        stagedSha256: sha256(stagedBytes),
        access: "LISTINGS_ITEMS_GET_ONLY",
        physicalGetCalls: getCalls,
        retries: 0,
        databaseWrites: 0,
        marketplaceMutations: 0,
      },
      counts: {
        targets: targets.length,
        captured: entries.filter((entry) => entry.status === "CAPTURED").length,
        failed: entries.filter((entry) => entry.status !== "CAPTURED").length,
        withAsin: entries.filter((entry) => entry.status === "CAPTURED" && entry.asin).length,
      },
      entries,
    };
    const captureJson = `${canonicalJson(capture)}\n`;
    await Promise.all([
      writeNew(resolve(temporary, "capture.json"), captureJson),
      writeNew(resolve(temporary, "capture.sha256"), `${sha256(captureJson)}\n`),
    ]);
    await assertAbsent(outDir);
    await rename(temporary, outDir);
    console.log(JSON.stringify({
      status: capture.counts.failed === 0 ? "CAPTURED" : "CAPTURED_WITH_FAILURES",
      outDir,
      captureSha256: sha256(captureJson),
      ...capture.counts,
      databaseWrites: 0,
      marketplaceMutations: 0,
    }, null, 2));
    if (capture.counts.failed > 0) process.exitCode = 2;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
