import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertWalmartListingRepairFrozenReleaseAttestation,
  fetchExactReviewedMainSource,
  parseWalmartListingRepairOperatorArgs,
  runWalmartListingRepairOperator,
  WalmartListingRepairOperatorError,
} from "../walmart-listing-repair-operator.ts";
import type {
  WalmartListingRepairProductionExecutionInput,
} from "../../src/lib/walmart/listing-integrity-remediation-writer.ts";

const RELEASE_ID = "e28d8ddb846adfb79510cb2f0c3689ab24f98d50ddf64239c484391e0e04b369";

test("operator CLI requires wrapper-attested release hashes and rejects test runtime flags", () => {
  assert.throws(
    () => assertWalmartListingRepairFrozenReleaseAttestation({ NODE_ENV: "production" }),
    /verified clean-checkout release wrapper/u,
  );
  assert.doesNotThrow(() => assertWalmartListingRepairFrozenReleaseAttestation({
    NODE_ENV: "production",
    WALMART_LISTING_REPAIR_FROZEN_RELEASE_ID_SHA256: RELEASE_ID,
    WALMART_LISTING_REPAIR_FROZEN_RELEASE_MANIFEST_SHA256: "a".repeat(64),
  }));
  assert.throws(
    () => assertWalmartListingRepairFrozenReleaseAttestation({
      NODE_ENV: "test",
      WALMART_LISTING_REPAIR_FROZEN_RELEASE_ID_SHA256: RELEASE_ID,
      WALMART_LISTING_REPAIR_FROZEN_RELEASE_MANIFEST_SHA256: "a".repeat(64),
    }),
    /rejects test authority\/runtime flags/u,
  );
});

test("doctor proves the engine and enrolled owner trust root are ready with zero effects", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "walmart-repair-operator-")));
  const out = path.join(root, "doctor.json");
  try {
    const args = parseWalmartListingRepairOperatorArgs(["doctor", "--out", out]);
    const result = await runWalmartListingRepairOperator(
      args,
      new Date("2026-07-22T06:00:00.000Z"),
    );
    assert.equal(result.status, "READY");
    assert.match(String(result.next_command), /^plan --package /u);
    const readiness = result.readiness as {
      ready: boolean;
      authority: { owner_trust_root_ready: boolean; enrolled_owner_key_count: number };
      qualification: {
        verifier_release_pinned: boolean;
        walmart_native_payload_validator_ready: boolean;
        frozen_apply_writer_attestation_ready: boolean;
      };
      writer: {
        apply_writer_release_pinned: boolean;
        fixed_dependency_factory_ready: boolean;
        native_one_shot_transport_ready: boolean;
      };
    };
    assert.equal(readiness.ready, true);
    assert.equal(readiness.authority.owner_trust_root_ready, true);
    assert.equal(readiness.authority.enrolled_owner_key_count, 1);
    assert.equal(readiness.qualification.verifier_release_pinned, true);
    assert.equal(readiness.qualification.walmart_native_payload_validator_ready, true);
    assert.equal(readiness.qualification.frozen_apply_writer_attestation_ready, true);
    assert.equal(readiness.writer.apply_writer_release_pinned, true);
    assert.equal(readiness.writer.fixed_dependency_factory_ready, true);
    assert.equal(readiness.writer.native_one_shot_transport_ready, true);
    assert.deepEqual(result.external_effects, {
      network_calls: 0,
      model_calls: 0,
      paid_provider_calls: 0,
      database_writes: 0,
      walmart_content_writes: 0,
    });
    assert.equal((await stat(out)).mode & 0o777, 0o400);
    const bytes = await readFile(out, "utf8");
    assert.equal(bytes.endsWith("\n"), true);
    assert.deepEqual(JSON.parse(bytes), result);

    await assert.rejects(
      runWalmartListingRepairOperator(args, new Date("2026-07-22T06:00:01.000Z")),
      (error: unknown) => error instanceof WalmartListingRepairOperatorError
        && error.code === "OUTPUT_EXISTS_OR_UNSAFE",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("command flag allowlists reject implicit scope and live shortcuts", () => {
  assert.throws(
    () => parseWalmartListingRepairOperatorArgs(["execute", "--all", "true"]),
    /forbidden or repeated/u,
  );
  assert.throws(
    () => parseWalmartListingRepairOperatorArgs(["execute", "--package=x"]),
    /unsupported argument/u,
  );
  assert.throws(
    () => parseWalmartListingRepairOperatorArgs(["doctor", "--out", "/tmp/a", "--out", "/tmp/b"]),
    /forbidden or repeated/u,
  );
  assert.throws(
    () => parseWalmartListingRepairOperatorArgs([
      "recover-accepted", "--plan-receipt", "/tmp/forbidden",
    ]),
    /forbidden or repeated/u,
  );
  assert.equal(
    parseWalmartListingRepairOperatorArgs(["recover-accepted"]).command,
    "recover-accepted",
  );
  assert.equal(
    parseWalmartListingRepairOperatorArgs(["resume-recovered"]).command,
    "resume-recovered",
  );
  const resume = parseWalmartListingRepairOperatorArgs([
    "resume",
    "--package", "/private/tmp/package.json",
    "--package-sha256", "a".repeat(64),
    "--confirm", `RESUME_EXACT_FEED_GET_ONLY:${"b".repeat(64)}`,
    "--out", "/private/tmp/resume.json",
  ]);
  assert.equal(resume.command, "resume");
  assert.equal(resume.doctor_receipt_path, null);
  assert.equal(resume.plan_receipt_path, null);
  assert.throws(
    () => parseWalmartListingRepairOperatorArgs([
      "resume", "--doctor-receipt", "/private/tmp/stale-doctor.json",
    ]),
    /forbidden or repeated/u,
  );
  assert.throws(
    () => parseWalmartListingRepairOperatorArgs([
      "resume", "--plan-receipt", "/private/tmp/stale-plan.json",
    ]),
    /forbidden or repeated/u,
  );
  const qualify = parseWalmartListingRepairOperatorArgs([
    "qualify",
    "--package", "/private/tmp/package.json",
    "--package-sha256", "a".repeat(64),
    "--doctor-receipt", "/private/tmp/doctor.json",
    "--doctor-receipt-sha256", "b".repeat(64),
    "--capture-dir", "/private/tmp/fresh-capture",
    "--out", "/private/tmp/qualification.json",
  ]);
  assert.equal(qualify.command, "qualify");
  assert.equal(qualify.capture_dir, "/private/tmp/fresh-capture");
  assert.throws(
    () => parseWalmartListingRepairOperatorArgs(["qualify", "--confirm", "forbidden"]),
    /forbidden or repeated/u,
  );
  assert.throws(
    () => parseWalmartListingRepairOperatorArgs(["qualify", "--all", "true"]),
    /forbidden or repeated/u,
  );
  assert.equal(parseWalmartListingRepairOperatorArgs(["status"]).command, "status");
});

test("reviewed MAIN source is fetched once and must match owner-signed bytes", async () => {
  const originalFetch = globalThis.fetch;
  const bytes = Buffer.from("exact reviewed MAIN bytes");
  const sourceUrl = "https://owner.example/exact-main.png";
  const execution = {
    writer_input: {
      plan: {
        verifier_engine_release_sha256: RELEASE_ID,
        apply_engine_release_sha256: RELEASE_ID,
        changed_fields: ["description", "bullets", "main"],
        target: {
          images: [{
            slot: "main",
            source_url: sourceUrl,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          }],
        },
      },
    },
  } as unknown as WalmartListingRepairProductionExecutionInput;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls += 1;
      const response = new Response(bytes, {
        status: 200,
        headers: {
          "content-length": String(bytes.byteLength),
          "content-type": "image/png",
        },
      });
      Object.defineProperty(response, "url", { value: sourceUrl });
      return response;
    }) as typeof fetch;
    const fetched = await fetchExactReviewedMainSource(execution);
    assert.deepEqual(Buffer.from(fetched ?? []), bytes);
    assert.equal(calls, 1);

    const drifted = structuredClone(execution);
    drifted.writer_input.plan.target.images[0]!.sha256 = "f".repeat(64);
    await assert.rejects(
      fetchExactReviewedMainSource(drifted),
      (error: unknown) => error instanceof WalmartListingRepairOperatorError
        && error.code === "REVIEWED_MAIN_SOURCE_SHA_MISMATCH",
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
