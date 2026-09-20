#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

import { createClient } from "@libsql/client";

import {
  inspectWalmartListingIntegrityControlMigration,
  installWalmartListingIntegrityControlMigration,
} from "../src/lib/walmart/listing-integrity-control-installer.ts";

function clean(value: string | undefined): string | undefined {
  return value?.trim().replace(/^['"]|['"]$/gu, "");
}

async function main() {
  const command = process.argv[2] ?? "preflight";
  if (command !== "preflight" && command !== "apply") {
    throw new Error("usage: install-walmart-listing-integrity-control-stage-a.ts preflight|apply");
  }
  const url = clean(process.env.TURSO_DATABASE_URL);
  const authToken = clean(process.env.TURSO_AUTH_TOKEN);
  if (!url || !authToken) throw new Error("Turso runtime credentials are unavailable");
  const migrationPath = path.join(
    process.cwd(),
    "prisma",
    "migrations",
    "20260801172000_walmart_listing_integrity_control_plane_stage_a",
    "migration.sql",
  );
  const migrationSql = await readFile(migrationPath, "utf8");
  const client = createClient({ url, authToken });
  try {
    const result = command === "preflight"
      ? await inspectWalmartListingIntegrityControlMigration({ client, migration_sql: migrationSql })
      : await installWalmartListingIntegrityControlMigration({
        client,
        migration_sql: migrationSql,
        now: new Date().toISOString(),
      });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    client.close();
  }
}

void main();
