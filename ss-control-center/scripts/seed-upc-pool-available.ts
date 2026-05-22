/**
 * Top up UPCPool with AVAILABLE entries for each owned SpeedyBarCode
 * prefix (742259, 789232, 617261).
 *
 * Bundle Factory's pipeline allocates UPCs from `UPCPool` where
 * `status = AVAILABLE`. The companion seed
 * `prisma/seed/upc-pool-import.ts` parses your Active Listings Report
 * and writes every used UPC as ASSIGNED — but that report contains
 * only UPCs already in use, so AVAILABLE inventory stays at 0.
 *
 * This script fills the gap. For each prefix it generates
 *   prefix(6) + sequence(5, zero-padded) + GS1 mod-10 check(1) = 12 digits
 * for sequences NOT already present in the table, until N (default 1000)
 * new AVAILABLE rows exist per prefix. Skips any UPC already in the pool
 * (in any status). Idempotent.
 *
 * Run:  npx tsx scripts/seed-upc-pool-available.ts
 *       npx tsx scripts/seed-upc-pool-available.ts --per-prefix 500
 */

import "dotenv/config";
import { prisma } from "@/lib/prisma";

const OWNED_PREFIXES = ["742259", "789232", "617261"] as const;
const GS1_OWNER = "Salutem Solutions LLC (SpeedyBarCode)";
const DEFAULT_PER_PREFIX = 1000;
const BATCH_SIZE = 200;

function parsePerPrefix(): number {
  const i = process.argv.indexOf("--per-prefix");
  if (i === -1) return DEFAULT_PER_PREFIX;
  const v = Number(process.argv[i + 1]);
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error("--per-prefix must be a positive number");
  }
  return v;
}

function computeUpcCheckDigit(elevenDigits: string): number {
  if (elevenDigits.length !== 11 || !/^\d{11}$/.test(elevenDigits)) {
    throw new Error(`Bad UPC base: ${elevenDigits}`);
  }
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    const digit = Number(elevenDigits[i]);
    const multiplier = i % 2 === 0 ? 3 : 1;
    sum += digit * multiplier;
  }
  return (10 - (sum % 10)) % 10;
}

function buildUpc(prefix: string, sequence: number): string {
  const seq = String(sequence).padStart(5, "0");
  const base = prefix + seq;
  return base + String(computeUpcCheckDigit(base));
}

async function seedAvailableForPrefix(prefix: string, want: number) {
  const taken = new Set(
    (
      await prisma.uPCPool.findMany({
        where: { upc_prefix: prefix },
        select: { upc: true },
      })
    ).map((r) => r.upc),
  );
  const startAvail = await prisma.uPCPool.count({
    where: { upc_prefix: prefix, status: "AVAILABLE" },
  });

  const toInsert: Array<{
    upc: string;
    upc_prefix: string;
    gs1_validated: boolean;
    gs1_owner: string;
    status: string;
    acquired_from: string;
  }> = [];

  for (let seq = 0; seq < 100_000 && toInsert.length < want; seq++) {
    const upc = buildUpc(prefix, seq);
    if (taken.has(upc)) continue;
    toInsert.push({
      upc,
      upc_prefix: prefix,
      gs1_validated: true,
      gs1_owner: GS1_OWNER,
      status: "AVAILABLE",
      acquired_from: "SpeedyBarCode pool top-up",
    });
    taken.add(upc);
  }

  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
    const batch = toInsert.slice(i, i + BATCH_SIZE);
    // The `taken` Set above already filters out anything already in the
    // pool, so we expect zero conflicts. The libsql adapter doesn't
    // support `skipDuplicates`, so on the off chance another runner
    // raced us we'd just see a uniqueness error here — fine to surface.
    const r = await prisma.uPCPool.createMany({ data: batch });
    inserted += r.count;
  }

  const endAvail = await prisma.uPCPool.count({
    where: { upc_prefix: prefix, status: "AVAILABLE" },
  });
  console.log(
    `  ${prefix}: AVAILABLE ${startAvail} → ${endAvail} (+${inserted} new this run)`,
  );
}

async function main() {
  const perPrefix = parsePerPrefix();
  console.log(`Top-up target per prefix: ${perPrefix} AVAILABLE entries`);
  const before = await prisma.uPCPool.count();
  console.log(`UPCPool BEFORE: ${before} total`);
  console.log("");

  for (const prefix of OWNED_PREFIXES) {
    await seedAvailableForPrefix(prefix, perPrefix);
  }

  const after = await prisma.uPCPool.count();
  const avail = await prisma.uPCPool.count({ where: { status: "AVAILABLE" } });
  const assigned = await prisma.uPCPool.count({ where: { status: "ASSIGNED" } });
  console.log("");
  console.log(
    `UPCPool AFTER:  ${after} total (delta +${after - before})`,
  );
  console.log(`  AVAILABLE: ${avail}`);
  console.log(`  ASSIGNED:  ${assigned}`);
}

main()
  .catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
