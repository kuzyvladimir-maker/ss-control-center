// node --import tsx --test src/lib/channelmax-agent/__tests__/uncrustables-default-manual-roundtrip-canary.test.ts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  CHANNELMAX_BD_DEFAULT_MANUAL_CANARY,
  CHANNELMAX_BD_DEFAULT_MANUAL_FORWARD_TSV,
  CHANNELMAX_BD_DEFAULT_MANUAL_PINNED_SOURCES,
  buildChannelMaxBdDefaultManualCanaryPackage,
  verifyChannelMaxBdDefaultManualCanaryPackage,
  type BuildChannelMaxBdDefaultManualCanaryInput,
  type ChannelMaxBdDefaultManualCanaryManifest,
  type ChannelMaxDefaultRollbackEvidenceRequirements,
} from "../uncrustables-default-manual-roundtrip-canary";

const CREATED_AT = new Date("2026-07-19T06:18:00.000Z");
const ARTIFACT_DIR =
  "data/repairs/channelmax-manual/" +
  "uncrustables-bd-default-manual-roundtrip-canary-20260719-v1";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture(): Promise<BuildChannelMaxBdDefaultManualCanaryInput> {
  const entries = await Promise.all(
    Object.entries(CHANNELMAX_BD_DEFAULT_MANUAL_PINNED_SOURCES).map(
      async ([key, binding]) => [
        key,
        { path: binding.path, bytes: await readFile(binding.path) },
      ] as const,
    ),
  );
  return {
    sources: Object.fromEntries(
      entries,
    ) as BuildChannelMaxBdDefaultManualCanaryInput["sources"],
    createdAt: CREATED_AT,
  };
}

test("builds one exact blocked Default-to-Manual forward artifact without inventing rollback", async () => {
  const pkg = buildChannelMaxBdDefaultManualCanaryPackage(await fixture());
  assert.equal(
    sha256(Buffer.from(pkg.forwardTsv, "utf8")),
    "d708407a88702a4f80aae3e2c3d0353c41a64f2f264ed64d50783f6cdb45e2fa",
  );
  assert.equal(Buffer.byteLength(pkg.forwardTsv), 124);
  assert.equal(pkg.forwardTsv, CHANNELMAX_BD_DEFAULT_MANUAL_FORWARD_TSV);
  assert.equal(pkg.forwardTsv.split("\r\n").filter(Boolean).length, 2);
  assert.match(
    pkg.forwardTsv,
    /^SKU\tASIN\tSellingVenue\tMinSellingPrice\tMaxSellingPrice\tRepricingModelID\r\nBD-AS8P-XAW5\tB0H85MXFH8\tAmazonUS\t66\.95\t76\.99\t59021\r\n$/,
  );
  assert.equal(pkg.manifest.execution_authorized, false);
  assert.equal(pkg.manifest.forward_artifact.may_upload, false);
  assert.equal(pkg.manifest.rollback_artifact, null);
  assert.equal(pkg.manifest.protocol.max_forward_uploads, 0);
  assert.equal(pkg.manifest.protocol.max_rollback_uploads, 0);
  verifyChannelMaxBdDefaultManualCanaryPackage(pkg);
});

test("treats 35218 as documentation-only and enumerates exact evidence for a real round trip", async () => {
  const pkg = buildChannelMaxBdDefaultManualCanaryPackage(await fixture());
  const requirements = pkg.evidenceRequirements;
  assert.deepEqual(requirements.documented_candidate, {
    repricing_model_id: "35218",
    repricing_model_name: "Default",
    disposition: "DOCUMENTED_MODEL_ID_ONLY_NOT_PROVEN_IMPORT_ENCODING",
    may_be_emitted_in_rollback_tsv: false,
  });
  assert.equal(requirements.accepted_rollback_encoding, null);
  assert.deepEqual(
    requirements.rejected_assumptions.map((entry) => entry.encoding),
    [
      "OMIT_REPRICING_MODEL_ID_COLUMN",
      "BLANK_REPRICING_MODEL_ID",
      "NULL_LITERAL",
      "35218",
    ],
  );
  assert.deepEqual(
    requirements.required_evidence.map((entry) => entry.code),
    [
      "FRESH_EXACT_DEFAULT_PREWRITE",
      "AUTHENTICATED_DEFAULT_MODEL_REGISTRY",
      "ROLLBACK_ANALYZE_PREVIEW",
      "PREARMED_EXACT_ROLLBACK",
      "FORWARD_RECEIPT_AND_READBACK",
      "ROLLBACK_RECEIPT_AND_READBACK",
      "DELAYED_DEFAULT_HOLD",
    ],
  );
  assert.deepEqual(requirements.terminal_success_state, {
    repricing_model_id: null,
    repricing_model_name: "Default",
    minimum_price: 66.95,
    maximum_price: 76.99,
    sku: CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.sku,
    asin: CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.asin,
    site_id: 300,
  });
});

test("rejects any pinned-source byte drift", async () => {
  const input = await fixture();
  input.sources.bd_postwrite = {
    ...input.sources.bd_postwrite,
    bytes: Buffer.concat([input.sources.bd_postwrite.bytes, Buffer.from(" ")]),
  };
  assert.throws(
    () => buildChannelMaxBdDefaultManualCanaryPackage(input),
    /bd_postwrite is not the exact pinned source/,
  );
});

test("verifier rejects a synthesized rollback or weakened upload gate", async () => {
  const pkg = buildChannelMaxBdDefaultManualCanaryPackage(await fixture());
  const inventedRollback = structuredClone(pkg.manifest) as unknown as Record<
    string,
    unknown
  >;
  inventedRollback.rollback_artifact = {
    file: "rollback-to-default.tsv",
    repricing_model_id: "35218",
  };
  assert.throws(
    () =>
      verifyChannelMaxBdDefaultManualCanaryPackage({
        ...pkg,
        manifest: inventedRollback as unknown as ChannelMaxBdDefaultManualCanaryManifest,
      }),
    /invalid or execution-weakened/,
  );

  const weakened = structuredClone(pkg.manifest);
  weakened.forward_artifact.may_upload = true as false;
  assert.throws(
    () =>
      verifyChannelMaxBdDefaultManualCanaryPackage({ ...pkg, manifest: weakened }),
    /invalid or execution-weakened/,
  );
});

test("checked-in manifest, evidence requirements, forward TSV, and sidecars are deterministic", async () => {
  const pkg = buildChannelMaxBdDefaultManualCanaryPackage(await fixture());
  const files = (await readdir(ARTIFACT_DIR)).sort();
  assert.deepEqual(files, [
    "default-rollback-evidence-required.json",
    "default-rollback-evidence-required.json.sha256",
    "forward-to-manual-59021.tsv",
    "forward-to-manual-59021.tsv.sha256",
    "manifest.json",
    "manifest.json.sha256",
  ]);
  assert.equal(
    files.some(
      (file) => file.includes("rollback") && file.endsWith(".tsv"),
    ),
    false,
  );
  const [manifestBytes, requirementsBytes, forwardBytes] = await Promise.all([
    readFile(path.join(ARTIFACT_DIR, "manifest.json")),
    readFile(
      path.join(ARTIFACT_DIR, "default-rollback-evidence-required.json"),
    ),
    readFile(path.join(ARTIFACT_DIR, "forward-to-manual-59021.tsv")),
  ]);
  const manifest = JSON.parse(
    manifestBytes.toString("utf8"),
  ) as ChannelMaxBdDefaultManualCanaryManifest;
  const requirements = JSON.parse(
    requirementsBytes.toString("utf8"),
  ) as ChannelMaxDefaultRollbackEvidenceRequirements;
  assert.deepEqual(manifest, pkg.manifest);
  assert.deepEqual(requirements, pkg.evidenceRequirements);
  assert.equal(requirementsBytes.toString("utf8"), pkg.evidenceRequirementsBytes.toString("utf8"));
  assert.equal(forwardBytes.toString("utf8"), pkg.forwardTsv);
  for (const file of [
    "manifest.json",
    "default-rollback-evidence-required.json",
    "forward-to-manual-59021.tsv",
  ]) {
    const [bytes, sidecar] = await Promise.all([
      readFile(path.join(ARTIFACT_DIR, file)),
      readFile(path.join(ARTIFACT_DIR, `${file}.sha256`), "utf8"),
    ]);
    assert.equal(sidecar, `${sha256(bytes)}  ${file}\n`);
  }
  verifyChannelMaxBdDefaultManualCanaryPackage({
    forwardTsv: forwardBytes.toString("utf8"),
    evidenceRequirements: requirements,
    evidenceRequirementsBytes: requirementsBytes,
    manifest,
  });
});

