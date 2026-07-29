import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import type { Client, Row } from "@libsql/client";

import {
  ProductTruthStandingWaveError,
  parseProductTruthStandingWavePlan,
  productTruthStandingWavePlanSha256,
  rankProductTruthStandingWaveCandidates,
  sealProductTruthStandingWavePlan,
  validateSealedProductTruthStandingWavePlan,
  type ProductTruthStandingWaveCandidate,
} from "../product-truth-standing-wave";
import {
  assertProductTruthStandingWaveExecuteArgv,
  runProductTruthStandingWave,
  type ProductTruthStandingWaveCommandExecutor,
  type ProductTruthStandingWaveRunOptions,
} from "../../../../scripts/product-truth-standing-wave";
import {
  resolveProductTruthDatabaseTarget,
} from "../product-truth-database-target";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const CREATED_AT = "2026-07-29T18:00:00.000Z";
const EXPIRES_AT = "2026-07-30T18:00:00.000Z";

function candidate(
  donorProductId: string,
  listingKeys: readonly string[],
  sales180: number,
): ProductTruthStandingWaveCandidate {
  return {
    donorProductId,
    canonicalVariantId: `cpv1:${donorProductId}`,
    variantDecisionId: `dpvd:${donorProductId}`,
    donorOfferId: `do:walmart:${donorProductId}`,
    retailerProductId: `item-${donorProductId}`,
    query: `Exact title for ${donorProductId}`,
    representative: {
      listingKey: listingKeys[0],
      sku: `sku-${donorProductId}`,
      componentIndex: 0,
    },
    linkedListingKeys: [...listingKeys].sort((left, right) =>
      left.localeCompare(right, "en-US"),
    ),
    currentCostOutcomes: {
      missing: listingKeys.length,
      unsourceable: 0,
    },
    impact: {
      convertibleListings: listingKeys.length,
      sales180,
      units180: sales180 / 2,
    },
    priorAttemptCount: 0,
  };
}

function seal(candidates: readonly ProductTruthStandingWaveCandidate[]) {
  return sealProductTruthStandingWavePlan({
    waveId: "ptsw-20260729t180000z",
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    databaseTargetFingerprint: SHA_A,
    manifestSha256: SHA_B,
    standingProviderPolicySha256: SHA_C,
    standingNoPaidPolicySha256: "d".repeat(64),
    maxTargets: 5,
    candidates,
  });
}

function isWaveError(code: string) {
  return (error: unknown) =>
    error instanceof ProductTruthStandingWaveError && error.code === code;
}

test("sealed wave deterministically ranks impact and binds exact bytes", () => {
  const sealed = seal([
    candidate("donor-low", ["walmart:1:sku-low"], 1_000),
    candidate(
      "donor-two",
      ["walmart:1:sku-two-a", "walmart:1:sku-two-b"],
      10,
    ),
    candidate("donor-high", ["walmart:1:sku-high"], 2_000),
  ]);
  assert.deepEqual(
    sealed.plan.targets.map((target) => target.donorProductId),
    ["donor-two", "donor-high", "donor-low"],
  );
  assert.equal(sealed.plan.workflow.targetConcurrency, 1);
  assert.equal(sealed.plan.workflow.maxAttemptsPerTarget, 1);
  assert.equal(sealed.plan.workflow.maximumWaveProviderUnits, 18);
  assert.equal(sealed.plan.authority.ownerActionRequired, false);
  assert.equal(
    sealed.planSha256,
    productTruthStandingWavePlanSha256(sealed.plan),
  );
  assert.deepEqual(validateSealedProductTruthStandingWavePlan(sealed), sealed);
});

test("wave parser rejects safety drift, reordered targets, and tampered seals", () => {
  const sealed = seal([
    candidate("donor-a", ["walmart:1:sku-a"], 100),
    candidate("donor-b", ["walmart:1:sku-b"], 10),
  ]);
  assert.throws(
    () =>
      parseProductTruthStandingWavePlan({
        ...sealed.plan,
        workflow: {
          ...sealed.plan.workflow,
          maxAttemptsPerTarget: 2,
        },
      }),
    isWaveError("STANDING_WAVE_WORKFLOW_INVALID"),
  );
  assert.throws(
    () =>
      parseProductTruthStandingWavePlan({
        ...sealed.plan,
        targets: [...sealed.plan.targets].reverse(),
      }),
    isWaveError("STANDING_WAVE_TARGETS_INVALID"),
  );
  assert.throws(
    () =>
      validateSealedProductTruthStandingWavePlan({
        ...sealed,
        planSha256: "e".repeat(64),
      }),
    isWaveError("STANDING_WAVE_SEAL_INVALID"),
  );
});

function row(input: {
  donor: string;
  listing: string;
  sales: number;
  units?: number;
  outcome?: string;
  offer?: string;
  variant?: string;
  componentIndex?: number;
}): Row {
  return {
    listingKey: input.listing,
    sku: input.listing.split(":").at(-1) ?? input.listing,
    componentIndex: input.componentIndex ?? 0,
    donorProductId: input.donor,
    targetCanonicalVariantId: input.variant ?? `cpv1:${input.donor}`,
    variantDecisionId: `dpvd:${input.donor}`,
    donorTitle: `Exact ${input.donor} 10 oz`,
    donorOfferId: input.offer ?? `do:walmart:${input.donor}`,
    retailerProductId: `item-${input.donor}`,
    sales180: input.sales,
    units180: input.units ?? input.sales / 2,
    currentCostOutcome: input.outcome ?? "MISSING",
  };
}

function fakeClient(input: {
  history?: readonly Row[];
  rows: readonly Row[];
}): Client {
  let call = 0;
  return {
    execute: async () => ({
      columns: [],
      columnTypes: [],
      rows: call++ === 0 ? [...(input.history ?? [])] : [...input.rows],
      rowsAffected: 0,
      lastInsertRowid: undefined,
      toJSON: () => ({}),
    }),
  } as unknown as Client;
}

test("read-only ranking excludes positive costs, prior attempts, and ambiguous donor graphs", async () => {
  const attemptedPlan = JSON.stringify({
    targets: [{ donorProductId: "donor-attempted" }],
  });
  const candidates = await rankProductTruthStandingWaveCandidates({
    db: fakeClient({
      history: [{ planJson: attemptedPlan }],
      rows: [
        row({
          donor: "donor-three",
          listing: "walmart:1:sku-3a",
          sales: 100,
          outcome: "UNSOURCEABLE",
        }),
        row({
          donor: "donor-three",
          listing: "walmart:1:sku-3b",
          sales: 50,
        }),
        row({
          donor: "donor-three",
          listing: "walmart:1:sku-3c",
          sales: 25,
        }),
        row({
          donor: "donor-sales",
          listing: "walmart:1:sku-sales",
          sales: 2_000,
        }),
        row({
          donor: "donor-attempted",
          listing: "walmart:1:sku-old",
          sales: 9_000,
        }),
        row({
          donor: "donor-fact",
          listing: "walmart:1:sku-fact",
          sales: 8_000,
          outcome: "FACT",
        }),
        row({
          donor: "donor-multi-offer",
          listing: "walmart:1:sku-offer",
          sales: 7_000,
          offer: "do:walmart:offer-a",
        }),
        row({
          donor: "donor-multi-offer",
          listing: "walmart:1:sku-offer",
          sales: 7_000,
          offer: "do:walmart:offer-b",
        }),
        row({
          donor: "donor-conflict",
          listing: "walmart:1:sku-conflict-a",
          sales: 6_000,
          variant: "cpv1:variant-a",
        }),
        row({
          donor: "donor-conflict",
          listing: "walmart:1:sku-conflict-b",
          sales: 6_000,
          variant: "cpv1:variant-b",
        }),
      ],
    }),
    manifestSha256: SHA_A,
    limit: 5,
  });
  assert.deepEqual(
    candidates.map((entry) => entry.donorProductId),
    ["donor-three", "donor-sales"],
  );
  assert.deepEqual(candidates[0].currentCostOutcomes, {
    missing: 2,
    unsourceable: 1,
  });
  assert.equal(candidates[0].impact.convertibleListings, 3);
  assert.equal(candidates[0].impact.sales180, 175);
  assert.equal(candidates[1].representative.listingKey, "walmart:1:sku-sales");
});

test("same listing with two current components is not eligible for a one-donor target", async () => {
  const candidates = await rankProductTruthStandingWaveCandidates({
    db: fakeClient({
      rows: [
        row({
          donor: "donor-bundle",
          listing: "walmart:1:sku-bundle",
          sales: 500,
          componentIndex: 0,
        }),
        row({
          donor: "donor-bundle",
          listing: "walmart:1:sku-bundle",
          sales: 500,
          componentIndex: 1,
        }),
      ],
    }),
    manifestSha256: SHA_A,
  });
  assert.equal(candidates.length, 0);
});

test("standing authorization can launch only the exact allowlisted execute argv", () => {
  const cwd = "/absolute/ss-control-center";
  const planPath = "/absolute/work/plan/plan.json";
  const planShaPath = "/absolute/work/plan/plan.sha256";
  const approvalPath = "/absolute/work/authorization/approval.json";
  const executionPath = "/absolute/work/execution";
  const confirmation =
    "EXECUTE_PRODUCT_TRUTH_PLAN_V1:abc:pt-standing:test";
  const argv = [
    "npm",
    "run",
    "product-truth",
    "--",
    "execute",
    "--plan",
    planPath,
    "--plan-sha",
    planShaPath,
    "--approval",
    approvalPath,
    "--confirm",
    confirmation,
    "--url",
    "libsql://product-truth.example",
    "--allow-remote",
    "--auth-token-env",
    "TURSO_AUTH_TOKEN",
    "--out",
    executionPath,
  ];
  assert.deepEqual(
    assertProductTruthStandingWaveExecuteArgv({
      argv,
      cwd,
      planPath,
      planShaPath,
      approvalPath,
      executionPath,
      url: "libsql://product-truth.example",
      authTokenEnv: "TURSO_AUTH_TOKEN",
    }),
    argv,
  );
  assert.throws(
    () =>
      assertProductTruthStandingWaveExecuteArgv({
        argv: [...argv, "--retry"],
        cwd,
        planPath,
        planShaPath,
        approvalPath,
        executionPath,
        url: "libsql://product-truth.example",
        authTokenEnv: "TURSO_AUTH_TOKEN",
      }),
    /STANDING_WAVE_NEXT_ARGV_INVALID/u,
  );
  assert.throws(
    () =>
      assertProductTruthStandingWaveExecuteArgv({
        argv: argv.map((entry) =>
          entry === executionPath ? "/absolute/work/other" : entry),
        cwd,
        planPath,
        planShaPath,
        approvalPath,
        executionPath,
        url: "libsql://product-truth.example",
        authTokenEnv: "TURSO_AUTH_TOKEN",
      }),
    /STANDING_WAVE_NEXT_ARGV_INVALID/u,
  );
});

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeArtifactSet(
  directory: string,
  files: Record<string, string>,
): Promise<void> {
  await mkdir(directory, { recursive: false });
  await Promise.all(
    Object.entries(files).map(([name, content]) =>
      writeFile(join(directory, name), content, "utf8"),
    ),
  );
}

test("orchestrator accepts terminal exit 2, materializes saved price, and resume never replays", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "product-truth-wave-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "local.db");
  await writeFile(dbPath, "");
  const dbUrl = pathToFileURL(dbPath).href;
  const manifestPath = resolve(
    "data/audits/product-truth-phase1-scope/20260726T180513Z-g4-manifest-inputs-v1/manifest-authoritative-v3/phase1-scope-manifest.json",
  );
  const providerPolicyPath = resolve(
    "data/audits/product-truth-standing-authority/standing-provider-policy-20260728-v1.json",
  );
  const noPaidPolicyPath = resolve(
    "data/audits/product-truth-legacy-bridge/standing-policy-20260727-v1.json",
  );
  const [manifestJson, providerPolicyJson, noPaidPolicyJson] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(providerPolicyPath, "utf8"),
    readFile(noPaidPolicyPath, "utf8"),
  ]);
  const manifestSha256 = digest(manifestJson);
  const providerPolicySha256 = digest(providerPolicyJson);
  const noPaidPolicySha256 = digest(noPaidPolicyJson);
  const selected = candidate(
    "donor-orchestrated",
    ["walmart:1:sku-orchestrated"],
    100,
  );
  const sealed = sealProductTruthStandingWavePlan({
    waveId: "ptsw-orchestrated-test",
    createdAt: "2026-07-29T18:00:00.000Z",
    expiresAt: "2026-07-30T18:00:00.000Z",
    databaseTargetFingerprint:
      resolveProductTruthDatabaseTarget(dbUrl).fingerprint,
    manifestSha256,
    standingProviderPolicySha256: providerPolicySha256,
    standingNoPaidPolicySha256: noPaidPolicySha256,
    maxTargets: 1,
    candidates: [selected],
  });
  const planPath = join(root, "wave-plan.json");
  await writeFile(
    planPath,
    `${JSON.stringify(sealed.plan)}\n`,
    "utf8",
  );
  const workDir = join(root, "work");
  const options: ProductTruthStandingWaveRunOptions = {
    command: "execute",
    url: dbUrl,
    allowRemote: false,
    authTokenEnv: null,
    manifestPath,
    manifestSha256,
    standingProviderPolicyPath: providerPolicyPath,
    standingProviderPolicySha256: providerPolicySha256,
    standingNoPaidPolicyPath: noPaidPolicyPath,
    standingNoPaidPolicySha256: noPaidPolicySha256,
    planPath,
    planSha256: sealed.planSha256,
    workDir,
  };
  const invoked: string[][] = [];
  const fakeExecutor: ProductTruthStandingWaveCommandExecutor =
    async (argv) => {
      invoked.push([...argv]);
      const outIndex = argv.lastIndexOf("--out");
      assert.notEqual(outIndex, -1);
      const out = argv[outIndex + 1];
      const separator = argv.indexOf("--");
      const command = argv[separator + 1];
      const npmScript = argv[2];
      const generic = {
        "artifact-index.json": "{}\n",
        "artifact-index.sha256": `${digest("{}\n")}\n`,
      };
      if (npmScript === "product-truth:canonical-cogs-reconcile") {
        if (command === "plan") {
          const planJson = "{}\n";
          await writeArtifactSet(out, {
            ...generic,
            "reconcile-plan.json": planJson,
            "reconcile-plan.sha256": `${digest(planJson)}\n`,
          });
        } else if (command === "preflight") {
          const preflightJson = "{}\n";
          await writeArtifactSet(out, {
            ...generic,
            "preflight-report.json": preflightJson,
            "preflight-report.sha256": `${digest(preflightJson)}\n`,
          });
        } else {
          await writeArtifactSet(out, {
            ...generic,
            "apply-report.json": "{}\n",
            "apply-report.sha256": `${digest("{}\n")}\n`,
          });
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command === "doctor") {
        await writeArtifactSet(out, {
          "request.json": "{}\n",
          "request.sha256": `${digest("{}\n")}\n`,
        });
      } else if (command === "plan") {
        await writeArtifactSet(out, {
          "approval-instructions.json": "{}\n",
          "plan.json": "{}\n",
          "plan.sha256": `${digest("{}\n")}\n`,
        });
      } else if (command === "balance-probe") {
        await writeArtifactSet(out, {
          ...generic,
          "balance-evidence.json": "{}\n",
          "balance-evidence.sha256": `${digest("{}\n")}\n`,
          "raw-response.json": "{}\n",
          "raw-response.sha256": `${digest("{}\n")}\n`,
        });
      } else if (command === "authorize") {
        const executeOut = argv[argv.indexOf("--execute-out") + 1];
        const plan = argv[argv.indexOf("--plan") + 1];
        const planSha = argv[argv.indexOf("--plan-sha") + 1];
        const url = argv[argv.indexOf("--url") + 1];
        const approvalPath = join(out, "approval.json");
        const nextArgv = [
          "npm",
          "run",
          "product-truth",
          "--",
          "execute",
          "--plan",
          plan,
          "--plan-sha",
          planSha,
          "--approval",
          approvalPath,
          "--confirm",
          "EXECUTE_PRODUCT_TRUTH_PLAN_V1:test:pt-standing:test",
          "--url",
          url,
          "--out",
          executeOut,
        ];
        await writeArtifactSet(out, {
          ...generic,
          "approval.json": "{}\n",
          "approval.sha256": `${digest("{}\n")}\n`,
          "authorization.json": `${JSON.stringify({ next_argv: nextArgv })}\n`,
          "authorization.sha256": `${digest("authorization")}\n`,
        });
      } else if (command === "execute") {
        const reportJson = `${JSON.stringify({
          outcome: "AMBIGUOUS",
          reason: "DETAIL_INCOMPLETE",
          job: {
            checkpoint: {
              priceObservationId: "doo:test-price",
            },
          },
          ledger: {
            totals: { units: 1 },
          },
        })}\n`;
        await writeArtifactSet(out, {
          ...generic,
          "report.json": reportJson,
          "report.sha256": `${digest(reportJson)}\n`,
        });
        return { exitCode: 2, stdout: "", stderr: "" };
      } else if (command === "readiness") {
        const readinessJson = "{}\n";
        await writeArtifactSet(out, {
          ...generic,
          "readiness-report.json": readinessJson,
          "readiness-report.sha256": `${digest(readinessJson)}\n`,
        });
      } else {
        assert.fail(`unexpected fake command ${command}`);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
  await runProductTruthStandingWave(options, fakeExecutor);
  assert.equal(invoked.length, 9);
  assert.equal(
    invoked.filter((argv) => argv.includes("execute")).length,
    1,
  );
  const waveReport = JSON.parse(
    await readFile(join(workDir, "wave-report.json"), "utf8"),
  ) as {
    status: string;
    totals: { retries: number; actualProviderUnits: number };
    targetReports: Array<{ outcome: string; priceObservationId: string }>;
  };
  assert.equal(waveReport.status, "COMPLETED");
  assert.equal(waveReport.totals.retries, 0);
  assert.equal(waveReport.totals.actualProviderUnits, 3.5);
  assert.equal(waveReport.targetReports[0].outcome, "AMBIGUOUS");
  assert.equal(
    waveReport.targetReports[0].priceObservationId,
    "doo:test-price",
  );
  let resumeCalls = 0;
  await runProductTruthStandingWave(
    { ...options, command: "resume" },
    async () => {
      resumeCalls += 1;
      return { exitCode: 255, stdout: "", stderr: "" };
    },
  );
  assert.equal(resumeCalls, 0);
});
