import assert from "node:assert/strict";
import { cp, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WalmartItemReportReissueSourceEvidenceV2Error,
  buildWalmartItemReportReissueSourceEvidenceV2,
  parseWalmartItemReportReissueSourceEvidenceV2Bytes,
  serializeWalmartItemReportReissueSourceEvidenceV2,
} from "../item-report-reissue-source-evidence-v2.ts";
import {
  canonicalWalmartItemReportJson,
  walmartItemReportSha256,
} from "../item-report-published-source.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../../..");
const EVIDENCE_NAME = "item-v6-disposition-probe-store1-20260719-claude-v1";
const SESSION_NAME = "item-v6-store1-20260718-codex-v1";
const ACTUAL_EVIDENCE = path.join(
  PROJECT_ROOT,
  "data/audits/walmart-source-intake",
  EVIDENCE_NAME,
);
const ACTUAL_CAPTURE_ROOT = path.join(
  PROJECT_ROOT,
  "data/audits/walmart-source-captures",
);

function input(evidenceRoot = ACTUAL_EVIDENCE, captureRoot = ACTUAL_CAPTURE_ROOT) {
  return {
    evidence_root: evidenceRoot,
    capture_root: captureRoot,
    prior_session_name: SESSION_NAME,
    release_id: "walmart-item-v6-reissue-source-evidence-store1-20260719-v2",
    reviewed_at: "2026-07-19T23:26:39.000Z",
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof WalmartItemReportReissueSourceEvidenceV2Error);
    assert.equal(error.code, code);
    return true;
  });
}

function forgeSelfHashValidRelease(release, mutateBody) {
  const forged = structuredClone(release);
  mutateBody(forged.body);
  forged.body_sha256 = walmartItemReportSha256(forged.body);
  forged.release_sha256 = walmartItemReportSha256({
    schema_version: forged.schema_version,
    body: forged.body,
    body_sha256: forged.body_sha256,
  });
  return Buffer.from(canonicalWalmartItemReportJson(forged), "utf8");
}

async function privateCopy() {
  const parent = await mkdtemp(path.join(tmpdir(), "walmart-item-reissue-v2-"));
  await chmod(parent, 0o700);
  const evidenceRoot = path.join(parent, EVIDENCE_NAME);
  const captureRoot = path.join(parent, "captures");
  await cp(ACTUAL_EVIDENCE, evidenceRoot, { recursive: true, preserveTimestamps: true });
  await cp(ACTUAL_CAPTURE_ROOT, captureRoot, { recursive: true, preserveTimestamps: true });
  await chmod(evidenceRoot, 0o700);
  await chmod(path.join(evidenceRoot, "broad-48h"), 0o700);
  await chmod(path.join(evidenceRoot, "exact-v6"), 0o700);
  await chmod(captureRoot, 0o700);
  const session = path.join(captureRoot, SESSION_NAME);
  for (const directory of [session, "capture", "checkpoints", "trusted", "sanitized"]
    .map((entry) => path.isAbsolute(entry) ? entry : path.join(session, entry))) {
    await chmod(directory, 0o500);
  }
  return { parent, evidenceRoot, captureRoot };
}

async function cleanupFixture(fixture) {
  const session = path.join(fixture.captureRoot, SESSION_NAME);
  for (const directory of [
    path.join(session, "capture"),
    path.join(session, "checkpoints"),
    path.join(session, "trusted"),
    path.join(session, "sanitized"),
    session,
    fixture.captureRoot,
  ]) {
    await chmod(directory, 0o700).catch(() => {});
  }
  await rm(fixture.parent, { recursive: true, force: true });
}

test("seals the actual independent probe and quarantined incident without mutation", async () => {
  const release = await buildWalmartItemReportReissueSourceEvidenceV2(input());
  assert.equal(
    release.body.disposition_basis.verdict,
    "NO_API_VISIBLE_V6_REQUEST_IN_EXACT_QUERY_WINDOW",
  );
  assert.equal(release.body.disposition_basis.original_create_failure_proven, false);
  assert.equal(release.body.disposition_basis.duplicate_replacement_request_risk, "NON_ZERO");
  assert.equal(release.body.exact_probe.raw_response_sha256,
    "fe1f5edce085101e740636b9a577fa1bdee5c36c33c4971f743cb18933249873");
  assert.equal(release.body.broad_probe.role, "CORROBORATING_ONLY");
  assert.equal(release.body.original_ambiguous_post.consume_conflicting_final, false);
  const bytes = serializeWalmartItemReportReissueSourceEvidenceV2(release);
  assert.deepEqual(parseWalmartItemReportReissueSourceEvidenceV2Bytes(bytes), release);
});

test("rejects one changed exact raw-response byte", async (t) => {
  const fixture = await privateCopy();
  t.after(() => cleanupFixture(fixture));
  const target = path.join(fixture.evidenceRoot, "exact-v6/response-raw.bytes");
  const bytes = await readFile(target);
  bytes[0] ^= 1;
  await chmod(target, 0o600);
  await writeFile(target, bytes);
  await chmod(target, 0o400);
  await expectCode(
    buildWalmartItemReportReissueSourceEvidenceV2(input(fixture.evidenceRoot, fixture.captureRoot)),
    "EVIDENCE_HASH_MISMATCH",
  );
});

test("rejects an extra probe file", async (t) => {
  const fixture = await privateCopy();
  t.after(() => cleanupFixture(fixture));
  const extra = path.join(fixture.evidenceRoot, "exact-v6/unreviewed.json");
  await writeFile(extra, "{}", { mode: 0o400 });
  await expectCode(
    buildWalmartItemReportReissueSourceEvidenceV2(input(fixture.evidenceRoot, fixture.captureRoot)),
    "UNEXPECTED_EVIDENCE_INVENTORY",
  );
});

test("rejects unsafe evidence mode before parsing", async (t) => {
  const fixture = await privateCopy();
  t.after(() => cleanupFixture(fixture));
  await chmod(path.join(fixture.evidenceRoot, "exact-v6/request-manifest.json"), 0o600);
  await expectCode(
    buildWalmartItemReportReissueSourceEvidenceV2(input(fixture.evidenceRoot, fixture.captureRoot)),
    "UNSAFE_EVIDENCE_FILE",
  );
});

test("rejects a self-hash-valid release with noncanonical bytes", async () => {
  const release = await buildWalmartItemReportReissueSourceEvidenceV2(input());
  const pretty = Buffer.from(JSON.stringify(release, null, 2), "utf8");
  await expectCode(
    Promise.resolve().then(() => parseWalmartItemReportReissueSourceEvidenceV2Bytes(pretty)),
    "NON_CANONICAL_RELEASE_BYTES",
  );
});

test("rejects self-hash-valid forged security claims throughout the full body", async (t) => {
  const release = await buildWalmartItemReportReissueSourceEvidenceV2(input());
  const forgedHash = "0".repeat(64);
  const cases = [
    {
      name: "v999 evidence policy",
      mutate(body) { body.policy.policy_id = "walmart-item-v6-independent-disposition-probe/v999"; },
    },
    {
      name: "777 maximum evidence age",
      mutate(body) { body.policy.maximum_exact_probe_age_ms = 777; },
    },
    {
      name: "v999 exact query",
      mutate(body) { body.exact_probe.query.reportVersion = "v999"; },
    },
    {
      name: "777 raw byte length",
      mutate(body) { body.exact_probe.raw_response_byte_length = 777; },
    },
    {
      name: "original failure claimed proven",
      mutate(body) { body.disposition_basis.original_create_failure_proven = true; },
    },
    {
      name: "extra disposition field",
      mutate(body) { body.disposition_basis.forged = true; },
    },
    {
      name: "session authority hash",
      mutate(body) { body.original_ambiguous_post.session_authority_sha256 = forgedHash; },
    },
    {
      name: "create manifest hash",
      mutate(body) { body.original_ambiguous_post.create_manifest_sha256 = forgedHash; },
    },
    {
      name: "reservation hash",
      mutate(body) { body.original_ambiguous_post.request_reserved_sha256 = forgedHash; },
    },
    {
      name: "manual review hash",
      mutate(body) { body.original_ambiguous_post.manual_review_sha256 = forgedHash; },
    },
    {
      name: "terminal failure hash",
      mutate(body) { body.original_ambiguous_post.terminal_page_failure_sha256 = forgedHash; },
    },
    {
      name: "prohibited page-complete hash",
      mutate(body) {
        body.original_ambiguous_post.prohibited_conflicting_page_complete_sha256 = forgedHash;
      },
    },
    {
      name: "prohibited result hash",
      mutate(body) {
        body.original_ambiguous_post.prohibited_conflicting_result_sha256 = forgedHash;
      },
    },
    {
      name: "prohibited final hash",
      mutate(body) {
        body.original_ambiguous_post.prohibited_conflicting_complete_sha256 = forgedHash;
      },
    },
    {
      name: "exact probe artifact inventory",
      mutate(body) { body.exact_probe.artifact_inventory[1].byte_length = 777; },
    },
    {
      name: "quarantine artifact inventory",
      mutate(body) { body.quarantined_session_inventory.pop(); },
    },
    {
      name: "duplicate risk downgraded",
      mutate(body) { body.disposition_basis.duplicate_replacement_request_risk = "ZERO"; },
    },
    {
      name: "owner Ed25519 gate disabled",
      mutate(body) { body.disposition_basis.owner_ed25519_disposition_required = false; },
    },
    {
      name: "one-shot permit gate disabled",
      mutate(body) {
        body.disposition_basis.separate_one_shot_execution_permit_required = false;
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const bytes = forgeSelfHashValidRelease(release, item.mutate);
      await expectCode(
        Promise.resolve().then(() => parseWalmartItemReportReissueSourceEvidenceV2Bytes(bytes)),
        "INVALID_RELEASE",
      );
    });
  }
});
