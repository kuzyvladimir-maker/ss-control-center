import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  PHASE1_SCOPE_DISPOSITION_VERSION,
  buildPhase1ScopeManifest,
  parsePhase1DelimitedText,
  renderPhase1ScopeManifestJson,
  sha256Hex,
  type Phase1Channel,
  type Phase1ScopeDispositionEntry,
} from "../phase1-scope-manifest";
import { makeTestConnectedStoreCensus } from "./phase1-connected-store-census-fixture";
import {
  PRODUCT_TRUTH_OPERATIONAL_APPROVAL_VERSION,
  expectedProductTruthExecutionConfirmation,
  renderProductTruthOperationalJson,
  type ProductTruthOperationalApproval,
  type ProductTruthOperationalPlan,
} from "../product-truth-operational-run-contract";
import {
  PRODUCT_TRUTH_OPERATIONAL_PLAN_REQUEST_VERSION,
  type ProductTruthOperationalPlanRequest,
} from "../product-truth-operational-plan-request";
import {
  ProductTruthRunnerCliError,
  buildProductTruthTargetedPlanHandoff,
  createProductTruthReportArtifactWriter,
  loadProductTruthExecutionArtifacts,
  parseProductTruthRunnerArguments,
  productTruthTargetedDoctorExitCode,
  runProductTruthRunnerCli,
} from "../../../../scripts/product-truth-runner";
import { PRODUCT_TRUTH_MATCHER_REPLAY_CORPUS_VERSION } from "../product-truth-matcher-replay";

const CREATED_AT = "2026-07-19T12:00:00.000Z";
const NOW = "2026-07-19T12:05:00.000Z";
const EXPIRES_AT = "2026-07-19T13:00:00.000Z";
const execFileAsync = promisify(execFile);

const amazonReport = [
  "item-name\tseller-sku\tasin1\tstatus\tfulfillment-channel",
  "Acme One\tAMZ-1\tB000000001\tActive\tDEFAULT",
  "Acme Two\tAMZ-2\tB000000002\tActive\tDEFAULT",
  "Acme Three\tAMZ-3\tB000000003\tActive\tDEFAULT",
].join("\n");

const walmartReport = [
  "SKU,Item ID,Product Name,Published Status,Lifecycle Status",
  "WM-1,10001,Acme Four,Published,Active",
  "WM-2,10002,Acme Five,Published,Active",
].join("\n");

function disposition(
  channel: Phase1Channel,
  scopeKey: string,
  storeIndex: number,
  content: string,
): Phase1ScopeDispositionEntry {
  return {
    channel,
    scopeKey,
    storeIndex,
    accountId: `${channel}-account-${storeIndex}`,
    storeId: `${channel}-store-${storeIndex}`,
    marketplaceId: channel === "amazon" ? "ATVPDKIKX0DER" : null,
    disposition: "IN_SCOPE",
    decision: {
      authority: "OWNER",
      decisionId: `${channel}-owner-decision-${storeIndex}`,
      decidedBy: "Vladimir",
      decidedAt: "2026-07-19T11:00:00.000Z",
      reason: "Focused CLI fixture",
    },
    report: {
      reportType: channel === "amazon" ? "GET_MERCHANT_LISTINGS_ALL_DATA" : "ITEM_CATALOG",
      reportId: `${channel}-report-${storeIndex}`,
      capturedAt: "2026-07-19T11:30:00.000Z",
      expectedRowCount: parsePhase1DelimitedText(content).rows.length,
      expectedContentSha256: sha256Hex(content),
    },
  };
}

function manifest() {
  const result = buildPhase1ScopeManifest({
    asOf: CREATED_AT,
    connectedStoreCensus: makeTestConnectedStoreCensus({
      asOf: CREATED_AT,
      identityStyle: "index",
    }),
    disposition: {
      schemaVersion: PHASE1_SCOPE_DISPOSITION_VERSION,
      scopes: [
        disposition("amazon", "store1", 1, amazonReport),
        disposition("walmart", "store1", 1, walmartReport),
      ],
    },
    reports: [
      { channel: "amazon", scopeKey: "store1", sourceName: "amazon.tsv", content: amazonReport },
      { channel: "walmart", scopeKey: "store1", sourceName: "walmart.csv", content: walmartReport },
    ],
  });
  assert.equal(result.authoritative, true);
  assert.equal(result.listings.length, 5);
  return result;
}

function request(listingKeys: string[]): ProductTruthOperationalPlanRequest {
  return {
    schemaVersion: PRODUCT_TRUTH_OPERATIONAL_PLAN_REQUEST_VERSION,
    runId: "product-truth-cli-canary-20260719-a",
    mode: "CANARY",
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    listingKeys,
    sourcePolicy: {
      procurementZip: "33765",
      retailers: ["walmart", "target", "publix"],
      allowClubs: false,
      allowBjs: false,
      listingConcurrency: 1,
      componentConcurrency: 1,
      maxAttemptsPerListing: 1,
    },
    providerCeilings: [
      {
        provider: "oxylabs",
        operations: ["query"],
        maxCalls: 5,
        maxUnits: 5,
        reserveFloor: null,
      },
      {
        provider: "unwrangle",
        operations: ["detail", "search"],
        maxCalls: 10,
        maxUnits: 20,
        reserveFloor: 1_000,
      },
    ],
    verificationPolicy: {
      maxPriceAgeMs: 24 * 60 * 60 * 1_000,
      minGalleryImages: 5,
    },
    maxWallClockMs: 30 * 60 * 1_000,
  };
}

function approval(plan: ProductTruthOperationalPlan, planSha256: string): ProductTruthOperationalApproval {
  return {
    schemaVersion: PRODUCT_TRUTH_OPERATIONAL_APPROVAL_VERSION,
    approvedBy: "owner",
    runId: plan.runId,
    approvalId: "owner-approval-cli-20260719-a",
    action: "EXECUTE_CANARY",
    planSha256,
    targetFingerprint: plan.targetFingerprint,
    issuedAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    meteredPermit: {
      version: 1,
      runId: plan.runId,
      approvalId: "owner-approval-cli-20260719-a",
      approvedBy: "owner",
      issuedAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      providers: {
        oxylabs: { operations: ["query"], maxCalls: 5, maxUnits: 5 },
        unwrangle: { operations: ["detail", "search"], maxCalls: 10, maxUnits: 20 },
      },
    },
    balanceEvidence: [
      {
        provider: "unwrangle",
        observedAt: NOW,
        balanceUnits: 2_000,
        reserveFloor: 1_000,
        evidenceSha256: "b".repeat(64),
      },
    ],
  };
}

async function fixtureDirectory(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "product-truth-cli-")));
}

function matcherReplayCorpus() {
  return {
    schemaVersion: PRODUCT_TRUTH_MATCHER_REPLAY_CORPUS_VERSION,
    corpusId: "runner-matcher-replay-2",
    capturedAt: "2026-07-19T11:00:00.000Z",
    source: {
      kind: "VARIANT_MISMATCH_QUARANTINE",
      artifactSha256: "d".repeat(64),
      declaredCaseCount: 2,
    },
    cases: [
      {
        caseId: "case-001",
        target: {
          brand: "Coca-Cola", productLine: "Cola", flavor: "Original",
          form: "Soda", size: "12 fl oz",
        },
        candidate: {
          brand: "Coca-Cola", productLine: "Cola", flavor: "Zero Sugar",
          form: "Soda", size: "12 fl oz",
        },
        expectedVerdict: "REJECT",
      },
      {
        caseId: "case-002",
        target: {
          brand: "Cheez-It", productLine: "Crackers", flavor: "Original",
          form: "Crackers", size: "12 oz",
        },
        candidate: {
          brand: "Cheez-It", productLine: "Crackers", flavor: "Extra Cheesy",
          form: "Crackers", size: "12 oz",
        },
        expectedVerdict: "REJECT",
      },
    ],
  };
}

test("CLI returns EX_USAGE 64 for missing and unknown commands", async () => {
  for (const argv of [[], ["everything"]] as const) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runProductTruthRunnerCli(argv, {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });
    assert.equal(exitCode, 64);
    assert.equal(stdout.length, 0);
    assert.match(stderr.join(""), /CLI_COMMAND_(?:REQUIRED|UNKNOWN)/);
  }
});

test("strict parser has no implicit all/default execution path", () => {
  assert.throws(
    () => parseProductTruthRunnerArguments(["execute", "--url", "file:./test.sqlite"]),
    (error: unknown) => (
      error instanceof ProductTruthRunnerCliError
      && error.exitCode === 64
      && error.code === "CLI_ARGUMENT_REQUIRED"
    ),
  );
  assert.throws(
    () => parseProductTruthRunnerArguments(["plan", "--all"]),
    (error: unknown) => (
      error instanceof ProductTruthRunnerCliError
      && error.exitCode === 64
      && error.code === "CLI_ARGUMENT_UNKNOWN"
    ),
  );
  assert.throws(
    () => parseProductTruthRunnerArguments([
      "status", "--url", "file:./test.sqlite", "--run-id", "run-a", "--run-id", "run-b",
    ]),
    (error: unknown) => (
      error instanceof ProductTruthRunnerCliError
      && error.exitCode === 64
      && error.code === "CLI_ARGUMENT_DUPLICATE"
    ),
  );
});

test("targeted doctor identity flag is mode-bound and emitted handoff argv is lossless", async () => {
  assert.throws(
    () => parseProductTruthRunnerArguments([
      "doctor", "--url", "file:/tmp/test.sqlite", "--canonical-identity", "/tmp/id.json",
    ]),
    (error: unknown) => error instanceof ProductTruthRunnerCliError
      && error.code === "CLI_TARGETED_DOCTOR_ARGUMENTS_INCOMPLETE",
  );
  const parsed = parseProductTruthRunnerArguments([
    "doctor",
    "--donor-product-id", "donor-1",
    "--query", "Acme exact item",
    "--run-id", "run-1",
    "--expires-at", EXPIRES_AT,
    "--unwrangle-reserve-floor", "100",
    "--canonical-identity", "/tmp/owner identity.json",
    "--url", "file:/tmp/test.sqlite",
    "--out", "/tmp/targeted output",
  ]);
  assert.equal(parsed.command, "doctor");
  if (parsed.command !== "doctor") assert.fail("doctor parser narrowed incorrectly");
  assert.equal(parsed.canonicalIdentityPath, "/tmp/owner identity.json");
  assert.equal(productTruthTargetedDoctorExitCode({ ownerActionRequired: true }), 2);
  assert.equal(productTruthTargetedDoctorExitCode({ ok: true }), 0);

  const root = await fixtureDirectory();
  const bin = join(root, "fake bin");
  await mkdir(bin);
  const capture = join(root, "captured argv.json");
  const injected = join(root, "INJECTION_MUST_NOT_EXIST");
  const npmStub = join(bin, "npm");
  await writeFile(
    npmStub,
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.ARGV_CAPTURE, JSON.stringify(["npm", ...process.argv.slice(2)]));\n`,
    "utf8",
  );
  await chmod(npmStub, 0o755);
  const handoff = buildProductTruthTargetedPlanHandoff({
    requestPath: join(root, "owner's request; $(touch ignored).json"),
    databaseUrl: `file:${join(root, `db space;$(touch ${injected})'s.sqlite`)}`,
    allowRemote: false,
    outputDirectory: join(root, "planned output; $(touch ignored)"),
  });
  await execFileAsync("/bin/sh", ["-c", handoff.next_command], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      ARGV_CAPTURE: capture,
    },
  });
  assert.deepEqual(
    JSON.parse(await readFile(capture, "utf8")),
    handoff.next_argv,
  );
  await assert.rejects(readFile(injected), /ENOENT/);
});

test("matcher-replay is exact-corpus offline-only and writes immutable certification artifacts", async () => {
  const root = await fixtureDirectory();
  const corpusPath = join(root, "matcher-corpus.json");
  const output = join(root, "matcher-replay-report");
  await writeFile(
    corpusPath,
    renderProductTruthOperationalJson(matcherReplayCorpus()),
    "utf8",
  );
  const parsed = parseProductTruthRunnerArguments([
    "matcher-replay",
    "--corpus", corpusPath,
    "--required-case-count", "2",
    "--out", output,
  ]);
  assert.equal(parsed.command, "matcher-replay");
  if (parsed.command !== "matcher-replay") assert.fail("matcher-replay parser narrowed incorrectly");
  assert.equal(parsed.requiredCaseCount, 2);
  assert.equal("databaseUrl" in parsed, false);

  assert.throws(
    () => parseProductTruthRunnerArguments([
      "matcher-replay",
      "--corpus", corpusPath,
      "--required-case-count", "2",
      "--url", "file:forbidden.sqlite",
      "--out", output,
    ]),
    (error: unknown) => error instanceof ProductTruthRunnerCliError
      && error.code === "CLI_ARGUMENT_UNKNOWN"
      && error.exitCode === 64,
  );

  const stdout: string[] = [];
  assert.equal(await runProductTruthRunnerCli([
    "matcher-replay",
    "--corpus", corpusPath,
    "--required-case-count", "2",
    "--out", output,
  ], {
    cwd: root,
    env: { NODE_ENV: "test" },
    stdout: (text) => stdout.push(text),
    stderr: assert.fail,
  }), 0);
  const result = JSON.parse(stdout.join("")) as Record<string, unknown>;
  assert.equal(result.command, "matcher-replay");
  assert.equal(result.offline, true);
  assert.equal(result.databaseConnections, 0);
  assert.equal(result.providerCalls, 0);
  assert.equal(result.certification, "PASS");
  assert.deepEqual((await readdir(output)).sort(), [
    "artifact-index.json",
    "artifact-index.sha256",
    "report.json",
    "report.sha256",
  ]);
  const reportBytes = await readFile(join(output, "report.json"), "utf8");
  assert.equal(
    (await readFile(join(output, "report.sha256"), "utf8")).trim(),
    createHash("sha256").update(reportBytes).digest("hex"),
  );

  const duplicateStderr: string[] = [];
  assert.equal(await runProductTruthRunnerCli([
    "matcher-replay",
    "--corpus", corpusPath,
    "--required-case-count", "2",
    "--out", output,
  ], {
    cwd: root,
    stdout: assert.fail,
    stderr: (text) => duplicateStderr.push(text),
  }), 1);
  assert.match(duplicateStderr.join(""), /OUTPUT_DIRECTORY_EXISTS/);
});

test("readiness command requires one exact manifest, read policy, target, and output", () => {
  const parsed = parseProductTruthRunnerArguments([
    "readiness",
    "--manifest", "/tmp/manifest.json",
    "--as-of", NOW,
    "--max-price-age-ms", "86400000",
    "--url", "file:/tmp/product-truth.sqlite",
    "--out", "/tmp/readiness-new",
  ]);
  assert.equal(parsed.command, "readiness");
  if (parsed.command !== "readiness") assert.fail("readiness parser narrowed incorrectly");
  assert.equal(parsed.asOf, NOW);
  assert.equal(parsed.maxPriceAgeMs, 86_400_000);
  assert.equal(parsed.allowRemote, false);

  assert.throws(
    () => parseProductTruthRunnerArguments([
      "readiness",
      "--manifest", "/tmp/manifest.json",
      "--as-of", NOW,
      "--max-price-age-ms", "0",
      "--url", "file:/tmp/product-truth.sqlite",
      "--out", "/tmp/readiness-new",
    ]),
    (error: unknown) => error instanceof ProductTruthRunnerCliError
      && error.code === "CLI_ARGUMENT_VALUE_INVALID"
      && error.exitCode === 64,
  );
  assert.throws(
    () => parseProductTruthRunnerArguments([
      "readiness",
      "--manifest", "/tmp/manifest.json",
      "--as-of", NOW,
      "--max-price-age-ms", "86400000",
      "--url", "file:/tmp/product-truth.sqlite",
    ]),
    (error: unknown) => error instanceof ProductTruthRunnerCliError
      && error.code === "CLI_ARGUMENT_REQUIRED"
      && error.exitCode === 64,
  );
});

test("backfill-plan requires the complete sealed migration bridge", () => {
  const argumentsWithBridge = [
    "backfill-plan",
    "--manifest", "/tmp/manifest.json",
    "--migration-certification", "/tmp/migration-certification.json",
    "--migration-certification-sha", "/tmp/migration-certification.sha256",
    "--migration-report", "/tmp/report.json",
    "--migration-report-sha", "/tmp/report.sha256",
    "--plan-id", "owner-backfill-1",
    "--expires-at", EXPIRES_AT,
    "--url", "file:/tmp/product-truth.sqlite",
    "--out", "/tmp/backfill-plan",
  ] as const;
  const parsed = parseProductTruthRunnerArguments(argumentsWithBridge);
  assert.equal(parsed.command, "backfill-plan");
  if (parsed.command !== "backfill-plan") assert.fail("backfill-plan parser narrowed incorrectly");
  assert.equal(parsed.migrationCertificationShaPath, "/tmp/migration-certification.sha256");
  assert.equal(parsed.migrationReportPath, "/tmp/report.json");
  assert.equal(parsed.migrationReportShaPath, "/tmp/report.sha256");

  const missingReportSha = [...argumentsWithBridge];
  missingReportSha.splice(9, 2);
  assert.throws(
    () => parseProductTruthRunnerArguments(missingReportSha),
    (error: unknown) => error instanceof ProductTruthRunnerCliError
      && error.code === "CLI_ARGUMENT_REQUIRED"
      && error.exitCode === 64,
  );
});

test("remote execution requires an explicitly named auth env and never prints its value", async () => {
  const root = await fixtureDirectory();
  const baseArguments = [
    "execute",
    "--url", "libsql://catalog.example.invalid",
    "--allow-remote",
    "--plan", join(root, "missing-plan.json"),
    "--plan-sha", join(root, "missing-plan.sha256"),
    "--manifest", join(root, "missing-manifest.json"),
    "--approval", join(root, "missing-approval.json"),
    "--confirm", "EXACT_BUT_UNBOUND_CONFIRMATION",
    "--out", join(root, "execution-artifacts"),
  ] as const;
  const missingEnvStderr: string[] = [];
  assert.equal(await runProductTruthRunnerCli(baseArguments, {
    cwd: root,
    env: { NODE_ENV: "test" },
    stdout: () => undefined,
    stderr: (text) => missingEnvStderr.push(text),
  }), 64);
  assert.match(missingEnvStderr.join(""), /REMOTE_DATABASE_AUTH_ENV_REQUIRED/);

  const secret = "secret-value-that-must-not-appear";
  const artifactStderr: string[] = [];
  assert.equal(await runProductTruthRunnerCli([
    ...baseArguments,
    "--auth-token-env", "PRODUCT_TRUTH_TEST_AUTH",
  ], {
    cwd: root,
    env: { NODE_ENV: "test", PRODUCT_TRUTH_TEST_AUTH: secret },
    stdout: () => undefined,
    stderr: (text) => artifactStderr.push(text),
  }), 1);
  assert.match(artifactStderr.join(""), /ARTIFACT_FILE_MISSING/);
  assert.doesNotMatch(artifactStderr.join(""), new RegExp(secret));
});

test("plan writes sealed immutable artifacts offline and remote defaults to deny", async () => {
  const root = await fixtureDirectory();
  const scope = manifest();
  const requestPath = join(root, "request.json");
  const manifestPath = join(root, "manifest.json");
  await writeFile(requestPath, renderProductTruthOperationalJson(request(
    scope.listings.map((listing) => listing.listingKey),
  )), "utf8");
  await writeFile(manifestPath, renderPhase1ScopeManifestJson(scope), "utf8");

  const deniedStderr: string[] = [];
  const deniedCode = await runProductTruthRunnerCli([
    "plan",
    "--request", requestPath,
    "--manifest", manifestPath,
    "--url", "libsql://catalog.example.invalid",
    "--out", join(root, "remote-plan"),
  ], {
    cwd: root,
    stdout: () => undefined,
    stderr: (text) => deniedStderr.push(text),
  });
  assert.equal(deniedCode, 64);
  assert.match(deniedStderr.join(""), /REMOTE_DATABASE_REQUIRES_EXPLICIT_FLAG/);

  const stdout: string[] = [];
  const output = join(root, "sealed-plan");
  const exitCode = await runProductTruthRunnerCli([
    "plan",
    "--request", requestPath,
    "--manifest", manifestPath,
    "--url", "file:./never-opened.sqlite",
    "--out", output,
  ], {
    cwd: root,
    stdout: (text) => stdout.push(text),
    stderr: assert.fail,
  });
  assert.equal(exitCode, 0);
  const result = JSON.parse(stdout.join("")) as Record<string, unknown>;
  assert.equal(result.offline, true);
  assert.equal(result.providerCalls, 0);
  assert.equal(result.databaseConnections, 0);
  assert.match(await readFile(join(output, "plan.sha256"), "utf8"), /^[a-f0-9]{64}\n$/);
  assert.equal(
    (JSON.parse(await readFile(join(output, "approval-instructions.json"), "utf8")) as {
      requiredAction: string;
    }).requiredAction,
    "EXECUTE_CANARY",
  );

  const secondCode = await runProductTruthRunnerCli([
    "plan",
    "--request", requestPath,
    "--manifest", manifestPath,
    "--url", "file:./never-opened.sqlite",
    "--out", output,
  ], {
    cwd: root,
    stdout: () => undefined,
    stderr: () => undefined,
  });
  assert.equal(secondCode, 1, "existing artifact directory must never be overwritten");
});

test("execution preflight binds canonical plan, SHA, manifest, approval, confirmation, and DB", async () => {
  const root = await fixtureDirectory();
  const scope = manifest();
  const requestPath = join(root, "request.json");
  const manifestPath = join(root, "manifest.json");
  const output = join(root, "sealed-plan");
  await writeFile(
    requestPath,
    renderProductTruthOperationalJson(request(scope.listings.map((listing) => listing.listingKey))),
    "utf8",
  );
  await writeFile(manifestPath, renderPhase1ScopeManifestJson(scope), "utf8");
  assert.equal(await runProductTruthRunnerCli([
    "plan",
    "--request", requestPath,
    "--manifest", manifestPath,
    "--url", "file:./bound.sqlite",
    "--out", output,
  ], {
    cwd: root,
    stdout: () => undefined,
    stderr: assert.fail,
  }), 0);

  const planPath = join(output, "plan.json");
  const planShaPath = join(output, "plan.sha256");
  const plan = JSON.parse(await readFile(planPath, "utf8")) as ProductTruthOperationalPlan;
  const planSha256 = (await readFile(planShaPath, "utf8")).trim();
  const approvalPath = join(root, "approval.json");
  const approved = approval(plan, planSha256);
  await writeFile(approvalPath, renderProductTruthOperationalJson(approved), "utf8");
  const confirmation = expectedProductTruthExecutionConfirmation(planSha256, approved.approvalId);

  const loaded = await loadProductTruthExecutionArtifacts({
    planPath,
    planShaPath,
    manifestPath,
    approvalPath,
    executionConfirmation: confirmation,
    targetFingerprint: plan.targetFingerprint,
    now: NOW,
    cwd: root,
  });
  assert.equal(loaded.plan.runId, plan.runId);
  assert.equal(loaded.validatedApproval.approval.approvalId, approved.approvalId);

  await assert.rejects(
    loadProductTruthExecutionArtifacts({
      planPath,
      planShaPath,
      manifestPath,
      approvalPath,
      executionConfirmation: confirmation,
      targetFingerprint: "f".repeat(64),
      now: NOW,
      cwd: root,
    }),
    /DATABASE_TARGET_FINGERPRINT_MISMATCH/,
  );

  const tamperedShaPath = join(root, "tampered.sha256");
  await writeFile(tamperedShaPath, `${"a".repeat(64)}\n`, "utf8");
  await assert.rejects(
    loadProductTruthExecutionArtifacts({
      planPath,
      planShaPath: tamperedShaPath,
      manifestPath,
      approvalPath,
      executionConfirmation: confirmation,
      targetFingerprint: plan.targetFingerprint,
      now: NOW,
      cwd: root,
    }),
    /PLAN_HASH_MISMATCH/,
  );

  const extraApprovalPath = join(root, "approval-extra.json");
  await writeFile(
    extraApprovalPath,
    renderProductTruthOperationalJson({ ...approved, unauthorizedNote: "ignored-no-more" }),
    "utf8",
  );
  await assert.rejects(
    loadProductTruthExecutionArtifacts({
      planPath,
      planShaPath,
      manifestPath,
      approvalPath: extraApprovalPath,
      executionConfirmation: confirmation,
      targetFingerprint: plan.targetFingerprint,
      now: NOW,
      cwd: root,
    }),
    /ARTIFACT_SHAPE_INVALID/,
  );
});

test("final report writer is canonical, hash-bound, exclusive, and single-use", async () => {
  const root = await fixtureDirectory();
  const scope = manifest();
  const requestPath = join(root, "request.json");
  const manifestPath = join(root, "manifest.json");
  const planOutput = join(root, "plan");
  await writeFile(
    requestPath,
    renderProductTruthOperationalJson(request(scope.listings.map((listing) => listing.listingKey))),
    "utf8",
  );
  await writeFile(manifestPath, renderPhase1ScopeManifestJson(scope), "utf8");
  assert.equal(await runProductTruthRunnerCli([
    "plan", "--request", requestPath, "--manifest", manifestPath,
    "--url", "file:./report.sqlite", "--out", planOutput,
  ], {
    cwd: root,
    stdout: () => undefined,
    stderr: assert.fail,
  }), 0);
  const plan = JSON.parse(await readFile(join(planOutput, "plan.json"), "utf8")) as ProductTruthOperationalPlan;
  const planSha256 = (await readFile(join(planOutput, "plan.sha256"), "utf8")).trim();
  const reportOutput = join(root, "final-report");
  const writer = createProductTruthReportArtifactWriter({
    outputDirectory: reportOutput,
    plan,
    planSha256,
  });
  const hashes = await writer({ schemaVersion: "fixture-report/1", runId: plan.runId, status: "completed" });
  assert.equal((await readFile(join(reportOutput, "report.sha256"), "utf8")).trim(), hashes.reportSha256);
  assert.equal(
    (await readFile(join(reportOutput, "artifact-index.sha256"), "utf8")).trim(),
    hashes.artifactIndexSha256,
  );
  await assert.rejects(
    writer({ schemaVersion: "fixture-report/1", runId: plan.runId, status: "completed" }),
    /ARTIFACT_WRITER_REUSED/,
  );
});
