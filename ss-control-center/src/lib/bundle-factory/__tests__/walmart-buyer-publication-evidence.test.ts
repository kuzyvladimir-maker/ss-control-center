import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  assertCurrentWalmartBuyerEvidenceTarget,
  buildPendingWalmartBuyerPublicationEvidenceTemplate,
  recordWalmartBuyerPublicationEvidence,
  sealWalmartBuyerEvidenceTemplate,
  shouldCreatePendingWalmartBuyerEvidenceTemplate,
  validateWalmartBuyerPublicationEvidence,
  WALMART_BUYER_RAW_EVIDENCE_VERSION,
  walmartBuyerEvidenceNotBefore,
  type WalmartBuyerEvidenceSourceKind,
} from "@/lib/bundle-factory/distribution/walmart-buyer-publication-evidence";

const CAPTURED_AT = "2026-07-18T20:00:00.000Z";
const SOURCE_URL = "https://www.walmart.com/ip/example-title/123456789";
const CERTIFICATION_SHA256 = "c".repeat(64);
const VERIFY_RECEIPT_SHA256 = "d".repeat(64);

const CERTIFICATION_BINDING = {
  certification_sha256: CERTIFICATION_SHA256,
  channel_sku_id: "channel-sku-1",
  sku: "PILOT-1",
  payload_sha256: "e".repeat(64),
  seller_account_fingerprint_sha256: "f".repeat(64),
};
const EXPECTED_ATTEMPT_BINDING = {
  attemptId: "attempt-1",
  channelSkuId: "channel-sku-1",
  certificationSha256: CERTIFICATION_SHA256,
  payloadSha256: CERTIFICATION_BINDING.payload_sha256,
  sellerAccountFingerprintSha256:
    CERTIFICATION_BINDING.seller_account_fingerprint_sha256,
  idempotencyKey: `walmart:v1:${createHash("sha256")
    .update(`channel-sku-1\n${CERTIFICATION_BINDING.payload_sha256}`)
    .digest("hex")}`,
};

function verifyReceiptBinding(input: {
  attemptId?: string;
  itemId?: string;
  certificationSha256?: string;
  sku?: string;
} = {}) {
  return {
    receipt_sha256: VERIFY_RECEIPT_SHA256,
    certification_sha256:
      input.certificationSha256 ?? CERTIFICATION_SHA256,
    channel_sku_id: "channel-sku-1",
    sku: input.sku ?? "PILOT-1",
    payload_sha256: CERTIFICATION_BINDING.payload_sha256,
    submission_attempt_binding: {
      attempt_id: input.attemptId ?? "attempt-1",
      channel_sku_id: "channel-sku-1",
      certification_sha256:
        input.certificationSha256 ?? CERTIFICATION_SHA256,
      payload_sha256: CERTIFICATION_BINDING.payload_sha256,
      seller_account_fingerprint_sha256:
        CERTIFICATION_BINDING.seller_account_fingerprint_sha256,
      idempotency_key: `walmart:v1:${createHash("sha256")
        .update(`channel-sku-1\n${CERTIFICATION_BINDING.payload_sha256}`)
        .digest("hex")}`,
    },
    buyer_evidence_status: {
      channel_sku_id: "channel-sku-1",
      attempt_id: input.attemptId ?? "attempt-1",
      walmart_item_id: input.itemId ?? "123456789",
      buyer_verified: false,
    },
    poll_result: null,
  };
}

function rawEvidence(sourceKind: WalmartBuyerEvidenceSourceKind) {
  const artifactKind = {
    WALMART_BUYER_PDP: "PDP_DOCUMENT",
    SEALED_BUYER_SNAPSHOT: "SEALED_SNAPSHOT",
    MANUAL_BROWSER_VERIFICATION: "BROWSER_SCREENSHOT",
  }[sourceKind];
  return {
    schema_version: WALMART_BUYER_RAW_EVIDENCE_VERSION,
    source_kind: sourceKind,
    binding: {
      sku: "PILOT-1",
      walmart_item_id: "123456789",
      source_url: SOURCE_URL,
      captured_at: CAPTURED_AT,
    },
    artifact: {
      kind: artifactKind,
      sha256: "a".repeat(64),
      ref: `capture:${sourceKind}:123456789`,
    },
    observation: {
      page_rendered: true,
      availability: "IN_STOCK",
      add_to_cart_enabled: true,
      ...(sourceKind === "WALMART_BUYER_PDP" ? { http_status: 200 } : {}),
    },
    ...(sourceKind === "MANUAL_BROWSER_VERIFICATION"
      ? { observer: "operator@example.com" }
      : {}),
  };
}

function validInput(
  sourceKind: WalmartBuyerEvidenceSourceKind = "WALMART_BUYER_PDP",
) {
  return {
    channelSkuId: "channel-sku-1",
    submissionAttemptId: "attempt-1",
    sku: "PILOT-1",
    walmartItemId: "123456789",
    sourceUrl: SOURCE_URL,
    sourceKind,
    capturedAt: CAPTURED_AT,
    exactSkuMatch: true,
    exactItemIdMatch: true,
    published: true,
    buyable: true,
    rawEvidence: rawEvidence(sourceKind),
  };
}

async function localArtifactFixture(
  t: TestContext,
  bytes = Buffer.from("sealed Walmart buyer evidence\n", "utf8"),
) {
  const directory = await mkdtemp(join(tmpdir(), "walmart-buyer-evidence-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, "exact-buyer-pdp.png");
  await writeFile(path, bytes);
  return {
    directory,
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function validInputWithArtifact(ref: string, sha256: string) {
  const input = validInput();
  return {
    ...input,
    rawEvidence: {
      ...input.rawEvidence,
      artifact: {
        ...input.rawEvidence.artifact,
        ref,
        sha256,
      },
    },
  };
}

test("pending buyer-evidence template contains no prefilled positive facts", () => {
  const template = buildPendingWalmartBuyerPublicationEvidenceTemplate({
    certificationSha256: CERTIFICATION_SHA256,
    verifyReceiptSha256: VERIFY_RECEIPT_SHA256,
    channelSkuId: "channel-sku-1",
    submissionAttemptId: "attempt-1",
    sku: "PILOT-1",
    walmartItemId: "123456789",
  });

  assert.equal(template.capturedAt, null);
  assert.equal(template.exactSkuMatch, false);
  assert.equal(template.exactItemIdMatch, false);
  assert.equal(template.published, false);
  assert.equal(template.buyable, false);
  assert.equal(template.rawEvidence.binding.captured_at, null);
  assert.equal(template.rawEvidence.observation.page_rendered, false);
  assert.equal(template.rawEvidence.observation.add_to_cart_enabled, false);
  assert.match(template.rawEvidence.observation.availability, /^TODO_/);
  assert.match(template.rawEvidence.artifact.sha256, /^TODO_/);
  assert.match(template.rawEvidence.artifact.ref, /^TODO_/);
  assert.match(template.rawEvidence.observer, /^TODO_/);
  assert.equal(template.engineBinding.channel, "WALMART");
  assert.equal(
    template.engineBinding.certification_sha256,
    CERTIFICATION_SHA256,
  );
  assert.equal(
    template.engineBinding.verify_receipt_sha256,
    VERIFY_RECEIPT_SHA256,
  );
});

test("pending buyer-evidence template is suppressed only in the recording call and can refresh later", () => {
  const base = {
    buyerVerified: false,
    buyerEvidenceRecorded: false,
    submissionAttemptId: "attempt-1",
    walmartItemId: "123456789",
  };
  assert.equal(
    shouldCreatePendingWalmartBuyerEvidenceTemplate({
      ...base,
      buyerEvidenceRecorded: true,
    }),
    false,
  );
  assert.equal(shouldCreatePendingWalmartBuyerEvidenceTemplate(base), true);
  assert.equal(
    shouldCreatePendingWalmartBuyerEvidenceTemplate({
      ...base,
      buyerVerified: true,
    }),
    false,
  );
  assert.equal(
    shouldCreatePendingWalmartBuyerEvidenceTemplate({
      ...base,
      submissionAttemptId: null,
    }),
    false,
  );
  assert.equal(
    shouldCreatePendingWalmartBuyerEvidenceTemplate({
      ...base,
      walmartItemId: null,
    }),
    false,
  );
});

function completedPendingTemplate(artifactPath: string, capturedAt = CAPTURED_AT) {
  const template = buildPendingWalmartBuyerPublicationEvidenceTemplate({
    certificationSha256: CERTIFICATION_SHA256,
    verifyReceiptSha256: VERIFY_RECEIPT_SHA256,
    channelSkuId: "channel-sku-1",
    submissionAttemptId: "attempt-1",
    sku: "PILOT-1",
    walmartItemId: "123456789",
  });
  template.capturedAt = capturedAt as never;
  template.exactSkuMatch = true;
  template.exactItemIdMatch = true;
  template.published = true;
  template.buyable = true;
  template.rawEvidence.binding.captured_at = capturedAt as never;
  template.rawEvidence.artifact.ref = artifactPath;
  template.rawEvidence.observation.page_rendered = true;
  template.rawEvidence.observation.availability = "IN_STOCK";
  template.rawEvidence.observation.add_to_cart_enabled = true;
  template.rawEvidence.observer = "operator@example.com";
  return template;
}

test("buyer evidence sealer changes only screenshot SHA and preserves exact receipt bindings", async (t) => {
  const artifact = await localArtifactFixture(t);
  const draft = completedPendingTemplate(artifact.path);
  const expected = structuredClone(draft) as unknown as Record<string, unknown>;
  ((expected.rawEvidence as Record<string, unknown>).artifact as Record<string, unknown>)
    .sha256 = artifact.sha256;
  const result = await sealWalmartBuyerEvidenceTemplate({
    draft,
    certification: CERTIFICATION_BINDING,
    verifyReceipt: verifyReceiptBinding(),
    now: new Date("2026-07-18T20:05:00.000Z"),
  });
  assert.deepEqual(result.sealed, expected);
  assert.equal(result.artifact.sha256, artifact.sha256);
  assert.equal(
    "byte_size" in
      ((result.sealed.rawEvidence as Record<string, unknown>).artifact as Record<string, unknown>),
    false,
  );
});

test("buyer evidence sealer rejects missing, symlink, hardlink, non-file, empty, oversized, and read-race artifacts", async (t) => {
  const artifact = await localArtifactFixture(t);
  const symlinkPath = join(artifact.directory, "screenshot-link.png");
  const hardlinkPath = join(artifact.directory, "screenshot-hardlink.png");
  const emptyPath = join(artifact.directory, "empty.png");
  const oversizedPath = join(artifact.directory, "oversized.png");
  await symlink(artifact.path, symlinkPath);
  await link(artifact.path, hardlinkPath);
  await writeFile(emptyPath, "");
  await writeFile(oversizedPath, "x");
  await truncate(oversizedPath, 25 * 1024 * 1024 + 1);
  const base = {
    certification: CERTIFICATION_BINDING,
    verifyReceipt: verifyReceiptBinding(),
    now: new Date("2026-07-18T20:05:00.000Z"),
  };
  for (const path of [
    join(artifact.directory, "missing.png"),
    symlinkPath,
    hardlinkPath,
    artifact.directory,
    emptyPath,
    oversizedPath,
  ]) {
    await assert.rejects(
      sealWalmartBuyerEvidenceTemplate({
        ...base,
        draft: completedPendingTemplate(path),
      }),
      /single-link regular file|cannot be opened safely/,
    );
  }
  await rm(hardlinkPath);
  await assert.rejects(
    sealWalmartBuyerEvidenceTemplate({
      ...base,
      draft: completedPendingTemplate(artifact.path),
      testOnlyAfterOpen: async (path) => {
        await writeFile(path, "changed during read\n");
      },
    }),
    /changed during read/,
  );
});

test("buyer evidence sealer rejects foreign certification, same-SKU attempt/item, stale capture, and recomputed editable bindings", async (t) => {
  const artifact = await localArtifactFixture(t);
  const base = {
    draft: completedPendingTemplate(artifact.path),
    certification: CERTIFICATION_BINDING,
    verifyReceipt: verifyReceiptBinding(),
    now: new Date("2026-07-18T20:05:00.000Z"),
  };
  await assert.rejects(
    sealWalmartBuyerEvidenceTemplate({
      ...base,
      certification: {
        ...CERTIFICATION_BINDING,
        certification_sha256: "e".repeat(64),
      },
    }),
    /certification_sha256/,
  );
  await assert.rejects(
    sealWalmartBuyerEvidenceTemplate({
      ...base,
      verifyReceipt: verifyReceiptBinding({ attemptId: "foreign-attempt" }),
    }),
    /attempt_id/,
  );
  await assert.rejects(
    sealWalmartBuyerEvidenceTemplate({
      ...base,
      verifyReceipt: verifyReceiptBinding({ itemId: "999999999" }),
    }),
    /walmart_item_id/,
  );
  const conflictingReceipt = {
    ...verifyReceiptBinding(),
    poll_result: {
      channel_sku_id: "channel-sku-1",
      submission_attempt_id: "attempt-1",
      walmart_item_id: "999999999",
    },
  };
  await assert.rejects(
    sealWalmartBuyerEvidenceTemplate({
      ...base,
      verifyReceipt: conflictingReceipt,
    }),
    /conflicting Walmart item IDs/,
  );
  const tornAttemptReceipt = {
    ...verifyReceiptBinding(),
    poll_result: {
      channel_sku_id: "channel-sku-1",
      submission_attempt_id: "foreign-attempt",
      walmart_item_id: "123456789",
    },
  };
  await assert.rejects(
    sealWalmartBuyerEvidenceTemplate({
      ...base,
      verifyReceipt: tornAttemptReceipt,
    }),
    /poll_result\.submission_attempt_id/,
  );
  await assert.rejects(
    sealWalmartBuyerEvidenceTemplate({
      ...base,
      draft: completedPendingTemplate(
        artifact.path,
        "2026-07-18T19:00:00.000Z",
      ),
    }),
    /30-minute freshness window/,
  );
  const edited = completedPendingTemplate(artifact.path);
  edited.submissionAttemptId = "foreign-attempt";
  edited.engineBinding.submission_attempt_id = "foreign-attempt";
  await assert.rejects(
    sealWalmartBuyerEvidenceTemplate({ ...base, draft: edited }),
    /binding_sha256|attempt_id/,
  );
});

test("runtime target guard rejects a foreign latest attempt and a mismatched current ChannelSKU item before record or poll", () => {
  const evidence = {
    channelSkuId: "channel-sku-1",
    submissionAttemptId: "attempt-1",
    sku: "PILOT-1",
    walmartItemId: "123456789",
  };
  assert.doesNotThrow(() =>
    assertCurrentWalmartBuyerEvidenceTarget({
      evidence,
      channelSku: {
        id: "channel-sku-1",
        sku: "PILOT-1",
        walmartItemId: "123456789",
      },
      latestSubmissionAttemptId: "attempt-1",
    }),
  );
  assert.throws(
    () =>
      assertCurrentWalmartBuyerEvidenceTarget({
        evidence,
        channelSku: {
          id: "channel-sku-1",
          sku: "PILOT-1",
          walmartItemId: "123456789",
        },
        latestSubmissionAttemptId: "newer-same-sku-attempt",
      }),
    /latest certified submission attempt/,
  );
  assert.throws(
    () =>
      assertCurrentWalmartBuyerEvidenceTarget({
        evidence,
        channelSku: {
          id: "channel-sku-1",
          sku: "PILOT-1",
          walmartItemId: "999999999",
        },
        latestSubmissionAttemptId: "attempt-1",
      }),
    /current ChannelSKU/,
  );
});

test("buyer evidence is canonical, exact, published, and buyable", () => {
  const now = new Date("2026-07-18T20:05:00.000Z");
  const left = validateWalmartBuyerPublicationEvidence(validInput(), now);
  const right = validateWalmartBuyerPublicationEvidence(
    {
      ...validInput(),
      rawEvidence: {
        observation: {
          http_status: 200,
          add_to_cart_enabled: true,
          availability: "IN_STOCK",
          page_rendered: true,
        },
        artifact: {
          ref: "capture:WALMART_BUYER_PDP:123456789",
          sha256: "a".repeat(64),
          kind: "PDP_DOCUMENT",
        },
        binding: {
          captured_at: CAPTURED_AT,
          source_url: SOURCE_URL,
          walmart_item_id: "123456789",
          sku: "PILOT-1",
        },
        source_kind: "WALMART_BUYER_PDP",
        schema_version: WALMART_BUYER_RAW_EVIDENCE_VERSION,
      },
    },
    now,
  );
  assert.equal(left.evidenceHash, right.evidenceHash);
  assert.equal(left.buyable, true);
  assert.equal(left.published, true);
});

test("buyer evidence rejects not-buyable and non-exact observations", () => {
  const now = new Date("2026-07-18T20:05:00.000Z");
  assert.throws(
    () =>
      validateWalmartBuyerPublicationEvidence(
        { ...validInput(), buyable: false },
        now,
      ),
    /buyable/,
  );
  assert.throws(
    () =>
      validateWalmartBuyerPublicationEvidence(
        { ...validInput(), exactSkuMatch: false },
        now,
      ),
    /exact SKU/,
  );
  assert.throws(
    () =>
      validateWalmartBuyerPublicationEvidence(
        {
          ...validInput(),
          sourceUrl: "https://www.walmart.com/ip/example-title/999999999",
        },
        now,
      ),
    /exact Walmart item ID/,
  );
});

test("all buyer evidence source kinds require their exact sealed artifact", () => {
  const now = new Date("2026-07-18T20:05:00.000Z");
  for (const sourceKind of [
    "WALMART_BUYER_PDP",
    "SEALED_BUYER_SNAPSHOT",
    "MANUAL_BROWSER_VERIFICATION",
  ] as const) {
    assert.equal(
      validateWalmartBuyerPublicationEvidence(validInput(sourceKind), now)
        .sourceKind,
      sourceKind,
    );
  }
  assert.throws(
    () =>
      validateWalmartBuyerPublicationEvidence(
        {
          ...validInput("SEALED_BUYER_SNAPSHOT"),
          rawEvidence: {
            ...rawEvidence("SEALED_BUYER_SNAPSHOT"),
            artifact: {
              ...rawEvidence("SEALED_BUYER_SNAPSHOT").artifact,
              kind: "PDP_DOCUMENT",
            },
          },
        },
        now,
      ),
    /artifact\.kind/,
  );
});

test("empty or unbound raw evidence cannot be promoted by true booleans", () => {
  const now = new Date("2026-07-18T20:05:00.000Z");
  assert.throws(
    () =>
      validateWalmartBuyerPublicationEvidence(
        { ...validInput(), rawEvidence: {} },
        now,
      ),
    /rawEvidence\.schema_version/,
  );
  for (const [field, value] of [
    ["sku", "OTHER-SKU"],
    ["walmart_item_id", "987654321"],
    ["source_url", "https://www.walmart.com/ip/987654321"],
    ["captured_at", "2026-07-18T20:01:00.000Z"],
  ] as const) {
    const raw = rawEvidence("WALMART_BUYER_PDP");
    assert.throws(
      () =>
        validateWalmartBuyerPublicationEvidence(
          {
            ...validInput(),
            rawEvidence: {
              ...raw,
              binding: { ...raw.binding, [field]: value },
            },
          },
          now,
        ),
      new RegExp(`binding\\.${field}`),
    );
  }
});

test("raw evidence must contain published and buyable observation signals", () => {
  const now = new Date("2026-07-18T20:05:00.000Z");
  const raw = rawEvidence("WALMART_BUYER_PDP");
  for (const observation of [
    { ...raw.observation, page_rendered: false },
    { ...raw.observation, availability: "OUT_OF_STOCK" },
    { ...raw.observation, add_to_cart_enabled: false },
    { ...raw.observation, http_status: 404 },
  ]) {
    assert.throws(() =>
      validateWalmartBuyerPublicationEvidence(
        {
          ...validInput(),
          rawEvidence: { ...raw, observation },
        },
        now,
      ),
    );
  }
  const manual = rawEvidence("MANUAL_BROWSER_VERIFICATION");
  assert.throws(
    () =>
      validateWalmartBuyerPublicationEvidence(
        {
          ...validInput("MANUAL_BROWSER_VERIFICATION"),
          rawEvidence: { ...manual, observer: "" },
        },
        now,
      ),
    /observer/,
  );
});

test("buyer evidence rejects timestamps materially after capture time", () => {
  assert.throws(
    () =>
      validateWalmartBuyerPublicationEvidence(
        validInput(),
        new Date("2026-07-18T19:00:00.000Z"),
      ),
    /future/,
  );
});

test("LIVE qualification requires buyer evidence within the 30-minute window", () => {
  const now = new Date("2026-07-18T20:00:00.000Z");
  assert.equal(
    walmartBuyerEvidenceNotBefore(
      new Date("2026-07-18T18:00:00.000Z"),
      now,
    ).toISOString(),
    "2026-07-18T19:30:00.000Z",
  );
  assert.equal(
    walmartBuyerEvidenceNotBefore(
      new Date("2026-07-18T19:50:00.000Z"),
      now,
    ).toISOString(),
    "2026-07-18T19:50:00.000Z",
  );
});

test("record verifies local bytes and returns the same immutable evidence row", async (t) => {
  const artifact = await localArtifactFixture(t);
  const input = validInputWithArtifact(
    pathToFileURL(artifact.path).href,
    artifact.sha256,
  );
  const validated = validateWalmartBuyerPublicationEvidence(
    input,
    new Date("2026-07-18T20:05:00.000Z"),
  );
  const existing = {
    id: "evidence-existing",
    channel_sku_id: validated.channelSkuId,
    submission_attempt_id: validated.submissionAttemptId,
    sku: validated.sku,
    walmart_item_id: validated.walmartItemId,
    source_url: validated.sourceUrl,
    source_kind: validated.sourceKind,
    captured_at: validated.capturedAt,
    exact_sku_match: true,
    exact_item_id_match: true,
    published: true,
    buyable: true,
    evidence_hash: validated.evidenceHash,
    raw_evidence: validated.rawEvidenceJson,
    created_at: new Date("2026-07-18T20:00:01.000Z"),
  };
  let createCalls = 0;
  const fakeTx = {
    channelSKU: {
      findUnique: async () => ({
        id: validated.channelSkuId,
        sku: validated.sku,
        channel: "WALMART",
      }),
    },
    marketplaceSubmissionAttempt: {
      findUnique: async () => ({
        id: validated.submissionAttemptId,
        channel_sku_id: validated.channelSkuId,
        marketplace: "WALMART",
        certification_sha256: EXPECTED_ATTEMPT_BINDING.certificationSha256,
        payload_hash: EXPECTED_ATTEMPT_BINDING.payloadSha256,
        seller_account_fingerprint_sha256:
          EXPECTED_ATTEMPT_BINDING.sellerAccountFingerprintSha256,
        idempotency_key: EXPECTED_ATTEMPT_BINDING.idempotencyKey,
        state: "BUYER_VERIFIED",
        claimed_at: new Date("2026-07-18T19:59:00.000Z"),
        requested_at: new Date("2026-07-18T19:59:10.000Z"),
        accepted_at: new Date("2026-07-18T19:59:20.000Z"),
      }),
      findFirst: async () => ({ id: validated.submissionAttemptId }),
    },
    walmartBuyerPublicationEvidence: {
      findUnique: async () => existing,
      create: async () => {
        createCalls += 1;
        return existing;
      },
    },
  };
  const mutablePrisma = prisma as unknown as {
    $transaction: (
      callback: (tx: typeof fakeTx) => Promise<unknown>,
    ) => Promise<unknown>;
  };
  const originalTransaction = mutablePrisma.$transaction;
  mutablePrisma.$transaction = async (callback) => callback(fakeTx);
  try {
    const result = await recordWalmartBuyerPublicationEvidence(
      input,
      EXPECTED_ATTEMPT_BINDING,
    );
    assert.equal(result.id, existing.id);
    assert.equal(createCalls, 0);
  } finally {
    mutablePrisma.$transaction = originalTransaction;
  }
});

test("record rejects missing, mismatched, symlink, relative, and non-file artifacts", async (t) => {
  const artifact = await localArtifactFixture(t);
  const symlinkPath = join(artifact.directory, "buyer-pdp-link.png");
  await symlink(artifact.path, symlinkPath);

  let transactionCalls = 0;
  const mutablePrisma = prisma as unknown as {
    $transaction: (callback: (tx: never) => Promise<unknown>) => Promise<unknown>;
  };
  const originalTransaction = mutablePrisma.$transaction;
  mutablePrisma.$transaction = async () => {
    transactionCalls += 1;
    throw new Error("database transaction must not run for invalid artifacts");
  };
  try {
    await assert.rejects(
      recordWalmartBuyerPublicationEvidence(
        validInputWithArtifact(
          join(artifact.directory, "missing.png"),
          artifact.sha256,
        ),
        EXPECTED_ATTEMPT_BINDING,
      ),
      /single-link regular file/,
    );
    await assert.rejects(
      recordWalmartBuyerPublicationEvidence(
        validInputWithArtifact(artifact.path, "0".repeat(64)),
        EXPECTED_ATTEMPT_BINDING,
      ),
      /does not match the local artifact bytes/,
    );
    await assert.rejects(
      recordWalmartBuyerPublicationEvidence(
        validInputWithArtifact(symlinkPath, artifact.sha256),
        EXPECTED_ATTEMPT_BINDING,
      ),
      /single-link regular file|cannot be opened safely/,
    );
    await assert.rejects(
      recordWalmartBuyerPublicationEvidence(
        validInputWithArtifact("relative/buyer-pdp.png", artifact.sha256),
        EXPECTED_ATTEMPT_BINDING,
      ),
      /must be an absolute local path or file URL/,
    );
    await assert.rejects(
      recordWalmartBuyerPublicationEvidence(
        validInputWithArtifact(artifact.directory, artifact.sha256),
        EXPECTED_ATTEMPT_BINDING,
      ),
      /single-link regular file/,
    );
    assert.equal(transactionCalls, 0);
  } finally {
    mutablePrisma.$transaction = originalTransaction;
  }
});
