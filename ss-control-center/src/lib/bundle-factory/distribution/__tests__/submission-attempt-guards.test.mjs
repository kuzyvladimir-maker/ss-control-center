/**
 * The MarketplaceSubmissionAttempt guard triggers, proven by behaviour.
 *
 * Why this test exists. On 2026-08-03 a migration lifted the two-row submission
 * cap by rebuilding the table: RENAME TO _old, CREATE new, DROP _old. SQLite
 * carries a table's triggers through the rename and destroys them with the
 * DROP. All five guards silently vanished, and every Walmart publish failed
 * afterwards with "Walmart publish lifecycle migration is not ready".
 *
 * A schema check that only counts objects would not have caught the thing that
 * actually mattered — whether the pilot cap still bites and whether the studio
 * lane is free of it. So this runs the real trigger definitions, from the real
 * migration file, against a throwaway database, and asserts what they DO.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const APP_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);
const MIGRATION = join(
  APP_ROOT,
  "prisma/migrations/20260803200000_restore_submission_attempt_guards/migration.sql",
);

/** Only the columns the guards actually reference. */
const TABLE_DDL = `CREATE TABLE "MarketplaceSubmissionAttempt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "channel_sku_id" TEXT NOT NULL,
  "marketplace" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL UNIQUE,
  "active_key" TEXT UNIQUE,
  "authorization_basis" TEXT NOT NULL DEFAULT 'OWNER_SIGNED_PERMIT',
  "authorization_sha256" TEXT,
  "pilot_permit_sha256" TEXT, "pilot_permit_id" TEXT, "owner_key_id" TEXT,
  "owner_signature_sha256" TEXT, "pilot_slot" INTEGER,
  "pilot_approval_sha256" TEXT, "certification_sha256" TEXT,
  "seller_account_fingerprint_sha256" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL, "claim_token" TEXT NOT NULL UNIQUE,
  "state" TEXT NOT NULL, "retry_after" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

async function freshDb(t) {
  const file = join(tmpdir(), `submission-guards-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  rmSync(file, { force: true });
  const db = createClient({ url: `file:${file}` });
  await db.execute(TABLE_DDL);

  const sql = readFileSync(MIGRATION, "utf8");
  const triggers = [...sql.matchAll(/CREATE TRIGGER[\s\S]*?\nEND;/g)];
  assert.equal(triggers.length, 5, "the migration must define all five guards");
  for (const match of triggers) {
    await db.execute(match[0].replace(/;$/, ""));
  }

  t.after(() => {
    db.close?.();
    rmSync(file, { force: true });
  });
  return db;
}

let counter = 0;
async function claim(db, skuId, basis) {
  counter += 1;
  await db.execute({
    sql: `INSERT INTO "MarketplaceSubmissionAttempt"
      (id, channel_sku_id, marketplace, idempotency_key, active_key,
       authorization_basis, seller_account_fingerprint_sha256, payload_hash,
       claim_token, state, updated_at)
      VALUES (?,?,'WALMART',?,?,?,'fp','ph',?,'CLAIMED',CURRENT_TIMESTAMP)`,
    args: [`a${counter}`, skuId, `idem${counter}`, skuId, basis, `tok${counter}`],
  });
}

/** Reaching a terminal state releases the active fence, as the real code does. */
async function settle(db, skuId) {
  await db.execute({
    sql: `UPDATE "MarketplaceSubmissionAttempt"
          SET state='BUYER_VERIFIED', active_key=NULL WHERE channel_sku_id=?`,
    args: [skuId],
  });
}

test("the studio lane is not capped — this is what the factory needs", async (t) => {
  const db = await freshDb(t);
  for (let i = 1; i <= 25; i += 1) {
    await claim(db, `studio-${i}`, "STUDIO_SEALED_APPROVAL");
    await settle(db, `studio-${i}`);
  }
  const rows = await db.execute(
    `SELECT COUNT(DISTINCT channel_sku_id) AS n FROM "MarketplaceSubmissionAttempt"`,
  );
  assert.equal(Number(rows.rows[0].n), 25);
});

test("the frozen pilot still stops at two distinct SKUs, forever", async (t) => {
  const db = await freshDb(t);
  await claim(db, "pilot-1", "OWNER_SIGNED_PERMIT");
  await settle(db, "pilot-1");
  await claim(db, "pilot-2", "OWNER_SIGNED_PERMIT");
  await settle(db, "pilot-2");

  await assert.rejects(
    () => claim(db, "pilot-3", "OWNER_SIGNED_PERMIT"),
    /WALMART_PILOT_GLOBAL_TWO_SKU_CAP_REACHED/,
  );
});

test("studio rows do not consume the pilot's two slots", async (t) => {
  const db = await freshDb(t);
  for (let i = 1; i <= 10; i += 1) {
    await claim(db, `studio-${i}`, "STUDIO_SEALED_APPROVAL");
    await settle(db, `studio-${i}`);
  }
  // Both pilot slots must still be available after any amount of studio work.
  await claim(db, "pilot-1", "OWNER_SIGNED_PERMIT");
  await settle(db, "pilot-1");
  await claim(db, "pilot-2", "OWNER_SIGNED_PERMIT");
  await settle(db, "pilot-2");
  await assert.rejects(
    () => claim(db, "pilot-3", "OWNER_SIGNED_PERMIT"),
    /WALMART_PILOT_GLOBAL_TWO_SKU_CAP_REACHED/,
  );
});

test("a retry of an already attempted pilot SKU is still allowed", async (t) => {
  const db = await freshDb(t);
  await claim(db, "pilot-1", "OWNER_SIGNED_PERMIT");
  await settle(db, "pilot-1");
  await claim(db, "pilot-2", "OWNER_SIGNED_PERMIT");
  await settle(db, "pilot-2");
  // The cap counts distinct SKUs ever attempted, not attempts.
  await claim(db, "pilot-1", "OWNER_SIGNED_PERMIT");
});

test("the submission ledger cannot be deleted", async (t) => {
  const db = await freshDb(t);
  await claim(db, "studio-1", "STUDIO_SEALED_APPROVAL");
  await assert.rejects(
    () => db.execute(`DELETE FROM "MarketplaceSubmissionAttempt" WHERE channel_sku_id='studio-1'`),
    /append-retained/,
  );
});

test("submission identity cannot be edited after the fact", async (t) => {
  const db = await freshDb(t);
  await claim(db, "studio-1", "STUDIO_SEALED_APPROVAL");

  for (const [column, value] of [
    ["channel_sku_id", "'someone-else'"],
    ["marketplace", "'AMAZON'"],
    ["idempotency_key", "'rewritten'"],
    ["payload_hash", "'rewritten'"],
    // Which lane authorized the write is identity, not status: a studio row
    // must not be able to relabel itself as an owner-signed pilot row and
    // inherit an authority it never had.
    ["authorization_basis", "'OWNER_SIGNED_PERMIT'"],
    ["authorization_sha256", "'rewritten'"],
  ]) {
    await assert.rejects(
      () => db.execute(
        `UPDATE "MarketplaceSubmissionAttempt" SET ${column}=${value} WHERE channel_sku_id='studio-1'`,
      ),
      /identity is immutable/,
      `${column} must be sealed`,
    );
  }
});

test("an active attempt must point at its own SKU", async (t) => {
  const db = await freshDb(t);
  await assert.rejects(
    () => db.execute(
      `INSERT INTO "MarketplaceSubmissionAttempt"
        (id, channel_sku_id, marketplace, idempotency_key, active_key,
         authorization_basis, seller_account_fingerprint_sha256, payload_hash,
         claim_token, state, updated_at)
        VALUES ('bad','sku-x','WALMART','idem-bad',NULL,
                'STUDIO_SEALED_APPROVAL','fp','ph','tok-bad','CLAIMED',
                CURRENT_TIMESTAMP)`,
    ),
    /invalid marketplace submission active fence/,
  );
});

test("a terminal attempt must release the active fence", async (t) => {
  const db = await freshDb(t);
  await assert.rejects(
    () => db.execute(
      `INSERT INTO "MarketplaceSubmissionAttempt"
        (id, channel_sku_id, marketplace, idempotency_key, active_key,
         authorization_basis, seller_account_fingerprint_sha256, payload_hash,
         claim_token, state, updated_at)
        VALUES ('bad2','sku-y','WALMART','idem-bad2','sku-y',
                'STUDIO_SEALED_APPROVAL','fp','ph','tok-bad2','REJECTED',
                CURRENT_TIMESTAMP)`,
    ),
    /invalid marketplace submission active fence/,
  );
});
