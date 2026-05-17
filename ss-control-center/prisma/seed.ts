/**
 * Prisma seed orchestrator — runs all Phase 1 Bundle Factory seeds.
 *
 * Invoked by `npx prisma db seed` once package.json#prisma.seed points at
 * this file. Each individual seeder is idempotent (upsert / find-then-
 * update), so re-running is safe.
 */

import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { resolve } from "node:path";

import { seedStoreRegistry } from "./seed/store-registry";
import { seedBrandAccounts } from "./seed/brand-account";
import {
  seedMarketplaceRules,
  MARKETPLACE_RULE_SEED_COUNT,
} from "./seed/marketplace-rules-seed";
import {
  seedGtinExemptions,
  GTIN_EXEMPTION_SEED_COUNT,
} from "./seed/gtin-exemption-init";
import { seedUpcPool } from "./seed/upc-pool-import";

function clean(v: string | undefined): string | undefined {
  if (!v) return v;
  return v.trim().replace(/^['"]|['"]$/g, "");
}

/** Resolve any file: URL to an absolute path so libsql doesn't pick the
 *  wrong dev.db when invoked from Prisma CLI (which can shift cwd). */
function absolutiseFileUrl(url: string): string {
  if (!url.startsWith("file:")) return url;
  const stripped = url.replace(/^file:/, "");
  if (stripped.startsWith("/")) return url; // already absolute
  return `file:${resolve(process.cwd(), stripped)}`;
}

/** Build a PrismaClient. By default this seeder targets the LOCAL dev.db
 *  — even if TURSO_DATABASE_URL is present in .env — to avoid accidentally
 *  writing seed data to production. To explicitly target Turso, set
 *  `SEED_TARGET=turso` (the Bundle Factory Phase 1 Turso migration script
 *  must be applied first via scripts/turso-migrate-bundle-factory-phase-1.mjs). */
function makePrisma(): PrismaClient {
  const seedTarget = (process.env.SEED_TARGET ?? "local").toLowerCase();
  const tursoUrl = clean(process.env.TURSO_DATABASE_URL);
  const tursoToken = clean(process.env.TURSO_AUTH_TOKEN);
  const databaseUrl = clean(process.env.DATABASE_URL);

  if (seedTarget === "turso") {
    if (!tursoUrl || !tursoToken) {
      throw new Error("SEED_TARGET=turso requires TURSO_DATABASE_URL + TURSO_AUTH_TOKEN");
    }
    process.stderr.write(`  · target: TURSO ${tursoUrl}\n`);
    return new PrismaClient({
      adapter: new PrismaLibSql({ url: tursoUrl, authToken: tursoToken }),
    });
  }

  // Local seeding — never use Turso even if env vars are present.
  let url: string;
  if (databaseUrl) {
    url = absolutiseFileUrl(databaseUrl);
  } else {
    url = `file:${resolve(process.cwd(), "dev.db")}`;
  }
  process.stderr.write(`  · target: LOCAL ${url}\n`);
  return new PrismaClient({ adapter: new PrismaLibSql({ url }) });
}

async function main() {
  const prisma = makePrisma();
  const t0 = Date.now();
  console.log("\n🌱 Bundle Factory Phase 1 — seeding\n");

  console.log("[1/5] StoreRegistry");
  const stores = await seedStoreRegistry(prisma);
  console.log(`  · ${stores} stores upserted`);

  console.log("\n[2/5] BrandAccount");
  const accounts = await seedBrandAccounts(prisma);
  console.log(`  · ${accounts} brand accounts upserted`);

  console.log("\n[3/5] UPCPool (Active Listings Report import)");
  const upcs = await seedUpcPool(prisma);
  // upcs may be 0 if the report isn't present — handled gracefully inside
  // seedUpcPool with a TODO log message.

  console.log("\n[4/5] MarketplaceRule");
  const rules = await seedMarketplaceRules(prisma);
  console.log(
    `  · ${rules}/${MARKETPLACE_RULE_SEED_COUNT} marketplace rules upserted`
  );

  console.log("\n[5/5] GTINExemption");
  const exemptions = await seedGtinExemptions(prisma);
  console.log(
    `  · ${exemptions}/${GTIN_EXEMPTION_SEED_COUNT} exemption tracker rows upserted`
  );

  const ms = Date.now() - t0;
  console.log(`\n✓ Seed complete in ${ms}ms`);
  console.log(
    `  stores=${stores}  accounts=${accounts}  upcs=${upcs}  rules=${rules}  exemptions=${exemptions}\n`
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("\n✗ Seed failed:", e);
  process.exit(1);
});
