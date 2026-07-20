import assert from "node:assert/strict";
import test from "node:test";

import {
  WalmartNewSkuCatalogActivationCliError,
  parseWalmartNewSkuCatalogActivationCli,
  runWalmartNewSkuCatalogActivationCli,
} from "../walmart-new-sku-catalog-activation";

test("owner-only catalog PLAN CLI accepts only exact bounded inputs", () => {
  const parsed = parseWalmartNewSkuCatalogActivationCli([
    "plan",
    "--url", "file:/tmp/catalog.sqlite",
    "--environment", "production",
    "--store-index", "1",
    "--source", "/tmp/item-report-catalog-source.json",
    "--source-sha256", "a".repeat(64),
    "--expires-at", "2026-07-19T12:00:00.000Z",
    "--out", "/tmp/catalog-plan",
  ]);
  assert.equal(parsed.command, "plan");
  assert.equal(parsed.storeIndex, 1);
  assert.equal(parsed.allowRemote, false);
  assert.equal(parsed.expiresAt?.toISOString(), "2026-07-19T12:00:00.000Z");
});

test("CLI keeps source flags out of APPLY and pilot store fixed to one", () => {
  assert.throws(
    () => parseWalmartNewSkuCatalogActivationCli([
      "apply",
      "--url", "file:/tmp/catalog.sqlite",
      "--environment", "production",
      "--source", "/tmp/source.json",
    ]),
    (error: unknown) => {
      assert.ok(error instanceof WalmartNewSkuCatalogActivationCliError);
      assert.equal(error.code, "CLI_FLAG_MODE_FORBIDDEN");
      return true;
    },
  );
  assert.throws(
    () => parseWalmartNewSkuCatalogActivationCli([
      "plan",
      "--store-index", "2",
    ]),
    (error: unknown) => {
      assert.ok(error instanceof WalmartNewSkuCatalogActivationCliError);
      assert.equal(error.code, "CLI_STORE_INVALID");
      return true;
    },
  );
});

test("help identifies owner/Codex-only scope and exact network boundary", async () => {
  const result = await runWalmartNewSkuCatalogActivationCli(["--help"]);
  assert.match(String(result.help), /OWNER\/CODEX ONLY/);
  assert.match(String(result.help), /no Walmart\/provider API calls/);
  assert.match(String(result.help), /Remote plan\/apply access only the explicitly selected database/);
});
