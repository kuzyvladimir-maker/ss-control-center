// node --import tsx --test src/lib/bundle-factory/__tests__/uncrustables-channelmax-safe-base-offer-manual.test.ts

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import type {
  BaseOfferPreservePlan,
  BaseOfferPreserveSelection,
} from "../repair/uncrustables-base-offer-preserve";
import { sha256 } from "../repair/uncrustables-base-offer-preserve";
import {
  SAFE_BASE_OFFER_CHANNELMAX_MODEL,
  SAFE_BASE_OFFER_CHANNELMAX_PINNED_SOURCES,
  SAFE_BASE_OFFER_IDENTITY_HOLDS,
  buildSafeBaseOfferChannelMaxManualAssignment,
  verifySafeBaseOfferChannelMaxManualAssignment,
  type BuildSafeBaseOfferChannelMaxManualInput,
  type SafeBaseOfferChannelMaxManualManifest,
  type SafeBaseOfferSource,
} from "../repair/uncrustables-channelmax-safe-base-offer-manual";

const CREATED_AT = new Date("2026-07-19T05:50:00.000Z");
const ARTIFACT_DIR =
  "data/repairs/channelmax-manual/" +
  "uncrustables-safe-base-offer-161-20260719-v1";

async function load<T>(filePath: string): Promise<SafeBaseOfferSource<T>> {
  const bytes = await readFile(filePath);
  return {
    path: filePath,
    bytes,
    value: JSON.parse(bytes.toString("utf8")) as T,
  };
}

async function fixture(): Promise<BuildSafeBaseOfferChannelMaxManualInput> {
  const sources = SAFE_BASE_OFFER_CHANNELMAX_PINNED_SOURCES;
  const [plan, fullSelection, priceMatrix, prewrite, postwrite, discovery] =
    await Promise.all([
      load<BaseOfferPreservePlan>(sources.plan.path),
      load<BaseOfferPreserveSelection>(sources.full_selection.path),
      load(sources.price_matrix.path),
      load(sources.channelmax_prewrite.path),
      load(sources.channelmax_postwrite.path),
      load(sources.manual_model_discovery.path),
    ]);
  return {
    plan,
    fullSelection,
    priceMatrix,
    channelMaxPrewrite: prewrite,
    channelMaxPostwrite: postwrite,
    manualModelDiscovery: discovery,
    createdAt: CREATED_AT,
  };
}

test("exact safe assignment covers 161 rows, excludes SZ/TY/VN, and targets Manual 59021", async () => {
  const built = buildSafeBaseOfferChannelMaxManualAssignment(await fixture());
  assert.equal(built.manifest.rows.length, 161);
  assert.equal(built.manifest.scope.cohort_rows, 164);
  assert.equal(built.manifest.scope.identity_hold_rows, 3);
  assert.deepEqual(
    built.manifest.identity_holds.map((hold) => hold.sku),
    [...SAFE_BASE_OFFER_IDENTITY_HOLDS],
  );
  assert.deepEqual(built.manifest.manual_model, {
    ...SAFE_BASE_OFFER_CHANNELMAX_MODEL,
    runtime_rules_must_be_verified_after_upload: ["44a", "44b"],
  });
  assert.equal(
    built.manifest.rows.some((row) =>
      (SAFE_BASE_OFFER_IDENTITY_HOLDS as readonly string[]).includes(row.sku),
    ),
    false,
  );
  assert.equal(new Set(built.manifest.rows.map((row) => row.sku)).size, 161);
  assert.equal(built.tsv.split("\r\n").length, 163);
  assert.equal(built.tsv.includes("\n") && !built.tsv.includes("\r\n"), false);
  assert.equal(built.manifest.uploaded, false);
  assert.equal(built.manifest.execution_authorized, false);
  assert.equal(built.manifest.external_mutations, 0);
  assert.equal(
    built.manifest.rows.filter(
      (row) => row.channelmax_evidence === "MASS_WAVE_INDEPENDENT_READBACK",
    ).length,
    152,
  );
  verifySafeBaseOfferChannelMaxManualAssignment(built.manifest, built.tsv);
});

test("builder rejects any changed pinned bytes or object-level missing/extra scope", async () => {
  const changedBytes = await fixture();
  changedBytes.priceMatrix = {
    ...changedBytes.priceMatrix,
    bytes: Buffer.concat([changedBytes.priceMatrix.bytes, Buffer.from(" ")]),
  };
  assert.throws(
    () => buildSafeBaseOfferChannelMaxManualAssignment(changedBytes),
    /exact pinned canonical source/,
  );

  const missingSku = await fixture();
  const plan = structuredClone(missingSku.plan.value);
  plan.entries.pop();
  missingSku.plan = { ...missingSku.plan, value: plan };
  assert.throws(
    () => buildSafeBaseOfferChannelMaxManualAssignment(missingSku),
    /schema\/profile\/seal|161 actions|differs from its exact file bytes/,
  );

  const extraHold = await fixture();
  const postwrite = structuredClone(extraHold.channelMaxPostwrite.value) as Record<
    string,
    unknown
  >;
  (postwrite.identity_holds as unknown[]).push({
    sku: "FAKE-HOLD",
    asin: "B000000000",
    reason: "FAKE",
  });
  extraHold.channelMaxPostwrite = {
    ...extraHold.channelMaxPostwrite,
    value: postwrite,
  };
  assert.throws(
    () => buildSafeBaseOfferChannelMaxManualAssignment(extraHold),
    /differs from its exact file bytes|exact required set/,
  );
});

test("manifest verifier rejects held SKU insertion, model drift, or TSV mutation", async () => {
  const built = buildSafeBaseOfferChannelMaxManualAssignment(await fixture());
  const held = structuredClone(built.manifest);
  held.rows[0].sku = "SZ-ASPI-JFAT";
  assert.throws(
    () => verifySafeBaseOfferChannelMaxManualAssignment(held, built.tsv),
    /invalid or weakened|scope\/content/,
  );
  const model = structuredClone(built.manifest);
  model.manual_model.id = "59149" as "59021";
  assert.throws(
    () => verifySafeBaseOfferChannelMaxManualAssignment(model, built.tsv),
    /invalid or weakened/,
  );
  assert.throws(
    () =>
      verifySafeBaseOfferChannelMaxManualAssignment(
        built.manifest,
        built.tsv.replace("59021", "59149"),
      ),
    /invalid or weakened/,
  );
});

test("checked-in offline artifact and sidecars match exact builder output", async () => {
  const [manifestBytes, manifestSidecar] = await Promise.all([
    readFile(path.join(ARTIFACT_DIR, "manifest.json")),
    readFile(path.join(ARTIFACT_DIR, "manifest.json.sha256"), "utf8"),
  ]);
  const manifest = JSON.parse(
    manifestBytes.toString("utf8"),
  ) as SafeBaseOfferChannelMaxManualManifest;
  const [tsvBytes, tsvSidecar] = await Promise.all([
    readFile(path.join(ARTIFACT_DIR, manifest.tsv_file)),
    readFile(path.join(ARTIFACT_DIR, `${manifest.tsv_file}.sha256`), "utf8"),
  ]);
  const rebuilt = buildSafeBaseOfferChannelMaxManualAssignment(await fixture());
  assert.deepEqual(manifest, rebuilt.manifest);
  assert.equal(tsvBytes.toString("utf8"), rebuilt.tsv);
  assert.equal(manifestSidecar, `${sha256(manifestBytes)}  manifest.json\n`);
  assert.equal(tsvSidecar, `${sha256(tsvBytes)}  ${manifest.tsv_file}\n`);
  verifySafeBaseOfferChannelMaxManualAssignment(manifest, tsvBytes.toString("utf8"));
});
