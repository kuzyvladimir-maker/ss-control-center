import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { NextRequest } from "next/server";

import { GET } from "../../../app/api/economics/product-truth-shadow/route";
import {
  buildProductTruthConsumerActivation,
  expectedProductTruthConsumerActivationConfirmation,
  productTruthConsumerActivationSha256,
} from "../../sourcing/product-truth-consumer-activation";
import { PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV } from
  "../../sourcing/product-truth-consumer-runtime";
import { resolveProductTruthDatabaseTarget } from
  "../../sourcing/product-truth-database-target";

test("OFF endpoint is no-store and reaches no configured Product Truth database", async () => {
  const saved = new Map<string, string | undefined>();
  for (const name of Object.values(PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV)) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  try {
    const response = await GET(new NextRequest(
      "http://localhost/api/economics/product-truth-shadow?marketplace=amazon&store=1",
    ));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.deepEqual(body, {
      ok: true,
      schemaVersion: "product-truth-unit-economics-runtime/1.0.0",
      status: "OFF",
      reason: "NO_OWNER_ACTIVATION_CONFIGURED",
      claims: {
        databaseReads: false,
        databaseWrites: false,
        providerCalls: false,
        marketplaceMutations: false,
      },
    });
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("shadow endpoint has a static read-only closure and legacy endpoint stays separate", async () => {
  const routeUrl = new URL(
    "../../../app/api/economics/product-truth-shadow/route.ts",
    import.meta.url,
  );
  const route = await readFile(routeUrl, "utf8");
  const handler = route.slice(route.indexOf("export async function GET"));
  assert.ok(
    handler.indexOf("loadProductTruthUnitEconomicsRuntime")
      < handler.indexOf("openProductTruthConsumerReadClient"),
  );
  assert.ok(
    handler.indexOf("authorized(request, runtime.accessToken)")
      < handler.indexOf("openProductTruthConsumerReadClient"),
  );
  assert.doesNotMatch(route, /from "@\/lib\/prisma"|getCogsForSkus/);
  assert.match(route, /transaction = await db\.transaction\("read"\)/);
  assert.match(route, /readLegacyCogsForProductTruthShadow\(transaction/);
  assert.match(route, /timingSafeEqual/);
  assert.match(route, /cache-control", "no-store"/);
  assert.doesNotMatch(
    route,
    /\bfetch\s*\(|anthropic|openai|spApi|runDistribution|submitTo|patchListing|reprice/i,
  );

  const legacyRoute = await readFile(new URL(
    "../../../app/api/economics/skus/route.ts",
    import.meta.url,
  ), "utf8");
  assert.doesNotMatch(
    legacyRoute,
    /product-truth-shadow|ProductTruthUnitEconomics|readProductTruthConsumerBatch/,
  );
});

test("active SHADOW rejects an unauthenticated caller before opening its database", async () => {
  const names = [
    ...Object.values(PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV),
    "DATABASE_URL",
    "TURSO_DATABASE_URL",
    "TURSO_AUTH_TOKEN",
  ];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  const databaseUrl = "file::memory:";
  const target = resolveProductTruthDatabaseTarget(databaseUrl).fingerprint;
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const activation = buildProductTruthConsumerActivation({
    approvalId: "owner-unit-economics-route-auth",
    mode: "SHADOW",
    authoritativeManifestSha256: "a".repeat(64),
    databaseTargetFingerprint: target,
    consumers: ["UNIT_ECONOMICS"],
    issuedAt,
    expiresAt,
    maxPriceAgeMs: 86_400_000,
    maxListingsPerBatch: 100,
  });
  const digest = productTruthConsumerActivationSha256(activation);
  try {
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    process.env.DATABASE_URL = databaseUrl;
    process.env[PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.enabled] = "1";
    process.env[PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.activationJson] =
      JSON.stringify(activation);
    process.env[PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.activationSha256] = digest;
    process.env[PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.confirmation] =
      expectedProductTruthConsumerActivationConfirmation(
        digest,
        activation.ownerApproval.approvalId,
        activation.mode,
      );
    process.env[PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.manifestSha256] =
      activation.authoritativeManifestSha256;
    process.env[PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.databaseTargetFingerprint] = target;
    process.env[PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.maxPriceAgeMs] = "86400000";
    process.env[PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.maxListingsPerBatch] = "100";
    process.env[PRODUCT_TRUTH_UNIT_ECONOMICS_RUNTIME_ENV.accessToken] =
      "unit-economics-shadow-route-access-token-0001";

    const response = await GET(new NextRequest(
      "http://localhost/api/economics/product-truth-shadow?marketplace=amazon&store=1",
    ));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { ok: false, status: "UNAUTHORIZED" });
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
