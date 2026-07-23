import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertWalmartListingRepairFrozenReleaseAttestation,
  parseWalmartListingRepairOperatorArgs,
  runWalmartListingRepairOperator,
  WalmartListingRepairOperatorError,
} from "../walmart-listing-repair-operator.ts";

const RELEASE_ID = "0d21ffcd5bf55c6e781daba80b3a750613f2d21bb89690a73ccbd66326aa246d";

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
  assert.equal(parseWalmartListingRepairOperatorArgs(["status"]).command, "status");
});
