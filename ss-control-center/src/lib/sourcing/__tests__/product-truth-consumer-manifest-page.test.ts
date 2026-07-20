import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createClient, type Client, type InStatement, type ResultSet } from "@libsql/client";

import {
  ProductTruthConsumerGatewayError,
  readProductTruthConsumerManifestScopePage,
} from "../product-truth-consumer-gateway";

const MANIFEST = "a".repeat(64);

const columns: Record<string, string[]> = {
  ProductTruthListingScope: [
    "listingKey", "keyVersion", "channel", "storeIndex", "sku",
    "registrationKind", "manifestSchemaVersion", "manifestSha256",
    "manifestAsOf", "ownerDecisionId", "sourceReportId",
    "sourceContentSha256", "sourceCapturedAt", "createdAt",
  ],
  SkuCostListingScopeLink: [
    "skuCostId", "listingKey", "linkVersion", "createdAt",
  ],
};

function result(rows: Record<string, unknown>[]): ResultSet {
  return { rows } as unknown as ResultSet;
}

function fakeClient(input: {
  rows: Record<string, unknown>[];
  finalReads?: { count: number };
}): Client {
  return {
    execute: async (statement: InStatement) => {
      const sql = typeof statement === "string" ? statement : statement.sql;
      const args = typeof statement === "string" || !Array.isArray(statement.args)
        ? []
        : [...statement.args];
      const tableInfo = sql.match(/^PRAGMA table_info\("([^"]+)"\)$/);
      if (tableInfo) {
        return result((columns[tableInfo[1]] ?? []).map((name) => ({ name })));
      }
      if (sql.includes("FROM sqlite_master")) return result([{ present: 1 }]);
      const foreignKeys = sql.match(/^PRAGMA foreign_key_list\("([^"]+)"\)$/);
      if (foreignKeys) {
        return result(foreignKeys[1] === "SkuCostListingScopeLink" ? [
          {
            from: "skuCostId", table: "SkuCost", to: "id",
            on_delete: "RESTRICT", on_update: "RESTRICT",
          },
          {
            from: "listingKey", table: "ProductTruthListingScope", to: "listingKey",
            on_delete: "RESTRICT", on_update: "RESTRICT",
          },
        ] : []);
      }
      if (sql.includes("FROM ProductTruthListingScope")) {
        if (input.finalReads) input.finalReads.count += 1;
        if (sql.includes("GROUP BY channel,storeIndex")) {
          const manifest = String(args[0]);
          const grouped = new Map<string, {
            channel: unknown; storeIndex: unknown; scopeCount: number;
          }>();
          for (const row of input.rows.filter((candidate) =>
            candidate.manifestSha256 === manifest)) {
            const key = `${row.channel}:${row.storeIndex}`;
            const group = grouped.get(key) ?? {
              channel: row.channel,
              storeIndex: row.storeIndex,
              scopeCount: 0,
            };
            group.scopeCount += 1;
            grouped.set(key, group);
          }
          return result([...grouped.values()]);
        }
        if (sql.includes("WHERE listingKey=?")) {
          const cursor = String(args[0]);
          const manifest = String(args[1]);
          const channel = String(args[2]);
          const storeIndex = Number(args[3]);
          return result(input.rows.filter((row) =>
            row.listingKey === cursor
            && row.manifestSha256 === manifest
            && row.channel === channel
            && row.storeIndex === storeIndex
          ));
        }
        const manifest = String(args[0]);
        const channel = String(args[1]);
        const storeIndex = Number(args[2]);
        const cursor = args[3] === null ? null : String(args[3]);
        const limit = Number(args[5]);
        return result(input.rows.filter((row) =>
          row.manifestSha256 === manifest
          && row.channel === channel
          && row.storeIndex === storeIndex
          && (cursor === null || String(row.listingKey) > cursor)
        ).sort((left, right) =>
          String(left.listingKey).localeCompare(String(right.listingKey), "en-US"))
        .slice(0, limit));
      }
      throw new Error(`Unexpected SQL in fake client: ${sql}`);
    },
  } as unknown as Client;
}

function scopeRow(sku: string, overrides: Record<string, unknown> = {}) {
  return {
    listingKey: `amazon:1:${sku}`,
    keyVersion: "product-truth-listing-key/1.0.0",
    channel: "amazon",
    storeIndex: 1,
    sku,
    registrationKind: "AUTHORITATIVE_PHASE1_MANIFEST",
    manifestSchemaVersion: "phase1-authoritative-scope-manifest/v3",
    manifestSha256: MANIFEST,
    ...overrides,
  };
}

function code(error: unknown): string | undefined {
  return error instanceof ProductTruthConsumerGatewayError ? error.code : undefined;
}

test("manifest registry pagination is deterministic, bounded, and cursor exact", async () => {
  const reads = { count: 0 };
  const db = fakeClient({
    rows: [scopeRow("SKU-C"), scopeRow("SKU-A"), scopeRow("SKU-B")],
    finalReads: reads,
  });
  const first = await readProductTruthConsumerManifestScopePage(db, {
    authoritativeManifestSha256: MANIFEST,
    channel: "amazon",
    storeIndex: 1,
    limit: 2,
    maximumPageSize: 100,
  });
  assert.deepEqual(first.scopes.map((scope) => scope.sku), ["SKU-A", "SKU-B"]);
  assert.deepEqual(first.manifestInventory, {
    scopeCount: 3,
    partitions: [{ channel: "amazon", storeIndex: 1, scopeCount: 3 }],
  });
  assert.equal(first.nextCursor, "amazon:1:SKU-B");
  assert.equal(first.claims.databaseWrites, false);

  const second = await readProductTruthConsumerManifestScopePage(db, {
    authoritativeManifestSha256: MANIFEST,
    channel: "amazon",
    storeIndex: 1,
    cursor: first.nextCursor,
    limit: 2,
    maximumPageSize: 100,
  });
  assert.deepEqual(second.scopes.map((scope) => scope.sku), ["SKU-C"]);
  assert.equal(second.nextCursor, null);
  assert.equal(reads.count, 5);
});

test("cursor, manifest and page-size drift fail before an unsafe denominator read", async () => {
  const reads = { count: 0 };
  const db = fakeClient({ rows: [scopeRow("SKU-A")], finalReads: reads });
  await assert.rejects(
    () => readProductTruthConsumerManifestScopePage(db, {
      authoritativeManifestSha256: MANIFEST,
      channel: "amazon",
      storeIndex: 1,
      cursor: "amazon:3:SKU-A",
      limit: 1,
      maximumPageSize: 100,
    }),
    (error) => code(error) === "CONSUMER_GATEWAY_CURSOR_INVALID",
  );
  await assert.rejects(
    () => readProductTruthConsumerManifestScopePage(db, {
      authoritativeManifestSha256: MANIFEST.toUpperCase(),
      channel: "amazon",
      storeIndex: 1,
      limit: 1,
      maximumPageSize: 100,
    }),
    (error) => code(error) === "CONSUMER_GATEWAY_INPUT_INVALID",
  );
  await assert.rejects(
    () => readProductTruthConsumerManifestScopePage(db, {
      authoritativeManifestSha256: MANIFEST,
      channel: "amazon",
      storeIndex: 1,
      limit: 101,
      maximumPageSize: 100,
    }),
    (error) => code(error) === "CONSUMER_GATEWAY_INPUT_INVALID",
  );
  assert.equal(reads.count, 0);
});

test("a canonical-looking cursor must exist in the exact activated manifest", async () => {
  const reads = { count: 0 };
  const db = fakeClient({ rows: [scopeRow("SKU-A")], finalReads: reads });
  await assert.rejects(
    () => readProductTruthConsumerManifestScopePage(db, {
      authoritativeManifestSha256: MANIFEST,
      channel: "amazon",
      storeIndex: 1,
      cursor: "amazon:1:SKU-Z",
      limit: 1,
      maximumPageSize: 100,
    }),
    (error) => code(error) === "CONSUMER_GATEWAY_CURSOR_INVALID",
  );
  assert.equal(reads.count, 2);

  const otherManifest = fakeClient({
    rows: [
      scopeRow("SKU-A", { manifestSha256: "b".repeat(64) }),
      scopeRow("SKU-B"),
    ],
  });
  await assert.rejects(
    () => readProductTruthConsumerManifestScopePage(otherManifest, {
      authoritativeManifestSha256: MANIFEST,
      channel: "amazon",
      storeIndex: 1,
      cursor: "amazon:1:SKU-A",
      limit: 1,
      maximumPageSize: 100,
    }),
    (error) => code(error) === "CONSUMER_GATEWAY_CURSOR_INVALID",
  );
});

test("an unregistered activated manifest blocks instead of returning PAGE_EMPTY", async () => {
  const db = fakeClient({ rows: [scopeRow("SKU-A")] });
  await assert.rejects(
    () => readProductTruthConsumerManifestScopePage(db, {
      authoritativeManifestSha256: "b".repeat(64),
      channel: "amazon",
      storeIndex: 1,
      limit: 1,
      maximumPageSize: 100,
    }),
    (error) => code(error) === "CONSUMER_GATEWAY_MANIFEST_NOT_REGISTERED",
  );
});

test("an absent channel/store partition blocks instead of impersonating an empty store", async () => {
  const db = fakeClient({ rows: [scopeRow("SKU-A")] });
  await assert.rejects(
    () => readProductTruthConsumerManifestScopePage(db, {
      authoritativeManifestSha256: MANIFEST,
      channel: "amazon",
      storeIndex: 2,
      limit: 1,
      maximumPageSize: 100,
    }),
    (error) => code(error) === "CONSUMER_GATEWAY_PARTITION_NOT_REGISTERED",
  );
});

test("a registry row that contradicts immutable manifest provenance is rejected", async () => {
  const db = fakeClient({
    rows: [scopeRow("SKU-A", { registrationKind: "LEGACY_IMPORT" })],
  });
  await assert.rejects(
    () => readProductTruthConsumerManifestScopePage(db, {
      authoritativeManifestSha256: MANIFEST,
      channel: "amazon",
      storeIndex: 1,
      limit: 1,
      maximumPageSize: 100,
    }),
    (error) => code(error) === "CONSUMER_GATEWAY_RESULT_INVALID",
  );
});

test("manifest page executes against the real immutable listing-scope schema", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    await db.execute(`PRAGMA foreign_keys=ON`);
    await db.execute(`CREATE TABLE SkuCost (
      id TEXT PRIMARY KEY,
      sku TEXT NOT NULL,
      source TEXT NOT NULL,
      evidenceJson TEXT,
      createdAt DATETIME NOT NULL
    )`);
    const migration = new URL(
      "../../../../prisma/migrations/20260719002000_product_truth_listing_scope/migration.sql",
      import.meta.url,
    );
    await db.executeMultiple(await readFile(migration, "utf8"));
    for (const sku of ["SKU-C", "SKU-A", "SKU-B"]) {
      await db.execute({
        sql: `INSERT INTO ProductTruthListingScope (
          listingKey,keyVersion,channel,storeIndex,sku,registrationKind,
          manifestSchemaVersion,manifestSha256,manifestAsOf,ownerDecisionId,
          sourceReportId,sourceContentSha256,sourceCapturedAt,createdAt
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [
          `amazon:1:${sku}`,
          "product-truth-listing-key/1.0.0",
          "amazon",
          1,
          sku,
          "AUTHORITATIVE_PHASE1_MANIFEST",
          "phase1-authoritative-scope-manifest/v3",
          MANIFEST,
          "2026-07-19T12:00:00.000Z",
          `owner-${sku}`,
          "report-amazon-1",
          "b".repeat(64),
          "2026-07-19T11:00:00.000Z",
          "2026-07-19T12:00:00.000Z",
        ],
      });
    }
    const page = await readProductTruthConsumerManifestScopePage(db, {
      authoritativeManifestSha256: MANIFEST,
      channel: "amazon",
      storeIndex: 1,
      limit: 2,
      maximumPageSize: 2,
    });
    assert.deepEqual(page.scopes.map((scope) => scope.sku), ["SKU-A", "SKU-B"]);
    assert.equal(page.nextCursor, "amazon:1:SKU-B");
  } finally {
    db.close();
  }
});
