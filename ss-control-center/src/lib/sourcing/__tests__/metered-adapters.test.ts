import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { classifyTemperatureLLM } from "../donor-catalog";
import { identifyImageViaGemini } from "../gemini-vision";
import {
  MeteredProviderBlockedError,
  encodeMeteredRunPermit,
  expectedMeteredRunConfirmation,
  resetMeteredCallUsageForTests,
  type MeteredRunPermit,
} from "../metered-call-guard";
import { MeteredBudgetLedgerUnavailableError } from "../metered-provider-call";
import { oxylabsWalmartSearch } from "../oxylabs-fetch";
import { bluecartWalmartSearch, unwrangleSearch } from "../retail-fetch";
import { askVisionJson, visionFreeOnly } from "../vision";

const ENV_KEYS = [
  "BLUECART_API_KEY",
  "UNWRANGLE_API_KEY",
  "OXYLABS_USERNAME",
  "OXYLABS_PASSWORD",
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "SS_METERED_RUN_PERMIT",
  "SS_METERED_RUN_CONFIRM",
  "SS_VISION_PROVIDER",
  "SS_VISION_FREE_ONLY",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  "DATABASE_URL",
] as const;

const originalEnv = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;
let fetchCalls = 0;

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv.set(key, process.env[key]);
  process.env.BLUECART_API_KEY = "test-bluecart";
  process.env.UNWRANGLE_API_KEY = "test-unwrangle";
  process.env.OXYLABS_USERNAME = "test-oxylabs-user";
  process.env.OXYLABS_PASSWORD = "test-oxylabs-pass";
  process.env.GEMINI_API_KEY = "test-gemini";
  process.env.ANTHROPIC_API_KEY = "test-anthropic";
  delete process.env.SS_METERED_RUN_PERMIT;
  delete process.env.SS_METERED_RUN_CONFIRM;
  delete process.env.SS_VISION_PROVIDER;
  delete process.env.SS_VISION_FREE_ONLY;
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  delete process.env.DATABASE_URL;
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("network must not be reached");
  }) as typeof fetch;
  resetMeteredCallUsageForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
  resetMeteredCallUsageForTests();
});

async function assertBlocked(run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error) => error instanceof MeteredProviderBlockedError);
  assert.equal(fetchCalls, 0, "guard must fail before fetch");
}

test("BlueCart and Unwrangle adapters fail before network without a permit", async () => {
  await assertBlocked(() => bluecartWalmartSearch("test cereal"));
  await assertBlocked(() => unwrangleSearch("target", "test cereal"));
});

test("Oxylabs and Gemini adapters fail before network without a permit", async () => {
  await assertBlocked(() => oxylabsWalmartSearch("test cereal"));
  await assertBlocked(() => identifyImageViaGemini(["/9j/test"], "identify"));
});

test("high-level paid Anthropic vision preserves the permit denial", async () => {
  process.env.SS_VISION_PROVIDER = "anthropic";
  process.env.SS_VISION_FREE_ONLY = "0";
  await assertBlocked(() => askVisionJson(["https://images.example.test/product.jpg"], "inspect"));
});

test("a valid permit without a configured ledger still performs zero fetches", async () => {
  const now = Date.now();
  const permit: MeteredRunPermit = {
    version: 1,
    runId: "adapter-ledger-missing",
    approvalId: "owner-adapter-ledger-missing",
    approvedBy: "owner",
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
    providers: {
      bluecart: { operations: ["search"], maxCalls: 1 },
    },
  };
  process.env.SS_METERED_RUN_PERMIT = encodeMeteredRunPermit(permit);
  process.env.SS_METERED_RUN_CONFIRM = expectedMeteredRunConfirmation(permit);

  await assert.rejects(
    () => bluecartWalmartSearch("test cereal"),
    MeteredBudgetLedgerUnavailableError,
  );
  assert.equal(fetchCalls, 0, "ledger configuration must fail before fetch");
});

test("direct Anthropic classifier falls back deterministically without SDK spend", async () => {
  const result = await classifyTemperatureLLM([{ title: "Shelf Stable Canned Corn" }]);
  assert.deepEqual(result, ["Dry"]);
  assert.equal(fetchCalls, 0);
});

test("vision is subscription-only by default and needs an explicit paid opt-out", () => {
  assert.equal(visionFreeOnly({}), true);
  assert.equal(visionFreeOnly({ SS_VISION_FREE_ONLY: "1" }), true);
  assert.equal(visionFreeOnly({ SS_VISION_FREE_ONLY: "0" }), false);
});
