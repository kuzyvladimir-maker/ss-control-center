import assert from "node:assert/strict";
import test from "node:test";

import {
  main,
  parseWalmartItemReportReissueV2FrozenExecutorCli,
} from "../walmart-item-report-reissue-v2-frozen-executor.mjs";

const SHA = "a".repeat(64);
const BASE = "/private/tmp/walmart-item-reissue-v2-fixture";
const EXACT = [
  "execute-create",
  `--engine-manifest=${BASE}/release/engine-release.json`,
  `--expect-engine-manifest-sha256=${SHA}`,
  `--expect-frozen-bundle-sha256=${SHA}`,
  `--source-evidence=${BASE}/evidence/source.json`,
  `--expect-source-evidence-sha256=${SHA}`,
  `--owner-disposition=${BASE}/owner/disposition.json`,
  `--expect-owner-disposition-sha256=${SHA}`,
  `--ledger-state-directory=${BASE}/ledger`,
  "--store-index=1",
];

test("frozen executor accepts only the exact ordered one-shot argv", () => {
  const parsed = parseWalmartItemReportReissueV2FrozenExecutorCli(EXACT);
  assert.equal(parsed.store_index, 1);
  assert.equal(parsed.expected_frozen_bundle_sha256, SHA);
  assert.throws(
    () => parseWalmartItemReportReissueV2FrozenExecutorCli([
      EXACT[0], EXACT[2], EXACT[1], ...EXACT.slice(3),
    ]),
    /argv names\/order differ/,
  );
  assert.throws(
    () => parseWalmartItemReportReissueV2FrozenExecutorCli([...EXACT, "--extra=value"]),
    /exact frozen execute-create argv/,
  );
  assert.throws(
    () => parseWalmartItemReportReissueV2FrozenExecutorCli([
      ...EXACT.slice(0, -1), "--store-index=0",
    ]),
    /positive safe integer/,
  );
});

test("mutable/direct-loaded entrypoint fails before credentials, fetch, or Walmart", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    main(EXACT, {
      env: {},
      fetch_impl: async () => {
        fetchCalls += 1;
        throw new Error("must not fetch");
      },
      stdout: () => {},
    }),
    (error) => new Set([
      "INVALID_ARTIFACT_CUSTODY",
      "LOADED_CODE_BINDING_MISMATCH",
    ]).has(error?.code),
  );
  assert.equal(fetchCalls, 0);
});
