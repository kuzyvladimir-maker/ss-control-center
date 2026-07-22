import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES,
} from "../item-report-reissue-absence-probe-evidence.ts";
import {
  WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_BASELINE_SHA256,
  buildWalmartItemReportReissueSourceEvidenceRenewalV1,
  parseWalmartItemReportReissueSourceEvidenceRenewalV1Bytes,
  serializeWalmartItemReportReissueSourceEvidenceRenewalV1,
  verifyWalmartItemReportReissueSourceEvidenceRenewalV1,
  walmartItemReportReissueSourceEvidenceRenewalV1BaselineRelease,
  walmartItemReportReissueSourceEvidenceRenewalV1ProbeInventory,
} from "../item-report-reissue-source-evidence-renewal-v1.ts";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../../../..");
const PROJECT_ROOT = path.join(REPOSITORY_ROOT, "ss-control-center");
const BASELINE_PATH = path.join(
  REPOSITORY_ROOT,
  "release-artifacts/walmart-item-report-reissue-v2-private-20260719",
  "evidence-release-r4-final-candidate/source-evidence-release.json",
);
const PROBE_ROOT = path.join(
  PROJECT_ROOT,
  "data/audits/walmart-source-intake/item-v6-absence-probe-store1-20260722-codex-v2",
);

async function fixtureBytes() {
  const baseline = await readFile(BASELINE_PATH);
  const probe = {};
  for (const name of WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES) {
    probe[name] = await readFile(path.join(PROBE_ROOT, name));
  }
  return { baseline, probe };
}

async function renewal() {
  const fixture = await fixtureBytes();
  return buildWalmartItemReportReissueSourceEvidenceRenewalV1({
    release_id: "walmart-item-v6-reissue-source-renewal-store1-20260722-v1",
    reviewed_at: "2026-07-22T06:40:00.000Z",
    baseline_source_evidence_bytes: fixture.baseline,
    fresh_probe_artifacts: fixture.probe,
    expected_probe_id: "item-v6-absence-probe-store1-20260722-codex-v2",
  });
}

test("builds one self-contained renewal from exact R4 and exact fresh probe bytes", async () => {
  const value = await renewal();
  const bytes = serializeWalmartItemReportReissueSourceEvidenceRenewalV1(value);
  const parsed = parseWalmartItemReportReissueSourceEvidenceRenewalV1Bytes(bytes);

  assert.equal(parsed.release_sha256, value.release_sha256);
  assert.equal(parsed.body.baseline.artifact_sha256,
    WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_BASELINE_SHA256);
  assert.equal(parsed.body.fresh_probe.outcome, "ABSENCE_ONLY");
  assert.equal(parsed.body.fresh_probe.evidence_family_sha256,
    "fdd883fbe5db6067545a010e0b7df4dce7122803f535f0c0b0a2676313f41e57");
  assert.equal(parsed.body.fresh_probe.result_artifact_sha256,
    "3f2beddc1cfba748f3f8793950e7a043115f30d695bc4bda1b3c23a19dab4f74");
  assert.equal(parsed.body.fresh_probe.artifact_inventory.length, 6);
  assert.equal(walmartItemReportReissueSourceEvidenceRenewalV1ProbeInventory(parsed).length, 6);
  assert.equal(
    walmartItemReportReissueSourceEvidenceRenewalV1BaselineRelease(parsed).body.release_id,
    "walmart-item-v6-reissue-source-evidence-store1-20260719-v2",
  );
});

test("rejects a different baseline and an out-of-window review", async () => {
  const fixture = await fixtureBytes();
  const wrongBaseline = Buffer.from(fixture.baseline);
  wrongBaseline[wrongBaseline.length - 1] ^= 1;
  assert.throws(
    () => buildWalmartItemReportReissueSourceEvidenceRenewalV1({
      release_id: "renewal-wrong-baseline",
      reviewed_at: "2026-07-22T06:40:00.000Z",
      baseline_source_evidence_bytes: wrongBaseline,
      fresh_probe_artifacts: fixture.probe,
    }),
    (error) => error?.code === "BASELINE_HASH_MISMATCH",
  );
  assert.throws(
    () => buildWalmartItemReportReissueSourceEvidenceRenewalV1({
      release_id: "renewal-stale-review",
      reviewed_at: "2026-07-23T06:39:07.290Z",
      baseline_source_evidence_bytes: fixture.baseline,
      fresh_probe_artifacts: fixture.probe,
    }),
    (error) => error?.code === "STALE_RENEWAL",
  );
});

test("rejects embedded-byte tampering even when the outer object remains JSON", async () => {
  const value = structuredClone(await renewal());
  value.body.fresh_probe.artifact_inventory[2].bytes_base64 = Buffer.from(
    '{"page":1,"totalCount":1,"limit":1,"requests":[{"requestId":"forged"}]}',
  ).toString("base64");
  assert.throws(
    () => verifyWalmartItemReportReissueSourceEvidenceRenewalV1(value),
    (error) => error?.code === "PROBE_HASH_MISMATCH",
  );
});

test("rejects noncanonical serialized renewal bytes", async () => {
  const value = await renewal();
  const pretty = Buffer.from(JSON.stringify(value, null, 2), "utf8");
  assert.throws(
    () => parseWalmartItemReportReissueSourceEvidenceRenewalV1Bytes(pretty),
    (error) => error?.code === "NON_CANONICAL_RENEWAL",
  );
});
