#!/usr/bin/env node

/** Offline derivation of the exact preview/apply arm token. No authorization
 * is created here; APPLY requires an independently supplied owner artifact. */

import { readFile } from "node:fs/promises";

import type {
  BaseOfferPreservePlan,
  BaseOfferPreserveSelection,
} from "../src/lib/bundle-factory/repair/uncrustables-base-offer-preserve";
import {
  BASE_OFFER_LIVE_ARM_ENV,
  assertBaseOfferLiveAuthorization,
  assertBaseOfferLiveSelection,
  assertBaseOfferRollbackBinding,
  baseOfferLiveArmToken,
  type BaseOfferLiveAuthorization,
  type BaseOfferLiveSelection,
  type BaseOfferRollbackBinding,
} from "../src/lib/bundle-factory/repair/uncrustables-base-offer-live-contract";
import type { UncrustablesPreChangeSnapshot } from "../src/lib/bundle-factory/repair/uncrustables-amazon-rollback";

interface Options {
  mode: "VALIDATION_PREVIEW" | "APPLY" | null;
  plan: string | null;
  fullSelection: string | null;
  liveSelection: string | null;
  snapshot: string | null;
  rollbackBinding: string | null;
  authorization: string | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    mode: null,
    plan: null,
    fullSelection: null,
    liveSelection: null,
    snapshot: null,
    rollbackBinding: null,
    authorization: null,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node --import tsx scripts/derive-uncrustables-base-offer-live-arm.ts --mode=preview|apply --plan=PATH --full-selection=PATH --live-selection=PATH --snapshot=PATH --rollback-binding=PATH [--authorization=PATH]\n",
      );
      process.exit(0);
    } else if (arg === "--mode=preview") options.mode = "VALIDATION_PREVIEW";
    else if (arg === "--mode=apply") options.mode = "APPLY";
    else if (arg.startsWith("--plan=")) options.plan = arg.slice(7).trim();
    else if (arg.startsWith("--full-selection=")) {
      options.fullSelection = arg.slice("--full-selection=".length).trim();
    } else if (arg.startsWith("--live-selection=")) {
      options.liveSelection = arg.slice("--live-selection=".length).trim();
    } else if (arg.startsWith("--snapshot=")) {
      options.snapshot = arg.slice("--snapshot=".length).trim();
    } else if (arg.startsWith("--rollback-binding=")) {
      options.rollbackBinding = arg.slice("--rollback-binding=".length).trim();
    } else if (arg.startsWith("--authorization=")) {
      options.authorization = arg.slice("--authorization=".length).trim();
    } else throw new Error(`Unknown argument ${arg}.`);
  }
  if (
    !options.mode ||
    !options.plan ||
    !options.fullSelection ||
    !options.liveSelection ||
    !options.snapshot ||
    !options.rollbackBinding
  ) {
    throw new Error("Mode and all sealed source paths are required.");
  }
  if (options.mode === "APPLY" && !options.authorization) {
    throw new Error("APPLY token derivation requires --authorization.");
  }
  if (options.mode === "VALIDATION_PREVIEW" && options.authorization) {
    throw new Error("Preview token derivation rejects mutation authorization.");
  }
  return options;
}

async function load<T>(filePath: string): Promise<{ bytes: Buffer; value: T }> {
  const bytes = await readFile(filePath);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) as T };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const [plan, fullSelection, liveSelection, snapshot, rollbackBinding] =
    await Promise.all([
      load<BaseOfferPreservePlan>(options.plan!),
      load<BaseOfferPreserveSelection>(options.fullSelection!),
      load<BaseOfferLiveSelection>(options.liveSelection!),
      load<UncrustablesPreChangeSnapshot>(options.snapshot!),
      load<BaseOfferRollbackBinding>(options.rollbackBinding!),
    ]);
  const authorization = options.authorization
    ? (await load<BaseOfferLiveAuthorization>(options.authorization)).value
    : null;
  assertBaseOfferLiveSelection(plan.value, fullSelection.value, liveSelection.value);
  assertBaseOfferRollbackBinding(
    plan.value,
    fullSelection.value,
    liveSelection.value,
    rollbackBinding.value,
    { snapshot: snapshot.value, snapshotBytes: snapshot.bytes, now: new Date() },
  );
  if (authorization) {
    assertBaseOfferLiveAuthorization({
      plan: plan.value,
      fullSelection: fullSelection.value,
      liveSelection: liveSelection.value,
      rollbackBinding: rollbackBinding.value,
      authorization,
      snapshot: snapshot.value,
      snapshotBytes: snapshot.bytes,
      now: new Date(),
    });
  }
  const token = baseOfferLiveArmToken({
    mode: options.mode!,
    plan: plan.value,
    liveSelection: liveSelection.value,
    rollbackBinding: rollbackBinding.value,
    authorization,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: options.mode,
        confirmation_token: token,
        required_environment_variable: BASE_OFFER_LIVE_ARM_ENV,
        environment_value_must_equal_confirmation_token: true,
        authorization_created: false,
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
