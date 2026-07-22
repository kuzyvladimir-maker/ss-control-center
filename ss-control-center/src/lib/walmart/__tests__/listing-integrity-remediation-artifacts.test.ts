import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import {
  WALMART_LISTING_REPAIR_ONE_SKU_ACTION,
  assembleWalmartListingRepairOwnerAuthorization,
  walmartListingRepairOneSkuPermitSigningEnvelope,
  type WalmartListingRepairOneSkuPermit,
  type WalmartListingRepairOneSkuPermitSignedBody,
} from "../listing-integrity-remediation-authority.ts";
import {
  WALMART_LISTING_REPAIR_ARTIFACT_EVIDENCE_SCHEMA,
  createWalmartListingRepairArtifactCustody,
  readWalmartListingRepairArtifactCustodyEvidence,
  withWalmartListingRepairLockedArtifactCustody,
} from "../listing-integrity-remediation-artifacts.ts";
import {
  WALMART_LISTING_REPAIR_HTTP_RECEIPT_SCHEMA,
  type WalmartListingRepairAcceptedReceipt,
} from "../listing-integrity-remediation-writer.ts";
import type {
  WalmartListingRepairPermitTerminalReceipt,
} from "../listing-integrity-remediation-ledger.ts";

const H = (char: string): string => char.repeat(64);

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(row[key])}`
    )).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("fixture rejects undefined");
  return encoded;
}

function permitFixture(input: {
  requestManifest: Uint8Array;
  requestPayload: Uint8Array;
  targetImageCertificate: Uint8Array;
  suffix?: string;
}): WalmartListingRepairOneSkuPermit {
  const suffix = input.suffix ?? "one";
  const ledger = {
    policy_id: "walmart-listing-repair-permit-consumption-ledger/1.0.0" as const,
    ledger_id: `ledger-${suffix}`,
    ledger_epoch: `epoch-${suffix}`,
    state_directory_path_sha256: H("1"),
    directory_identity_sha256: H("2"),
    identity_artifact_sha256: H("3"),
    reservation_filename_policy: "authorization-sha256.json/exclusive-create/v1" as const,
    trusted_single_custody_host_only: true as const,
    distributed_at_most_once_claimed: false as const,
  };
  const body: WalmartListingRepairOneSkuPermitSignedBody = {
    action: WALMART_LISTING_REPAIR_ONE_SKU_ACTION,
    environment: "TEST_FIXTURE_ONLY",
    permit_id: `permit-${suffix}`,
    issued_at: "2026-07-21T12:00:00.000Z",
    expires_at: "2026-07-21T12:30:00.000Z",
    approved_by: "owner-test",
    decision_ref: `test-${suffix}`,
    sequence_authorization_sha256: H("4"),
    sequence_id: "sequence-test",
    sequence_epoch: "sequence-epoch-test",
    sequence_position: 0,
    listing: {
      channel: "WALMART_US",
      store_index: 1,
      sku: `SKU-${suffix}`,
      listing_key: `walmart:1:SKU-${suffix}`,
      item_id: "123456789",
    },
    plan_id: `plan-${suffix}`,
    plan_body_sha256: H("5"),
    target_sha256: H("6"),
    target_image_certificate_sha256: sha256(input.targetImageCertificate),
    baseline_capture_exchange_sha256: H("7"),
    product_truth: {
      expected_sha256: H("8"),
      product_truth_snapshot_id: `snapshot-${suffix}`,
      product_truth_snapshot_body_sha256: H("9"),
      truth_revision_id: `revision-${suffix}`,
      truth_revision_body_sha256: H("a"),
      truth_approval_sha256: H("b"),
    },
    apply_engine_release_sha256: H("c"),
    request_manifest_sha256: sha256(input.requestManifest),
    request_payload_sha256: sha256(input.requestPayload),
    consumption_ledger: ledger,
    claims: {
      exact_listing_count: 1,
      marketplace_write_calls: 1,
      retry_allowed: false,
      automatic_reapply_allowed: false,
      mass_apply_allowed: false,
      delist: false,
      reprice: false,
      purchase: false,
      schedule: false,
    },
  };
  return assembleWalmartListingRepairOwnerAuthorization({
    envelope: walmartListingRepairOneSkuPermitSigningEnvelope({
      key_id: "test-key",
      owner_public_key_spki_sha256: H("d"),
      signed_body: body,
    }),
    signature_base64: Buffer.alloc(64, suffix.charCodeAt(0) % 255).toString("base64"),
  });
}

function httpReceipt(payload: Uint8Array, input: {
  status?: number;
  capturedAt?: string;
  correlation?: string;
  feedId?: string;
} = {}): Buffer {
  const feedId = input.feedId;
  return Buffer.from(canonicalJson({
    schema_version: WALMART_LISTING_REPAIR_HTTP_RECEIPT_SCHEMA,
    operation: feedId ? "FEED_STATUS_GET" : "MAINTENANCE_POST",
    method: feedId ? "GET" : "POST",
    path: feedId ? `/v3/feeds/${encodeURIComponent(feedId)}` : "/v3/feeds",
    query: feedId ? { includeDetails: "true" } : { feedType: "MP_MAINTENANCE" },
    feed_id: feedId ?? null,
    status: input.status ?? 200,
    content_type: "application/json",
    content_length: payload.byteLength,
    request_correlation_id_sha256: input.correlation ?? H("e"),
    captured_at: input.capturedAt ?? "2026-07-21T12:01:00.000Z",
  }), "utf8");
}

interface Fixture {
  base: string;
  root: string;
  permit: WalmartListingRepairOneSkuPermit;
  requestManifest: Buffer;
  requestPayload: Buffer;
  responsePayload: Buffer;
  responseHttp: Buffer;
  feedId: string;
  surgical: {
    targetImageCertificate: Buffer;
    schemaContract: Buffer;
    getSpecReceipt: Buffer;
    liveItemReceipt: Buffer;
    getSpecRequest: Buffer;
    getSpecResponse: Buffer;
    liveItemResponse: Buffer;
  };
}

async function fixture(t: TestContext): Promise<Fixture> {
  const temporaryRoot = await realpath(tmpdir());
  const base = await mkdtemp(path.join(temporaryRoot, "wm-artifact-custody-"));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const requestManifest = Buffer.from("{\"manifest\":1}", "utf8");
  const requestPayload = Buffer.from("{\"payload\":1}", "utf8");
  const feedId = "feed-exact-1";
  const responsePayload = Buffer.from(JSON.stringify({ feedId }), "utf8");
  const responseHttp = httpReceipt(responsePayload);
  const targetImageCertificate = Buffer.from("{\"target_image_certificate\":1}");
  return {
    base,
    root: path.join(base, "custody"),
    permit: permitFixture({ requestManifest, requestPayload, targetImageCertificate }),
    requestManifest,
    requestPayload,
    responsePayload,
    responseHttp,
    feedId,
    surgical: {
      targetImageCertificate,
      schemaContract: Buffer.from("{\"schema_contract\":1}"),
      getSpecReceipt: Buffer.from("{\"get_spec_receipt\":1}"),
      liveItemReceipt: Buffer.from("{\"live_item_receipt\":1}"),
      getSpecRequest: Buffer.from("{\"get_spec_request\":1}"),
      getSpecResponse: Buffer.from("{\"get_spec_response\":1}"),
      liveItemResponse: Buffer.from("{\"live_item_response\":1}"),
    },
  };
}

function preparedArtifacts(fx: Fixture) {
  return {
    "request-manifest.json": fx.requestManifest,
    "request-payload.json": fx.requestPayload,
    "target-image-certificate.json": fx.surgical.targetImageCertificate,
    "surgical-schema-contract.json": fx.surgical.schemaContract,
    "surgical-get-spec-receipt.json": fx.surgical.getSpecReceipt,
    "surgical-live-item-receipt.json": fx.surgical.liveItemReceipt,
    "surgical-get-spec-request.bin": fx.surgical.getSpecRequest,
    "surgical-get-spec-response.bin": fx.surgical.getSpecResponse,
    "surgical-live-item-response.bin": fx.surgical.liveItemResponse,
  };
}

function feedStem(fx: Fixture, correlationSha: string): string {
  return `feed-status-${sha256(Buffer.from(canonicalJson({
    schema_version: "walmart-listing-repair-feed-status-call/v1",
    feed_id: fx.feedId,
    correlation_id_sha256: correlationSha,
    request_manifest_sha256: sha256(fx.requestManifest),
    request_payload_sha256: sha256(fx.requestPayload),
  }), "utf8"))}`;
}

function accepted(fx: Fixture, overrides: Partial<WalmartListingRepairAcceptedReceipt> = {}) {
  const permit = fx.permit;
  return {
    authorization_sha256: permit.authorization_sha256,
    state: "ACCEPTED" as const,
    claim_id: "claim-1",
    claimed_at: "2026-07-21T12:00:10.000Z",
    requesting_at: "2026-07-21T12:00:11.000Z",
    request_manifest_sha256: sha256(fx.requestManifest),
    request_payload_sha256: sha256(fx.requestPayload),
    consumption_ledger: permit.signed_body.consumption_ledger,
    accepted_at: "2026-07-21T12:01:01.000Z",
    apply_id: "apply-1",
    feed_id: fx.feedId,
    response_http_receipt_sha256: sha256(fx.responseHttp),
    response_payload_sha256: sha256(fx.responsePayload),
    exact_listing_count: 1 as const,
    marketplace_write_calls: 1 as const,
    ...overrides,
  } satisfies WalmartListingRepairAcceptedReceipt;
}

function succeededTerminal(
  fx: Fixture,
  feedHttp: Uint8Array,
  feedPayload: Uint8Array,
  overrides: Partial<WalmartListingRepairPermitTerminalReceipt> = {},
): WalmartListingRepairPermitTerminalReceipt {
  return {
    authorization_sha256: fx.permit.authorization_sha256,
    state: "SUCCEEDED",
    claim_id: "claim-1",
    claimed_at: "2026-07-21T12:00:10.000Z",
    claim_path: "/ledger/claim.json",
    claim_file_sha256: H("1"),
    consumption_ledger: fx.permit.signed_body.consumption_ledger,
    ledger_head_path: "/ledger/head.json",
    ledger_head_sha256: H("2"),
    requesting_at: "2026-07-21T12:00:11.000Z",
    request_manifest_sha256: sha256(fx.requestManifest),
    request_payload_sha256: sha256(fx.requestPayload),
    requesting_path: "/ledger/requesting.json",
    requesting_file_sha256: H("3"),
    consumption_id: "consumption-1",
    accepted_at: "2026-07-21T12:01:01.000Z",
    terminal_at: "2026-07-21T12:05:00.000Z",
    prior_state: "ACCEPTED",
    prior_state_file_sha256: H("4"),
    accepted_path: "/ledger/accepted.json",
    accepted_file_sha256: H("5"),
    terminal_path: "/ledger/terminal.json",
    terminal_file_sha256: H("6"),
    apply_id: "apply-1",
    feed_id: fx.feedId,
    response_http_receipt_sha256: sha256(fx.responseHttp),
    response_payload_sha256: sha256(fx.responsePayload),
    feed_status_http_receipt_sha256: sha256(feedHttp),
    feed_status_payload_sha256: sha256(feedPayload),
    exact_listing_count: 1,
    marketplace_write_calls: 1,
    error_code: null,
    ...overrides,
  };
}

async function persistAccepted(fx: Fixture) {
  const sink = await createWalmartListingRepairArtifactCustody({
    custody_root: fx.root,
    permit: fx.permit,
  });
  await sink.persist("PREPARED_REQUEST", preparedArtifacts(fx));
  await sink.persist("POST_RESPONSE", {
    "response-http.json": fx.responseHttp,
    "response-payload.bin": fx.responsePayload,
    "accepted-feed-id.txt": Buffer.from(fx.feedId, "utf8"),
  });
  return sink;
}

test("durably loads one exact accepted request/response and inventories immutable custody", async (t) => {
  const fx = await fixture(t);
  const sink = await persistAccepted(fx);
  const feedOne = Buffer.from(JSON.stringify({ feedId: fx.feedId, feedStatus: "RECEIVED" }));
  const feedTwo = Buffer.from(JSON.stringify({ feedId: fx.feedId, feedStatus: "PROCESSED" }));
  const stemOne = feedStem(fx, H("1"));
  const stemTwo = feedStem(fx, H("2"));
  const feedOneHttp = httpReceipt(feedOne, {
    capturedAt: "2026-07-21T12:02:00.000Z",
    correlation: H("1"),
    feedId: fx.feedId,
  });
  const feedTwoHttp = httpReceipt(feedTwo, {
    capturedAt: "2026-07-21T12:03:00.000Z",
    correlation: H("2"),
    feedId: fx.feedId,
  });
  await sink.persist("FEED_STATUS", {
    [`${stemOne}.http.json`]: feedOneHttp,
    [`${stemOne}.payload.bin`]: feedOne,
  });
  await sink.persist("FEED_STATUS", {
    [`${stemTwo}.http.json`]: feedTwoHttp,
    [`${stemTwo}.payload.bin`]: feedTwo,
  });
  const loaded = await sink.loadAccepted({ permit: fx.permit, accepted: accepted(fx) });
  assert.deepEqual(Buffer.from(loaded.request_manifest_bytes), fx.requestManifest);
  assert.deepEqual(Buffer.from(loaded.request_payload_bytes), fx.requestPayload);
  assert.deepEqual(Buffer.from(loaded.response_http_receipt_bytes), fx.responseHttp);
  assert.deepEqual(Buffer.from(loaded.response_payload_bytes), fx.responsePayload);
  const terminal = await sink.loadSucceededTerminal({
    permit: fx.permit,
    terminal: succeededTerminal(fx, feedTwoHttp, feedTwo),
  });
  assert.deepEqual(Buffer.from(terminal.feed_status_http_receipt_bytes), feedTwoHttp);
  assert.deepEqual(Buffer.from(terminal.feed_status_payload_bytes), feedTwo);
  assert.deepEqual(
    Buffer.from(terminal.surgical.target_image_certificate_bytes),
    fx.surgical.targetImageCertificate,
  );
  assert.deepEqual(Buffer.from(terminal.surgical.schema_contract_bytes), fx.surgical.schemaContract);
  assert.deepEqual(Buffer.from(terminal.surgical.get_spec_receipt_bytes), fx.surgical.getSpecReceipt);
  assert.deepEqual(Buffer.from(terminal.surgical.live_item_receipt_bytes), fx.surgical.liveItemReceipt);
  assert.deepEqual(Buffer.from(terminal.surgical.get_spec_request_bytes), fx.surgical.getSpecRequest);
  assert.deepEqual(Buffer.from(terminal.surgical.get_spec_response_bytes), fx.surgical.getSpecResponse);
  assert.deepEqual(Buffer.from(terminal.surgical.live_item_response_bytes), fx.surgical.liveItemResponse);

  const evidence = await sink.readEvidence();
  assert.equal(evidence.schema_version, WALMART_LISTING_REPAIR_ARTIFACT_EVIDENCE_SCHEMA);
  assert.equal(evidence.permit_binding.permit_authorization_sha256, fx.permit.authorization_sha256);
  assert.equal(evidence.commits.length, 4);
  assert.deepEqual(evidence.commits.map((entry) => entry.stage), [
    "PREPARED_REQUEST", "POST_RESPONSE", "FEED_STATUS", "FEED_STATUS",
  ]);
  assert.equal(evidence.objects.every((entry) => !entry.orphan), true);
  assert.equal(evidence.claims.mutable_head_present, false);
  for (const directory of [
    evidence.directories.root,
    evidence.directories.permit,
    evidence.directories.objects,
    evidence.directories.staging,
    ...Object.values(evidence.directories.stages),
  ]) {
    assert.equal((await lstat(directory.path)).mode & 0o777, 0o700);
  }
  for (const entry of [...evidence.objects, ...evidence.commits]) {
    const info = await lstat(entry.file_identity.path);
    assert.equal(info.mode & 0o777, 0o400);
    assert.equal(info.nlink, 1);
  }
  assert.equal((await lstat(evidence.identity_artifact_path)).mode & 0o777, 0o400);
  assert.deepEqual(
    await readWalmartListingRepairArtifactCustodyEvidence({
      custody_root: fx.root,
      permit: fx.permit,
    }),
    evidence,
  );
});

test("exact concurrent replay is idempotent while singleton overwrite and extras fail", async (t) => {
  const fx = await fixture(t);
  const sink = await createWalmartListingRepairArtifactCustody({
    custody_root: fx.root,
    permit: fx.permit,
  });
  const prepared = preparedArtifacts(fx);
  await Promise.all(Array.from({ length: 8 }, () => sink.persist("PREPARED_REQUEST", prepared)));
  assert.equal((await sink.readEvidence()).commits.length, 1);
  await sink.persist("POST_RESPONSE", {
    "response-http.json": fx.responseHttp,
    "response-payload.bin": fx.responsePayload,
    "accepted-feed-id.txt": Buffer.from(fx.feedId),
  });
  const otherPayload = Buffer.from(JSON.stringify({ feedId: "other-feed" }));
  await assert.rejects(() => sink.persist("POST_RESPONSE", {
    "response-http.json": httpReceipt(otherPayload),
    "response-payload.bin": otherPayload,
    "accepted-feed-id.txt": Buffer.from("other-feed"),
  }), /immutable commit already exists|collision/i);
  await assert.rejects(() => sink.persist("FEED_STATUS", {
    [`${feedStem(fx, H("1"))}.http.json`]: httpReceipt(Buffer.from("{}"), {
      correlation: H("1"),
      feedId: fx.feedId,
    }),
    [`${feedStem(fx, H("1"))}.payload.bin`]: Buffer.from("{}"),
    "extra.bin": Buffer.from("x"),
  }), /artifact names|one exact pair/i);
  await writeFile(path.join(fx.root, "unexpected"), "x");
  await assert.rejects(() => sink.readEvidence(), /missing or extra entries/i);
});

test("an OS-visible lock held by another process blocks custody without reclaim", async (t) => {
  const fx = await fixture(t);
  const sink = await persistAccepted(fx);
  const lockPath = path.join(fx.root, ".artifact-custody-operation.lock");
  const script = [
    "const fs = require('node:fs');",
    "const lockPath = process.argv[1];",
    "const fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o400);",
    "fs.writeFileSync(fd, 'foreign-process-lock');",
    "fs.fsyncSync(fd);",
    "fs.closeSync(fd);",
    "process.stdout.write('LOCKED\\n');",
    "process.stdin.once('data', () => { fs.unlinkSync(lockPath); process.exit(0); });",
    "process.stdin.resume();",
  ].join("\n");
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ["-e", script, lockPath],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let exited = false;
  t.after(() => {
    if (!exited) child.kill("SIGKILL");
  });
  const [stdout] = await once(child.stdout, "data") as [Buffer];
  assert.match(stdout.toString("utf8"), /LOCKED/);

  await assert.rejects(
    () => sink.readEvidence(),
    /operation lock already exists.*never auto-reclaim/i,
  );
  assert.equal((await lstat(lockPath)).isFile(), true);

  child.stdin.write("release\n");
  const [code] = await once(child, "exit") as [number | null];
  exited = true;
  assert.equal(code, 0);
  assert.equal((await sink.readEvidence()).permit_binding.permit_id, "permit-one");
});

test("locked qualification reader performs a final exact-inventory rescan", async (t) => {
  const fx = await fixture(t);
  await persistAccepted(fx);
  const injected = path.join(
    fx.root,
    fx.permit.authorization_sha256,
    "objects",
    "unexpected-after-read",
  );
  await assert.rejects(
    () => withWalmartListingRepairLockedArtifactCustody({
      custody_root: fx.root,
      permit: fx.permit,
      operation: async (reader) => {
        await reader.readEvidence();
        await writeFile(injected, "late inventory drift", { mode: 0o400 });
        return "must-not-return";
      },
    }),
    /unexpected object entry|exact inventory changed/i,
  );
  await assert.rejects(() => lstat(
    path.join(fx.root, ".artifact-custody-operation.lock"),
  ));
});

test("feed-status content-addressing survives exact replay and distinct resume calls", async (t) => {
  const fx = await fixture(t);
  const sink = await persistAccepted(fx);
  const first = Buffer.from(JSON.stringify({ feedId: fx.feedId, feedStatus: "RECEIVED" }));
  const firstStem = feedStem(fx, H("1"));
  const firstSet = {
    [`${firstStem}.http.json`]: httpReceipt(first, {
      correlation: H("1"),
      feedId: fx.feedId,
    }),
    [`${firstStem}.payload.bin`]: first,
  };
  await sink.persist("FEED_STATUS", firstSet);
  await sink.persist("FEED_STATUS", firstSet);
  const conflicting = Buffer.from(JSON.stringify({ feedId: fx.feedId, feedStatus: "ERROR" }));
  await assert.rejects(() => sink.persist("FEED_STATUS", {
    [`${firstStem}.http.json`]: httpReceipt(conflicting, {
      correlation: H("1"),
      feedId: fx.feedId,
    }),
    [`${firstStem}.payload.bin`]: conflicting,
  }), /call stem already exists|collision/i);
  const second = Buffer.from(JSON.stringify({ feedId: fx.feedId, feedStatus: "PROCESSED" }));
  const secondStem = feedStem(fx, H("2"));
  await sink.persist("FEED_STATUS", {
    [`${secondStem}.http.json`]: httpReceipt(second, {
      correlation: H("2"),
      capturedAt: "2026-07-21T12:04:00.000Z",
      feedId: fx.feedId,
    }),
    [`${secondStem}.payload.bin`]: second,
  });
  const feedCommits = (await sink.readEvidence()).commits.filter(
    (entry) => entry.stage === "FEED_STATUS",
  );
  assert.equal(feedCommits.length, 2);
  assert.notEqual(feedCommits[0]!.file_sha256, feedCommits[1]!.file_sha256);
});

test("cross-permit/root and accepted hash/feed mismatches fail closed", async (t) => {
  const fx = await fixture(t);
  const sink = await persistAccepted(fx);
  const otherPermit = permitFixture({
    requestManifest: fx.requestManifest,
    requestPayload: fx.requestPayload,
    targetImageCertificate: fx.surgical.targetImageCertificate,
    suffix: "two",
  });
  await assert.rejects(
    () => sink.loadAccepted({ permit: otherPermit, accepted: accepted(fx) }),
    /another permit|binding/i,
  );
  await assert.rejects(
    () => readWalmartListingRepairArtifactCustodyEvidence({
      custody_root: path.join(fx.base, "other-root"),
      permit: fx.permit,
    }),
    /cannot be inspected|missing|custody/i,
  );
  await assert.rejects(
    () => sink.loadAccepted({
      permit: fx.permit,
      accepted: accepted(fx, { response_payload_sha256: H("f") }),
    }),
    /hashes\/feed differ|binding/i,
  );
  await assert.rejects(
    () => sink.loadAccepted({
      permit: fx.permit,
      accepted: accepted(fx, { feed_id: "wrong-feed" }),
    }),
    /hashes\/feed differ|binding/i,
  );
});

test("terminal loader rejects non-success, wrong hash pairs, numeric stems and wrong v2 routes", async (t) => {
  const fx = await fixture(t);
  const sink = await persistAccepted(fx);
  const feedPayload = Buffer.from(JSON.stringify({ feedId: fx.feedId, feedStatus: "PROCESSED" }));
  const correlation = H("3");
  const stem = feedStem(fx, correlation);
  const feedHttp = httpReceipt(feedPayload, { correlation, feedId: fx.feedId });
  await sink.persist("FEED_STATUS", {
    [`${stem}.http.json`]: feedHttp,
    [`${stem}.payload.bin`]: feedPayload,
  });
  await assert.rejects(() => sink.loadSucceededTerminal({
    permit: fx.permit,
    terminal: succeededTerminal(fx, feedHttp, feedPayload, {
      state: "FAILED",
      error_code: "FAILED_FOR_TEST",
    }),
  }), /not one exact SUCCEEDED/i);
  await assert.rejects(() => sink.loadSucceededTerminal({
    permit: fx.permit,
    terminal: succeededTerminal(fx, feedHttp, feedPayload, {
      feed_status_payload_sha256: H("f"),
    }),
  }), /no unique custody match/i);
  await assert.rejects(() => sink.persist("FEED_STATUS", {
    "feed-status-1.http.json": feedHttp,
    "feed-status-1.payload.bin": feedPayload,
  }), /collision-safe SHA stem/i);

  const wrongRouteRaw = JSON.parse(feedHttp.toString("utf8")) as Record<string, unknown>;
  wrongRouteRaw.path = "/v3/feeds/wrong-feed";
  const wrongRoute = Buffer.from(canonicalJson(wrongRouteRaw), "utf8");
  await assert.rejects(() => sink.persist("FEED_STATUS", {
    [`${stem}.http.json`]: wrongRoute,
    [`${stem}.payload.bin`]: feedPayload,
  }), /exact GET route\/feed/i);
});

test("mode tamper, hardlinks, content tamper and deletion are detected", async (t) => {
  await t.test("mode", async (st) => {
    const fx = await fixture(st);
    const sink = await persistAccepted(fx);
    const object = (await sink.readEvidence()).objects[0]!;
    await chmod(object.file_identity.path, 0o600);
    await assert.rejects(() => sink.readEvidence(), /mode-0400|custody/i);
  });
  await t.test("hardlink", async (st) => {
    const fx = await fixture(st);
    const sink = await persistAccepted(fx);
    const object = (await sink.readEvidence()).objects[0]!;
    await link(object.file_identity.path, path.join(fx.base, "alias.bin"));
    await assert.rejects(() => sink.readEvidence(), /nlink-1|custody/i);
  });
  await t.test("tamper", async (st) => {
    const fx = await fixture(st);
    const sink = await persistAccepted(fx);
    const object = (await sink.readEvidence()).objects[0]!;
    await chmod(object.file_identity.path, 0o600);
    await writeFile(object.file_identity.path, "tampered");
    await chmod(object.file_identity.path, 0o400);
    await assert.rejects(() => sink.readEvidence(), /filename hash mismatch|differs from commit/i);
  });
  await t.test("deletion", async (st) => {
    const fx = await fixture(st);
    const sink = await persistAccepted(fx);
    const object = (await sink.readEvidence()).objects[0]!;
    await unlink(object.file_identity.path);
    await assert.rejects(() => sink.readEvidence(), /object custody differs|missing/i);
  });
});

test("symlinked ancestry and symlinked artifact aliases are rejected", async (t) => {
  const fx = await fixture(t);
  const realParent = path.join(fx.base, "real-parent");
  await mkdir(realParent, { mode: 0o700 });
  const linkedParent = path.join(fx.base, "linked-parent");
  await symlink(realParent, linkedParent);
  await assert.rejects(
    () => createWalmartListingRepairArtifactCustody({
      custody_root: path.join(linkedParent, "custody"),
      permit: fx.permit,
    }),
    /symlink|real directory|ancestry/i,
  );

  const sink = await persistAccepted(fx);
  const object = (await sink.readEvidence()).objects[0]!;
  const saved = await readFile(object.file_identity.path);
  await unlink(object.file_identity.path);
  const outside = path.join(fx.base, "outside.bin");
  await writeFile(outside, saved, { mode: 0o400 });
  await symlink(outside, object.file_identity.path);
  await assert.rejects(() => sink.readEvidence(), /mode-0400|no-follow|custody/i);
});
