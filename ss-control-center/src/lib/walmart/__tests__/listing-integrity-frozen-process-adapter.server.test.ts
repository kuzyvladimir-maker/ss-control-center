import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildWalmartListingIntegrityFrozenPreflightProcessCommand,
  buildWalmartListingIntegrityFrozenProcessCommand,
  type WalmartListingIntegrityFrozenProcessConfig,
} from "../listing-integrity-frozen-process-adapter.server";
import type {
  WalmartListingIntegrityFrozenWorkerInvocation,
} from "../listing-integrity-frozen-operator-worker";

const H = (value: string) => createHash("sha256").update(value).digest("hex");

const CONFIG: WalmartListingIntegrityFrozenProcessConfig = Object.freeze({
  node_path: "/opt/homebrew/bin/node",
  env_file: "/private/app/.env",
  engine_root: "/private/releases/v50/engine/ss-control-center",
  manifest_path: "/private/releases/v50/release-manifest.json",
  manifest_sha256: H("manifest"),
  release_id_sha256: H("release"),
  global_admission_root: "/private/owner/walmart/global-admission-v1",
  global_admission_identity_sha256: H("admission"),
});

test("read-only preflight admits only exact doctor and plan commands", () => {
  const doctor = buildWalmartListingIntegrityFrozenPreflightProcessCommand({
    config: CONFIG,
    operator_args: ["doctor"],
  });
  assert.equal(doctor.args.at(-1), "doctor");
  const plan = buildWalmartListingIntegrityFrozenPreflightProcessCommand({
    config: CONFIG,
    operator_args: [
      "plan",
      "--package", "/private/owner/package.json",
      "--package-sha256", H("package"),
      "--doctor-receipt", "/private/owner/doctor.json",
      "--doctor-receipt-sha256", H("doctor"),
    ],
  });
  assert.equal(plan.args.at(-9), "plan");
  for (const operator_args of [
    ["execute"],
    ["doctor", "--out", "/tmp/receipt.json"],
    ["plan", "--package", "/tmp/package.json"],
  ]) {
    assert.throws(
      () => buildWalmartListingIntegrityFrozenPreflightProcessCommand({
        config: CONFIG,
        operator_args,
      }),
      /FROZEN_PREFLIGHT_SUFFIX_INVALID/,
    );
  }
});

function invocation(
  command: "execute" | "resume" | "qualify",
): WalmartListingIntegrityFrozenWorkerInvocation {
  return {
    schema_version: "walmart-listing-integrity-frozen-operator-worker/v1",
    command,
    listing_key: "walmart:1:FaisalX-1144",
    sku: "FaisalX-1144",
    current_state_body_sha256: H("state"),
    execution_package_sha256: H("package"),
    owner_permit_sha256: H("permit"),
    plan_body_sha256: H("plan"),
    feed_id: command === "execute" ? null : "feed-1",
    frozen_release_id_sha256: H("release"),
    manifest_sha256: H("manifest"),
    global_admission_identity_sha256: H("admission"),
    automatic_retry_allowed: false,
    automatic_replay_allowed: false,
    maximum_operator_calls: 1,
  };
}

function argsFor(value: WalmartListingIntegrityFrozenWorkerInvocation): string[] {
  const common = [
    "--package", "/private/owner/package.json",
    "--package-sha256", value.execution_package_sha256,
  ];
  if (value.command === "resume") {
    return [
      "resume",
      ...common,
      "--confirm", `RESUME_EXACT_FEED_GET_ONLY:${value.owner_permit_sha256}`,
    ];
  }
  if (value.command === "qualify") {
    return [
      "qualify",
      ...common,
      "--doctor-receipt", "/private/owner/doctor.json",
      "--doctor-receipt-sha256", H("doctor"),
      "--capture-dir", "/private/owner/capture.evidence",
    ];
  }
  return [
    "execute",
    ...common,
    "--doctor-receipt", "/private/owner/doctor.json",
    "--doctor-receipt-sha256", H("doctor"),
    "--plan-receipt", "/private/owner/plan.json",
    "--plan-receipt-sha256", H("plan-receipt"),
    "--confirm", `EXECUTE_ONE_WALMART_SKU:${value.listing_key}:${value.plan_body_sha256}`,
  ];
}

test("builds the exact shell-free verified-wrapper command for all worker actions", () => {
  for (const action of ["execute", "resume", "qualify"] as const) {
    const value = invocation(action);
    const built = buildWalmartListingIntegrityFrozenProcessCommand({
      invocation: value,
      config: CONFIG,
      operator_args: argsFor(value),
    });
    assert.equal(built.executable, CONFIG.node_path);
    assert.equal(built.cwd, CONFIG.engine_root);
    assert.equal(built.automatic_retry_allowed, false);
    assert.equal(built.automatic_replay_allowed, false);
    assert.equal(built.args.at(-argsFor(value).length), action);
    assert.equal(built.args.filter((entry) => entry === "--").length, 1);
    assert.equal(
      built.args[1],
      `${CONFIG.engine_root}/scripts/verify-and-run-walmart-listing-repair.mjs`,
    );
  }
});

test("release, package, confirmation and suffix drift fail before process spawn", () => {
  const value = invocation("execute");
  assert.throws(
    () => buildWalmartListingIntegrityFrozenProcessCommand({
      invocation: value,
      config: { ...CONFIG, manifest_sha256: H("drift") },
      operator_args: argsFor(value),
    }),
    /FROZEN_PROCESS_RELEASE_DRIFT/,
  );
  const packageDrift = argsFor(value);
  packageDrift[packageDrift.indexOf("--package-sha256") + 1] = H("drift");
  assert.throws(
    () => buildWalmartListingIntegrityFrozenProcessCommand({
      invocation: value,
      config: CONFIG,
      operator_args: packageDrift,
    }),
    /FROZEN_PROCESS_PACKAGE_DRIFT/,
  );
  const confirmDrift = argsFor(value);
  confirmDrift[confirmDrift.indexOf("--confirm") + 1] = "wrong";
  assert.throws(
    () => buildWalmartListingIntegrityFrozenProcessCommand({
      invocation: value,
      config: CONFIG,
      operator_args: confirmDrift,
    }),
    /FROZEN_PROCESS_CONFIRMATION_DRIFT/,
  );
  assert.throws(
    () => buildWalmartListingIntegrityFrozenProcessCommand({
      invocation: value,
      config: CONFIG,
      operator_args: [...argsFor(value), "--out", "/tmp/receipt.json"],
    }),
    /FROZEN_PROCESS_SUFFIX_INVALID/,
  );
});
