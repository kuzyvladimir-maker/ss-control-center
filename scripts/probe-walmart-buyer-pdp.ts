#!/usr/bin/env node
/**
 * Dry-run by default. A live Oxylabs calibration requires all three explicit
 * gates: --run --ack-paid-call=1 --max-paid-calls=1.
 */

import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildOxylabsWalmartProductCalibrationPlan,
  executeOxylabsWalmartProductCalibration,
  fetchOxylabsCalibrationTransport,
} from "../src/lib/sourcing/oxylabs-walmart-product-calibration";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.join(ROOT, "data", "audits", "walmart-buyer-pdp-calibration");

function parseArgs(argv: string[]): {
  itemId: string;
  run: boolean;
  ackPaidCall: boolean;
  maxPaidCalls: boolean;
} {
  const parsed = {
    itemId: "",
    run: false,
    ackPaidCall: false,
    maxPaidCalls: false,
  };
  for (const arg of argv) {
    if (arg.startsWith("--item-id=")) parsed.itemId = arg.slice("--item-id=".length);
    else if (arg === "--run") parsed.run = true;
    else if (arg === "--ack-paid-call=1") parsed.ackPaidCall = true;
    else if (arg === "--max-paid-calls=1") parsed.maxPaidCalls = true;
    else {
      throw new Error(`unsupported argument: ${arg}`);
    }
  }
  if (!parsed.itemId) throw new Error("--item-id=<exact numeric Walmart item ID> is required");
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildOxylabsWalmartProductCalibrationPlan(args.itemId);

  if (!args.run) {
    process.stdout.write(`${JSON.stringify({ mode: "DRY_RUN_NO_NETWORK", output_dir: OUTPUT_DIR, plan }, null, 2)}\n`);
    return;
  }

  if (!args.ackPaidCall || !args.maxPaidCalls) {
    throw new Error("live calibration requires --ack-paid-call=1 and --max-paid-calls=1");
  }
  const username = process.env.OXYLABS_USERNAME;
  const password = process.env.OXYLABS_PASSWORD;
  if (!username?.trim() || !password?.trim()) {
    throw new Error("live calibration requires OXYLABS_USERNAME and OXYLABS_PASSWORD");
  }
  const rawPath = path.join(OUTPUT_DIR, plan.artifact_contract.raw_response_filename);
  const receiptPath = path.join(OUTPUT_DIR, plan.artifact_contract.receipt_filename);

  // Reserve both immutable artifacts before the paid request. If either name
  // exists, no network call occurs and the prior evidence is never overwritten.
  await mkdir(OUTPUT_DIR, { recursive: true });
  const rawHandle = await open(rawPath, "wx");
  let receiptHandle: Awaited<ReturnType<typeof open>>;
  try {
    receiptHandle = await open(receiptPath, "wx");
  } catch (error) {
    await rawHandle.close();
    throw error;
  }
  try {
    const execution = await executeOxylabsWalmartProductCalibration({
      plan,
      username,
      password,
      transport: fetchOxylabsCalibrationTransport,
    });
    // Raw bytes are flushed first. No response parser exists in this probe.
    await rawHandle.writeFile(execution.raw_response_bytes);
    await rawHandle.sync();
    await rawHandle.close();
    await receiptHandle.writeFile(`${JSON.stringify(execution.receipt, null, 2)}\n`, "utf8");
    await receiptHandle.sync();
    await receiptHandle.close();
    process.stdout.write(`${receiptPath}\n`);
    if (execution.receipt.response.http_status < 200
      || execution.receipt.response.http_status >= 300) {
      process.exitCode = 1;
    }
  } catch (error) {
    await Promise.allSettled([rawHandle.close(), receiptHandle.close()]);
    throw error;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
