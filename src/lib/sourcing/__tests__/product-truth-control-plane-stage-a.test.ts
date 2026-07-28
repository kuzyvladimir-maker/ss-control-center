import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createClient } from "@libsql/client";

import {
  PRODUCT_TRUTH_CONTROL_ALGORITHM,
  PRODUCT_TRUTH_CONTROL_COMMAND_SCHEMA,
  PRODUCT_TRUTH_CONTROL_KEY_FAMILY,
  PRODUCT_TRUTH_CONTROL_RUNTIME_MODE,
  PRODUCT_TRUTH_CONTROL_ZERO_HASH,
  ProductTruthControlContractError,
  assertProductTruthControlArtifact,
  assertProductTruthControlEvent,
  assertProductTruthControlRuntimeEnabled,
  assertProductTruthControlTransition,
  canonicalProductTruthControlEnvelope,
  parseProductTruthControlEnvelopeBytes,
  productTruthControlRequestSha256,
  productTruthControlRuntimeStatus,
  productTruthControlSigningMessage,
  sealProductTruthControlArtifact,
  sealProductTruthControlEvent,
  verifyProductTruthControlAuthority,
  type ProductTruthControlEnvelope,
  type ProductTruthControlTrustedKey,
} from "../product-truth-control-plane";

const NOW = new Date("2026-07-26T14:00:00.000Z");
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const GIT_A = "a".repeat(40);
const GIT_B = "b".repeat(40);

function envelope(
  overrides: Partial<ProductTruthControlEnvelope> = {},
): ProductTruthControlEnvelope {
  const base: ProductTruthControlEnvelope = {
    schemaVersion: PRODUCT_TRUTH_CONTROL_COMMAND_SCHEMA,
    commandId: "command-stage-a-0001",
    commandKind: "EXECUTE",
    gateClass: "METERED_EXECUTE",
    engine: {
      releaseId: "product-truth-release-2026-07-26",
      commitSha: GIT_A,
      treeSha: GIT_B,
      executableTreeSha256: SHA_A,
    },
    target: {
      environment: "LOCAL",
      databaseTargetFingerprint: SHA_B,
      manifestSha256: SHA_A,
    },
    artifacts: [{ role: "REQUEST", sha256: SHA_B, byteSize: 128 }],
    authority: {
      ownerKeyId: "product-truth-owner-key-test",
      issuedAt: "2026-07-26T13:55:00.000Z",
      expiresAt: "2026-07-26T14:15:00.000Z",
      nonce: "nonce-product-truth-stage-a-0001",
    },
    claims: {
      noImplicitScope: true,
      noMarketplaceMutation: true,
      ambiguousNeverReplay: true,
      bjsForbidden: true,
      clubsRequireSeparateGate: true,
    },
  };
  return {
    ...base,
    ...overrides,
    engine: { ...base.engine, ...overrides.engine },
    target: { ...base.target, ...overrides.target },
    authority: { ...base.authority, ...overrides.authority },
    claims: { ...base.claims, ...overrides.claims },
  };
}

function isControlError(code: string) {
  return (error: unknown) =>
    error instanceof ProductTruthControlContractError && error.code === code;
}

test("command envelope is exact-key, byte-canonical, allowlisted, and fail-closed", () => {
  const value = envelope();
  const canonical = canonicalProductTruthControlEnvelope(value);
  assert.equal(canonical.endsWith("\n"), true);
  assert.deepEqual(
    parseProductTruthControlEnvelopeBytes(Buffer.from(canonical, "utf8")),
    value,
  );
  assert.equal(productTruthControlRequestSha256(value), productTruthControlRequestSha256(value));

  const reordered = JSON.stringify({
    commandId: value.commandId,
    schemaVersion: value.schemaVersion,
    commandKind: value.commandKind,
    gateClass: value.gateClass,
    engine: value.engine,
    target: value.target,
    artifacts: value.artifacts,
    authority: value.authority,
    claims: value.claims,
  }) + "\n";
  assert.throws(
    () => parseProductTruthControlEnvelopeBytes(Buffer.from(reordered)),
    isControlError("NON_CANONICAL_KEYS"),
  );

  const falseClaim = {
    ...value,
    claims: { ...value.claims, bjsForbidden: false },
  };
  assert.throws(
    () => canonicalProductTruthControlEnvelope(falseClaim),
    isControlError("INVALID_CLAIMS"),
  );
  assert.throws(
    () => canonicalProductTruthControlEnvelope({
      ...value,
      gateClass: "READ_ONLY",
    }),
    isControlError("GATE_CLASS_MISMATCH"),
  );
  assert.throws(
    () => canonicalProductTruthControlEnvelope({
      ...value,
      arbitraryArgv: ["sh", "-c", "curl example.test"],
    }),
    isControlError("NON_CANONICAL_KEYS"),
  );
});

test("dedicated Product Truth Ed25519 authority rejects wrong domain, key family, and expiry", () => {
  const keys = generateKeyPairSync("ed25519");
  const publicDer = keys.publicKey.export({ format: "der", type: "spki" });
  const trustedKey: ProductTruthControlTrustedKey = {
    keyId: "product-truth-owner-key-test",
    keyFamily: PRODUCT_TRUTH_CONTROL_KEY_FAMILY,
    algorithm: PRODUCT_TRUTH_CONTROL_ALGORITHM,
    environment: "LOCAL",
    publicKeySpkiDerBase64: publicDer.toString("base64"),
    publicKeySpkiSha256: createHash("sha256").update(publicDer).digest("hex"),
    status: "ACTIVE",
  };
  const value = envelope();
  const signature = sign(
    null,
    productTruthControlSigningMessage(value),
    keys.privateKey,
  ).toString("base64");
  const verified = verifyProductTruthControlAuthority({
    envelope: value,
    signatureBase64: signature,
    trustedKey,
    now: NOW,
  });
  assert.match(verified.signatureSha256, /^[a-f0-9]{64}$/u);
  assert.equal(verified.commandSha256, productTruthControlRequestSha256(value));

  const wrongDomainSignature = sign(
    null,
    Buffer.from("SSCC_WALMART_OWNER_DOMAIN\0", "utf8"),
    keys.privateKey,
  ).toString("base64");
  assert.throws(
    () => verifyProductTruthControlAuthority({
      envelope: value,
      signatureBase64: wrongDomainSignature,
      trustedKey,
      now: NOW,
    }),
    isControlError("INVALID_SIGNATURE"),
  );
  assert.throws(
    () => verifyProductTruthControlAuthority({
      envelope: value,
      signatureBase64: signature,
      trustedKey: {
        ...trustedKey,
        keyFamily: "walmart-owner-control" as typeof PRODUCT_TRUTH_CONTROL_KEY_FAMILY,
      },
      now: NOW,
    }),
    isControlError("UNTRUSTED_OWNER_KEY"),
  );
  assert.throws(
    () => verifyProductTruthControlAuthority({
      envelope: value,
      signatureBase64: signature,
      trustedKey,
      now: new Date("2026-07-26T14:16:00.000Z"),
    }),
    isControlError("OWNER_AUTHORITY_EXPIRED"),
  );
});

test("state machine permits only explicit transitions and never replays ambiguity", () => {
  assert.doesNotThrow(() => assertProductTruthControlTransition({
    from: "DRAFT",
    to: "VALIDATING",
  }));
  assert.doesNotThrow(() => assertProductTruthControlTransition({
    from: "VALIDATING",
    to: "ADMITTED",
    gateClass: "READ_ONLY",
  }));
  assert.doesNotThrow(() => assertProductTruthControlTransition({
    from: "ADMITTED",
    to: "CLAIMED",
    workerLeaseRecorded: true,
    executionBoundary: "NONE",
    attempts: 0,
  }));
  assert.doesNotThrow(() => assertProductTruthControlTransition({
    from: "CLAIMED",
    to: "RUNNING",
    executionBoundary: "RECORDED",
    attempts: 1,
  }));
  assert.doesNotThrow(() => assertProductTruthControlTransition({
    from: "CLAIMED",
    to: "ADMITTED",
    leaseExpired: true,
    executionBoundary: "NONE",
    attempts: 0,
    durableZeroAttempt: true,
  }));
  assert.throws(
    () => assertProductTruthControlTransition({
      from: "RUNNING",
      to: "ADMITTED",
    }),
    isControlError("INVALID_STATE_TRANSITION"),
  );
  assert.throws(
    () => assertProductTruthControlTransition({
      from: "AMBIGUOUS",
      to: "ADMITTED",
    }),
    isControlError("INVALID_STATE_TRANSITION"),
  );
  assert.throws(
    () => assertProductTruthControlTransition({
      from: "ADMITTED",
      to: "CLAIMED",
    }),
    isControlError("INVALID_STATE_TRANSITION"),
  );
  assert.throws(
    () => assertProductTruthControlTransition({
      from: "CLAIMED",
      to: "RUNNING",
    }),
    isControlError("INVALID_STATE_TRANSITION"),
  );
  assert.throws(
    () => assertProductTruthControlTransition({
      from: "CLAIMED",
      to: "AMBIGUOUS",
      executionBoundary: "NONE",
    }),
    isControlError("INVALID_STATE_TRANSITION"),
  );
  assert.throws(
    () => assertProductTruthControlTransition({
      from: "CLAIMED",
      to: "ADMITTED",
      leaseExpired: true,
      executionBoundary: "UNKNOWN",
      attempts: 0,
      durableZeroAttempt: true,
    }),
    isControlError("INVALID_STATE_TRANSITION"),
  );
});

test("artifact and event seals bind exact bytes and event predecessors", () => {
  const artifact = sealProductTruthControlArtifact({
    artifactId: "artifact-stage-a-0001",
    commandId: "command-stage-a-0001",
    role: "REQUEST",
    mediaType: "application/json",
    content: Buffer.from("{\"ok\":true}\n", "utf8"),
    createdAt: NOW.toISOString(),
    createdByPrincipal: "user-owner-0001",
  });
  assert.doesNotThrow(() => assertProductTruthControlArtifact(artifact));
  assert.match(
    artifact.locator,
    /^product-truth-control\/command-stage-a-0001\/sha256\/[a-f0-9]{64}$/u,
  );
  assert.throws(
    () => assertProductTruthControlArtifact({
      ...artifact,
      content: Buffer.from("{\"ok\":false}\n", "utf8"),
    }),
    isControlError("ARTIFACT_INTEGRITY_MISMATCH"),
  );

  const first = sealProductTruthControlEvent({
    eventId: "event-stage-a-0001",
    commandId: "command-stage-a-0001",
    sequence: 1,
    eventType: "REQUESTED",
    source: "SERVER",
    occurredAt: NOW.toISOString(),
    payload: Buffer.from("{\"requested\":true}\n", "utf8"),
    previousEventHash: PRODUCT_TRUTH_CONTROL_ZERO_HASH,
  });
  const second = sealProductTruthControlEvent({
    eventId: "event-stage-a-0002",
    commandId: "command-stage-a-0001",
    sequence: 2,
    eventType: "ARTIFACTS_VALIDATED",
    source: "SERVER",
    occurredAt: NOW.toISOString(),
    payload: Buffer.from("{\"valid\":true}\n", "utf8"),
    previousEventHash: first.eventHash,
  });
  assert.doesNotThrow(() => assertProductTruthControlEvent(first));
  assert.doesNotThrow(() => assertProductTruthControlEvent(second));
  assert.throws(
    () => assertProductTruthControlEvent({
      ...second,
      previousEventHash: PRODUCT_TRUTH_CONTROL_ZERO_HASH,
    }),
    isControlError("INVALID_EVENT"),
  );
});

test("Stage A runtime is unconditionally OFF with zero effect surfaces", async () => {
  assert.deepEqual(productTruthControlRuntimeStatus(), {
    mode: PRODUCT_TRUTH_CONTROL_RUNTIME_MODE,
    databaseReads: false,
    databaseWrites: false,
    workerClaim: false,
    processSpawn: false,
    networkCalls: false,
  });
  assert.throws(
    () => assertProductTruthControlRuntimeEnabled(),
    isControlError("PRODUCT_TRUTH_CONTROL_RUNTIME_OFF"),
  );
  const source = await readFile(
    new URL("../product-truth-control-plane.ts", import.meta.url),
    "utf8",
  );
  for (const forbiddenEffectSurface of [
    /\bprocess\.env\b/u,
    /\bfetch\s*\(/u,
    /\bcreateClient\b/u,
    /\b(?:spawn|execFile|exec)\s*\(/u,
    /node:child_process/u,
  ]) {
    assert.doesNotMatch(source, forbiddenEffectSurface);
  }
});

test("Stage A migration enforces append-only custody, exact chain advance, and state guards", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await db.execute("PRAGMA foreign_keys=ON");
    const migration = new URL(
      "../../../../prisma/migrations/20260726110000_product_truth_control_plane_stage_a/migration.sql",
      import.meta.url,
    );
    await db.executeMultiple(await readFile(migration, "utf8"));

    const names = await db.execute(
      "SELECT type,name FROM sqlite_master WHERE name LIKE 'ProductTruthControl%'",
    );
    const objectNames = new Set(names.rows.map((row) => String(row.name)));
    for (const required of [
      "ProductTruthControlCommand",
      "ProductTruthControlArtifact",
      "ProductTruthControlEvent",
      "ProductTruthControlArtifact_update_guard",
      "ProductTruthControlArtifact_delete_guard",
      "ProductTruthControlEvent_chain_insert_guard",
      "ProductTruthControlEvent_update_guard",
      "ProductTruthControlEvent_delete_guard",
      "ProductTruthControlCommand_transition_guard",
      "ProductTruthControlCommand_attempt_guard",
      "ProductTruthControlCommand_owner_authority_update_guard",
    ]) {
      assert.equal(objectNames.has(required), true, required);
    }

    const value = envelope({
      commandKind: "DOCTOR",
      gateClass: "READ_ONLY",
      authority: {
        ownerKeyId: null,
        issuedAt: null,
        expiresAt: null,
        nonce: null,
      },
    });
    const requestSha = productTruthControlRequestSha256(value);
    await db.execute({
      sql: `INSERT INTO ProductTruthControlCommand (
        commandId,schemaVersion,commandKind,gateClass,status,idempotencyKey,
        requestSha256,requestedByUserId,requestedAt,engineReleaseId,
        engineCommitSha,engineTreeSha,executableTreeSha256,environment,
        databaseTargetFingerprint,manifestSha256
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        value.commandId,
        value.schemaVersion,
        value.commandKind,
        value.gateClass,
        "DRAFT",
        requestSha,
        requestSha,
        "user-owner-0001",
        NOW.toISOString(),
        value.engine.releaseId,
        value.engine.commitSha,
        value.engine.treeSha,
        value.engine.executableTreeSha256,
        value.target.environment,
        value.target.databaseTargetFingerprint,
        value.target.manifestSha256,
      ],
    });

    const artifact = sealProductTruthControlArtifact({
      artifactId: "artifact-stage-a-0001",
      commandId: value.commandId,
      role: "REQUEST",
      mediaType: "application/json",
      content: Buffer.from("{\"request\":true}\n", "utf8"),
      createdAt: NOW.toISOString(),
      createdByPrincipal: "user-owner-0001",
    });
    const insertArtifact = {
      sql: `INSERT INTO ProductTruthControlArtifact (
        artifactId,commandId,schemaVersion,role,mediaType,content,byteSize,
        sha256,locator,createdAt,createdByPrincipal
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        artifact.artifactId,
        artifact.commandId,
        artifact.schemaVersion,
        artifact.role,
        artifact.mediaType,
        artifact.content,
        artifact.byteSize,
        artifact.sha256,
        artifact.locator,
        artifact.createdAt,
        artifact.createdByPrincipal,
      ],
    };
    await db.execute(insertArtifact);
    await assert.rejects(
      () => db.execute({
        sql: "UPDATE ProductTruthControlArtifact SET mediaType=? WHERE artifactId=?",
        args: ["text/plain", artifact.artifactId],
      }),
      /append-only/u,
    );
    await assert.rejects(
      () => db.execute({
        sql: "DELETE FROM ProductTruthControlArtifact WHERE artifactId=?",
        args: [artifact.artifactId],
      }),
      /append-only/u,
    );
    await assert.rejects(
      () => db.execute({
        ...insertArtifact,
        sql: insertArtifact.sql.replace(/^INSERT/u, "INSERT OR REPLACE"),
      }),
      /duplicate insert/u,
    );

    const first = sealProductTruthControlEvent({
      eventId: "event-stage-a-0001",
      commandId: value.commandId,
      sequence: 1,
      eventType: "REQUESTED",
      source: "SERVER",
      occurredAt: NOW.toISOString(),
      payload: Buffer.from("{\"request\":true}\n", "utf8"),
      previousEventHash: PRODUCT_TRUTH_CONTROL_ZERO_HASH,
    });
    const insertEvent = async (
      event: ReturnType<typeof sealProductTruthControlEvent>,
    ) => db.execute({
      sql: `INSERT INTO ProductTruthControlEvent (
        eventId,commandId,schemaVersion,sequence,eventType,source,occurredAt,
        payload,payloadSha256,previousEventHash,eventHash
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        event.eventId,
        event.commandId,
        event.schemaVersion,
        event.sequence,
        event.eventType,
        event.source,
        event.occurredAt,
        event.payload,
        event.payloadSha256,
        event.previousEventHash,
        event.eventHash,
      ],
    });
    await insertEvent(first);
    await assert.rejects(
      () => insertEvent(sealProductTruthControlEvent({
        eventId: "event-stage-a-0003",
        commandId: value.commandId,
        sequence: 3,
        eventType: "ARTIFACTS_VALIDATED",
        source: "SERVER",
        occurredAt: NOW.toISOString(),
        payload: Buffer.from("{\"valid\":true}\n", "utf8"),
        previousEventHash: first.eventHash,
      })),
      /chain advance/u,
    );
    const second = sealProductTruthControlEvent({
      eventId: "event-stage-a-0002",
      commandId: value.commandId,
      sequence: 2,
      eventType: "ARTIFACTS_VALIDATED",
      source: "SERVER",
      occurredAt: NOW.toISOString(),
      payload: Buffer.from("{\"valid\":true}\n", "utf8"),
      previousEventHash: first.eventHash,
    });
    await insertEvent(second);
    await assert.rejects(
      () => db.execute({
        sql: "UPDATE ProductTruthControlEvent SET source='WORKER' WHERE eventId=?",
        args: [first.eventId],
      }),
      /append-only/u,
    );

    await db.execute({
      sql: "UPDATE ProductTruthControlCommand SET status='VALIDATING' WHERE commandId=?",
      args: [value.commandId],
    });
    await assert.rejects(
      () => db.execute({
        sql: `UPDATE ProductTruthControlCommand
          SET ownerKeyId=?,ownerNonce=?,ownerSignatureSha256=?,
              ownerAuthorizedAt=CURRENT_TIMESTAMP,
              ownerAuthorizationExpiresAt=datetime('now','+10 minutes')
          WHERE commandId=?`,
        args: [
          "owner-key-not-applicable",
          "owner-nonce-not-applicable",
          SHA_A,
          value.commandId,
        ],
      }),
      /CHECK constraint failed/u,
    );
    await db.execute({
      sql: "UPDATE ProductTruthControlCommand SET status='ADMITTED' WHERE commandId=?",
      args: [value.commandId],
    });
    await assert.rejects(
      () => db.execute({
        sql: "UPDATE ProductTruthControlCommand SET status='RUNNING' WHERE commandId=?",
        args: [value.commandId],
      }),
      /transition is not permitted/u,
    );
    await db.execute({
      sql: `UPDATE ProductTruthControlCommand
        SET status='CLAIMED',
            workerLeaseOwner='local-stage-a-test-worker',
            workerLeaseTokenSha256=?,
            workerLeaseExpiresAt=datetime('now','+10 minutes')
        WHERE commandId=?`,
      args: [SHA_A, value.commandId],
    });
    await assert.rejects(
      () => db.execute({
        sql: `UPDATE ProductTruthControlCommand
          SET status='RUNNING',attempts=1
          WHERE commandId=?`,
        args: [value.commandId],
      }),
      /transition is not permitted|attempt boundary is invalid/u,
    );
    await db.execute({
      sql: `UPDATE ProductTruthControlCommand
        SET status='RUNNING',
            attempts=1,
            executionBoundary='RECORDED',
            executionStartedAt=CURRENT_TIMESTAMP
        WHERE commandId=?`,
      args: [value.commandId],
    });
    const running = await db.execute({
      sql: `SELECT status,attempts,executionBoundary
        FROM ProductTruthControlCommand WHERE commandId=?`,
      args: [value.commandId],
    });
    assert.deepEqual(
      {
        status: running.rows[0]?.status,
        attempts: Number(running.rows[0]?.attempts),
        executionBoundary: running.rows[0]?.executionBoundary,
      },
      {
        status: "RUNNING",
        attempts: 1,
        executionBoundary: "RECORDED",
      },
    );
    await assert.rejects(
      () => db.execute({
        sql: "UPDATE ProductTruthControlCommand SET commandKind='STATUS' WHERE commandId=?",
        args: [value.commandId],
      }),
      /identity is immutable/u,
    );
    await assert.rejects(
      () => db.execute({
        sql: "DELETE FROM ProductTruthControlCommand WHERE commandId=?",
        args: [value.commandId],
      }),
      /cannot be deleted/u,
    );
  } finally {
    db.close();
  }
});
