import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  assertChannelMaxUncrustablesMutationMayExecute,
  buildChannelMaxUncrustablesMutationPreflight,
  ChannelMaxUncrustablesPreflightError,
  type ChannelMaxUncrustablesMutationPreflightInput,
} from "../uncrustables-mutation-preflight";

const ROOT = process.cwd();
const V10_DIR = path.join(
  ROOT,
  "data/repairs/generated/uncrustables-amazon-launch-aware-162-20260718-v10",
);

const FILES = {
  sourcePlan: path.join(
    V10_DIR,
    "URP-20260718T162541078Z-2af6e0a671b7.json",
  ),
  assignmentManifest: path.join(
    V10_DIR,
    "URP-20260718T162541078Z-2af6e0a671b7-channelmax.manifest.json",
  ),
  assignmentTsv: path.join(
    V10_DIR,
    "URP-20260718T162541078Z-2af6e0a671b7-channelmax.txt",
  ),
  inventorySnapshot: path.join(
    ROOT,
    "data/audits/channelmax-live-snapshot-20260718T215936Z.json",
  ),
  manualModelDiscovery: path.join(
    ROOT,
    "data/audits/channelmax-manual-model-discovery-20260718T220023Z.json",
  ),
} as const;

async function exactInput(): Promise<ChannelMaxUncrustablesMutationPreflightInput> {
  const [
    sourcePlanBytes,
    assignmentManifestBytes,
    assignmentTsvBytes,
    inventorySnapshotBytes,
    manualModelDiscoveryBytes,
  ] = await Promise.all([
    readFile(FILES.sourcePlan),
    readFile(FILES.assignmentManifest),
    readFile(FILES.assignmentTsv),
    readFile(FILES.inventorySnapshot),
    readFile(FILES.manualModelDiscovery),
  ]);
  return {
    sourcePlanBytes,
    assignmentManifestBytes,
    assignmentTsvBytes,
    inventorySnapshotBytes,
    manualModelDiscoveryBytes,
  };
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function errorCode(code: string) {
  return (error: unknown) =>
    error instanceof ChannelMaxUncrustablesPreflightError && error.code === code;
}

test("exact sealed v10 and live evidence produce a deterministic but blocked preflight", async () => {
  const input = await exactInput();
  const first = buildChannelMaxUncrustablesMutationPreflight(input);
  const second = buildChannelMaxUncrustablesMutationPreflight(input);

  assert.equal(first.sha256, second.sha256);
  assert.equal(first.mode, "OFFLINE_FAIL_CLOSED");
  assert.equal(first.mutation_execution_allowed, false);
  assert.deepEqual(first.diff_summary, {
    rows: 162,
    model_changes: 161,
    bounds_changes: 162,
    identity_mismatches: 1,
    noops: 0,
  });
  assert.deepEqual(first.cohort.live_model_distribution, {
    default: 162,
    manual_min_max: 2,
  });
  assert.deepEqual(first.cohort.target_before_model_distribution, {
    default: 161,
    manual_min_max: 1,
  });
  assert.deepEqual(first.cohort.identity_mismatches, [
    {
      sku: "SZ-ASPI-JFAT",
      desired_asin: "B0H776M5B5",
      observed_channelmax_asin: "B0H75VN18Z",
    },
  ]);
  assert.equal(first.rollback.default_model_restore_rows, 161);
  assert.equal(first.rollback.default_model_restore_mechanism, null);
  assert.equal(first.rollback.complete, false);
  assert.equal(first.diffs.length, 162);
  assert.deepEqual(
    first.blockers.map((blocker) => blocker.code),
    [
      "DEFAULT_MODEL_RESTORE_UNPROVEN",
      "ROLLBACK_ARTIFACT_UNVERIFIED",
      "CHANNELMAX_SKU_ASIN_IDENTITY_MISMATCH",
      "FINITE_MUTATION_EXECUTOR_ABSENT",
      "PRODUCTION_MUTATION_RELEASE_GATE_DISABLED",
    ],
  );
});

test("the exact canary is the sole same-model target and is still unauthorized", async () => {
  const preflight = buildChannelMaxUncrustablesMutationPreflight(await exactInput());
  assert.equal(preflight.canary.sku, "VC-ASV1-378P");
  assert.equal(preflight.canary.asin, "B0H786L5MW");
  assert.equal(preflight.canary.before_minimum_price, 251.32);
  assert.equal(preflight.canary.before_maximum_price, 289.28);
  assert.equal(preflight.canary.desired_minimum_price, 219.57);
  assert.equal(preflight.canary.desired_maximum_price, 252.99);
  assert.equal(
    createHash("sha256").update(preflight.canary.assignment_tsv).digest("hex"),
    preflight.canary.assignment_sha256,
  );
  assert.equal(preflight.canary.mutation_execution_allowed, false);
  assert.throws(
    () => assertChannelMaxUncrustablesMutationMayExecute(preflight),
    errorCode("MUTATION_EXECUTION_BLOCKED"),
  );
});

test("byte-level tampering fails even when parsed semantics are unchanged", async () => {
  const input = await exactInput();
  input.sourcePlanBytes = Buffer.concat([
    Buffer.from(input.sourcePlanBytes),
    Buffer.from(" ", "utf8"),
  ]);
  assert.throws(
    () => buildChannelMaxUncrustablesMutationPreflight(input),
    errorCode("ARTIFACT_HASH_MISMATCH"),
  );
});

test("account and selected-site drift fail before any mutation can be planned", async () => {
  const accountInput = await exactInput();
  const accountSnapshot = JSON.parse(
    Buffer.from(accountInput.inventorySnapshotBytes).toString("utf8"),
  );
  accountSnapshot.account_id = "channelmax:amznus:wrong-account";
  accountInput.inventorySnapshotBytes = jsonBytes(accountSnapshot);
  assert.throws(
    () => buildChannelMaxUncrustablesMutationPreflight(accountInput),
    errorCode("ACCOUNT_MISMATCH"),
  );

  const siteInput = await exactInput();
  const siteDiscovery = JSON.parse(
    Buffer.from(siteInput.manualModelDiscoveryBytes).toString("utf8"),
  );
  siteDiscovery.observation.manual_model_discovery.selected_site_id = "301";
  siteInput.manualModelDiscoveryBytes = jsonBytes(siteDiscovery);
  assert.throws(
    () => buildChannelMaxUncrustablesMutationPreflight(siteInput),
    errorCode("SITE_MISMATCH"),
  );
});

test("wrong manual model and wrong selling venue are terminal preflight failures", async () => {
  const modelInput = await exactInput();
  const discovery = JSON.parse(
    Buffer.from(modelInput.manualModelDiscoveryBytes).toString("utf8"),
  );
  discovery.observation.manual_model_discovery.canonical_manual_model.id = "59149";
  modelInput.manualModelDiscoveryBytes = jsonBytes(discovery);
  assert.throws(
    () => buildChannelMaxUncrustablesMutationPreflight(modelInput),
    errorCode("MANUAL_MODEL_MISMATCH"),
  );

  const venueInput = await exactInput();
  venueInput.assignmentTsvBytes = Buffer.from(
    Buffer.from(venueInput.assignmentTsvBytes)
      .toString("utf8")
      .replace("\tAmazonUS\t", "\tWalmartUS\t"),
    "utf8",
  );
  assert.throws(
    () => buildChannelMaxUncrustablesMutationPreflight(venueInput),
    errorCode("SELLING_VENUE_MISMATCH"),
  );
});

test("row count and duplicate SKU/ASIN drift fail closed", async () => {
  const countInput = await exactInput();
  const countLines = Buffer.from(countInput.assignmentTsvBytes)
    .toString("utf8")
    .slice(0, -2)
    .split("\r\n");
  countLines.pop();
  countInput.assignmentTsvBytes = Buffer.from(`${countLines.join("\r\n")}\r\n`);
  assert.throws(
    () => buildChannelMaxUncrustablesMutationPreflight(countInput),
    errorCode("ASSIGNMENT_ROW_MISMATCH"),
  );

  const duplicateInput = await exactInput();
  const duplicateLines = Buffer.from(duplicateInput.assignmentTsvBytes)
    .toString("utf8")
    .slice(0, -2)
    .split("\r\n");
  const firstFields = duplicateLines[1]!.split("\t");
  const secondFields = duplicateLines[2]!.split("\t");
  secondFields[0] = firstFields[0]!;
  secondFields[1] = firstFields[1]!;
  duplicateLines[2] = secondFields.join("\t");
  duplicateInput.assignmentTsvBytes = Buffer.from(
    `${duplicateLines.join("\r\n")}\r\n`,
  );
  assert.throws(
    () => buildChannelMaxUncrustablesMutationPreflight(duplicateInput),
    errorCode("DUPLICATE_IDENTITY"),
  );
});

test("exact exclusions and the 161 Default / 1 Manual target baseline cannot drift", async () => {
  const exclusionInput = await exactInput();
  const exclusionSnapshot = JSON.parse(
    Buffer.from(exclusionInput.inventorySnapshotBytes).toString("utf8"),
  );
  const ty = exclusionSnapshot.launch_rows.find(
    (row: { sku: string }) => row.sku === "TY-AST2-JE9P",
  );
  ty.sku = "ZZ-ASZZ-ZZZZ";
  exclusionInput.inventorySnapshotBytes = jsonBytes(exclusionSnapshot);
  assert.throws(
    () => buildChannelMaxUncrustablesMutationPreflight(exclusionInput),
    errorCode("EXCLUSION_MISMATCH"),
  );

  const distributionInput = await exactInput();
  const distributionSnapshot = JSON.parse(
    Buffer.from(distributionInput.inventorySnapshotBytes).toString("utf8"),
  );
  const targetDefault = distributionSnapshot.launch_rows.find(
    (row: { sku: string }) => row.sku === "AC-AS4J-B64F",
  );
  const excludedManual = distributionSnapshot.launch_rows.find(
    (row: { sku: string }) => row.sku === "VN-AS1A-D572",
  );
  targetDefault.repricing_model_id = "59021";
  targetDefault.repricing_model_name = "Manual min/max";
  excludedManual.repricing_model_id = null;
  excludedManual.repricing_model_name = "Default";
  distributionInput.inventorySnapshotBytes = jsonBytes(distributionSnapshot);
  assert.throws(
    () => buildChannelMaxUncrustablesMutationPreflight(distributionInput),
    errorCode("LIVE_BASELINE_MISMATCH"),
  );
});

test("an additional SKU/ASIN mismatch cannot hide behind the pinned SZ mismatch", async () => {
  const input = await exactInput();
  const snapshot = JSON.parse(
    Buffer.from(input.inventorySnapshotBytes).toString("utf8"),
  );
  const row = snapshot.launch_rows.find(
    (item: { sku: string }) => item.sku === "AC-AS4J-B64F",
  );
  row.asin = "B0H0000000";
  input.inventorySnapshotBytes = jsonBytes(snapshot);
  assert.throws(
    () => buildChannelMaxUncrustablesMutationPreflight(input),
    errorCode("ASSIGNMENT_ROW_MISMATCH"),
  );
});
