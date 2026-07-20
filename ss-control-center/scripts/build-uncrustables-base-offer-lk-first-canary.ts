#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  BaseOfferPreservePlan,
  BaseOfferPreserveSelection,
} from "../src/lib/bundle-factory/repair/uncrustables-base-offer-preserve";
import {
  LK_FIRST_CANARY_ACTION_ID,
  LK_FIRST_CANARY_SKU,
  assertBaseOfferLiveSelection,
  createBaseOfferLiveSelection,
} from "../src/lib/bundle-factory/repair/uncrustables-base-offer-live-contract";
import {
  assertBaseOfferPreservePlan,
  assertBaseOfferPreserveSelection,
  sha256,
} from "../src/lib/bundle-factory/repair/uncrustables-base-offer-preserve";

const SOURCE_DIR =
  "data/repairs/base-offer-preserve/" +
  "uncrustables-base-offer-preserve-20260719-v3";
const PLAN_PATH = `${SOURCE_DIR}/base-offer-preserve-plan.json`;
const FULL_SELECTION_PATH = `${SOURCE_DIR}/base-offer-preserve-selection.json`;
const OUTPUT_DIR =
  "data/repairs/base-offer-preserve/" +
  "uncrustables-base-offer-lk-first-canary-20260719-v1";

async function load<T>(filePath: string): Promise<{ bytes: Buffer; value: T }> {
  const bytes = await readFile(filePath);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) as T };
}

async function main(): Promise<void> {
  const [loadedPlan, loadedFullSelection] = await Promise.all([
    load<BaseOfferPreservePlan>(PLAN_PATH),
    load<BaseOfferPreserveSelection>(FULL_SELECTION_PATH),
  ]);
  assertBaseOfferPreservePlan(loadedPlan.value);
  assertBaseOfferPreserveSelection(loadedPlan.value, loadedFullSelection.value);
  const sourceEntry = loadedPlan.value.entries.find(
    (entry) => entry.action_id === LK_FIRST_CANARY_ACTION_ID,
  );
  if (
    !sourceEntry ||
    sourceEntry.sku !== LK_FIRST_CANARY_SKU ||
    sourceEntry.target.regular_base !== 76.99 ||
    sourceEntry.target.maximum !== 76.99 ||
    sourceEntry.before.list_price.sha256 !==
      sourceEntry.simulated_after.list_price.sha256 ||
    sourceEntry.before.discounted_price.sha256 !==
      sourceEntry.simulated_after.discounted_price.sha256
  ) {
    throw new Error("FINAL v3 LK canary contract is missing or has drifted.");
  }
  const canary = createBaseOfferLiveSelection({
    plan: loadedPlan.value,
    fullSelection: loadedFullSelection.value,
    kind: "CANARY",
    actionIds: [LK_FIRST_CANARY_ACTION_ID],
    createdAt: new Date("2026-07-19T04:30:00.000Z"),
    selectionId: "UBOLS-LK-FIRST-CANARY-20260719-V1",
  });
  assertBaseOfferLiveSelection(
    loadedPlan.value,
    loadedFullSelection.value,
    canary,
  );
  const manifest = {
    schema_version: "uncrustables-amazon-base-offer-lk-first-canary-proposal/v1",
    immutable: true,
    offline_only: true,
    execution_authorized: false,
    external_mutations: 0,
    source_plan: {
      path: PLAN_PATH,
      file_sha256: sha256(loadedPlan.bytes),
      body_sha256: loadedPlan.value.body_sha256,
    },
    source_full_selection: {
      path: FULL_SELECTION_PATH,
      file_sha256: sha256(loadedFullSelection.bytes),
      body_sha256: loadedFullSelection.value.body_sha256,
    },
    live_selection: canary,
    next_required_gates: [
      "FRESH_LIVE_SP_API_164_ROW_SNAPSHOT",
      "SEALED_ROLLBACK_BINDING",
      "EXACT_PREVIEW_TOKEN_AND_ENV_ARM",
      "OWNER_LIVE_AUTHORIZATION_FOR_APPLY",
      "EXACT_APPLY_TOKEN_AND_ENV_ARM",
    ],
  };
  await mkdir(path.dirname(OUTPUT_DIR), { recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: false });
  const selectionPath = path.join(OUTPUT_DIR, "live-selection.json");
  const manifestPath = path.join(OUTPUT_DIR, "canary-proposal.json");
  const selectionBytes = `${JSON.stringify(canary, null, 2)}\n`;
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(selectionPath, selectionBytes, { flag: "wx" });
  await writeFile(`${selectionPath}.sha256`, `${sha256(selectionBytes)}  live-selection.json\n`, {
    flag: "wx",
  });
  await writeFile(manifestPath, manifestBytes, { flag: "wx" });
  await writeFile(`${manifestPath}.sha256`, `${sha256(manifestBytes)}  canary-proposal.json\n`, {
    flag: "wx",
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        output_dir: OUTPUT_DIR,
        first_action_id: canary.first_action_id,
        selected_skus: canary.selected_skus,
        selection_body_sha256: canary.body_sha256,
        execution_authorized: false,
        external_mutations: 0,
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
