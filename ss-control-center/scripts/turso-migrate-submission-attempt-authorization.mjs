// Turso migration: submission attempts stop being a two-row pilot ledger.
//
// `MarketplaceSubmissionAttempt` was written for the frozen 1–2 SKU pilot and
// encoded that in the schema itself: `pilot_slot INTEGER NOT NULL UNIQUE`, with
// the claim accepting only the values 1 and 2. The whole table could therefore
// hold at most TWO rows ever — the reason a third Walmart listing could never
// be published, let alone a batch.
//
// This makes the pilot's permit evidence nullable and records how each
// submission was authorized:
//
//   OWNER_SIGNED_PERMIT   — the frozen pilot, unchanged: an Ed25519 permit the
//                           owner signs outside the app, one SKU per signature.
//   STUDIO_SEALED_APPROVAL — the factory lane: the sealed distribution approval
//                           already on the SKU, binding operator, validation
//                           run, publishable content hash and payload hash.
//
// The actual one-POST fences are untouched: `idempotency_key` stays UNIQUE and
// `active_key` stays UNIQUE, so one ChannelSKU still cannot have two live
// attempts. SQLite treats NULLs as distinct in a unique index, so the pilot
// columns keep their uniqueness for pilot rows while any number of studio rows
// coexist.
//
// Idempotent: exits early if authorization_basis already exists.
//
//   node -r dotenv/config scripts/turso-migrate-submission-attempt-authorization.mjs

import { createClient } from "@libsql/client";

function clean(v) {
  if (!v) return v;
  return v.trim().replace(/^['"]|['"]$/g, "");
}

const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) {
  console.error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN");
  process.exit(1);
}

const MIGRATION_NAME = "20260803120000_submission_attempt_authorization";
const TABLE = "MarketplaceSubmissionAttempt";
const client = createClient({ url, authToken });
console.log(`→ Target: ${url.split("@")[1] || url}`);

const cols = await client.execute({ sql: `PRAGMA table_info("${TABLE}")` });
if (cols.rows.length === 0) {
  console.error(`✗ ${TABLE} does not exist on this database`);
  process.exit(2);
}
if (cols.rows.some((r) => String(r.name) === "authorization_basis")) {
  console.log("· already migrated (authorization_basis present) — skipping");
  client.close();
  process.exit(0);
}

// The table is recreated, so every existing row is carried over explicitly.
const before = await client.execute({ sql: `SELECT COUNT(*) AS n FROM "${TABLE}"` });
const rowCount = Number(before.rows[0]?.n ?? 0);
console.log(`· ${rowCount} existing attempt row(s) will be preserved`);

await client.batch(
  [
    `PRAGMA defer_foreign_keys=ON`,
    `PRAGMA foreign_keys=OFF`,
    `ALTER TABLE "${TABLE}" RENAME TO "${TABLE}_old"`,
    `CREATE TABLE "${TABLE}" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "channel_sku_id" TEXT NOT NULL,
      "marketplace" TEXT NOT NULL,
      "idempotency_key" TEXT NOT NULL,
      "active_key" TEXT,
      "authorization_basis" TEXT NOT NULL DEFAULT 'OWNER_SIGNED_PERMIT',
      "authorization_sha256" TEXT,
      "pilot_permit_sha256" TEXT,
      "pilot_permit_id" TEXT,
      "owner_key_id" TEXT,
      "owner_signature_sha256" TEXT,
      "pilot_slot" INTEGER,
      "pilot_approval_sha256" TEXT,
      "certification_sha256" TEXT,
      "seller_account_fingerprint_sha256" TEXT NOT NULL,
      "payload_hash" TEXT NOT NULL,
      "claim_token" TEXT NOT NULL,
      "state" TEXT NOT NULL,
      "request_count" INTEGER NOT NULL DEFAULT 0,
      "recovery_count" INTEGER NOT NULL DEFAULT 0,
      "marketplace_submission_id" TEXT,
      "marketplace_disposition" TEXT,
      "error_json" TEXT,
      "claimed_at" DATETIME NOT NULL,
      "requested_at" DATETIME,
      "accepted_at" DATETIME,
      "terminal_at" DATETIME,
      "retry_after" DATETIME,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" DATETIME NOT NULL,
      CONSTRAINT "MarketplaceSubmissionAttempt_channel_sku_id_fkey"
        FOREIGN KEY ("channel_sku_id") REFERENCES "ChannelSKU" ("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT
    )`,
    `INSERT INTO "${TABLE}" (
      "id","channel_sku_id","marketplace","idempotency_key","active_key",
      "authorization_basis","authorization_sha256",
      "pilot_permit_sha256","pilot_permit_id","owner_key_id",
      "owner_signature_sha256","pilot_slot","pilot_approval_sha256",
      "certification_sha256","seller_account_fingerprint_sha256",
      "payload_hash","claim_token","state","request_count","recovery_count",
      "marketplace_submission_id","marketplace_disposition","error_json",
      "claimed_at","requested_at","accepted_at","terminal_at","retry_after",
      "created_at","updated_at"
    )
    SELECT
      "id","channel_sku_id","marketplace","idempotency_key","active_key",
      'OWNER_SIGNED_PERMIT',"pilot_permit_sha256",
      "pilot_permit_sha256","pilot_permit_id","owner_key_id",
      "owner_signature_sha256","pilot_slot","pilot_approval_sha256",
      "certification_sha256","seller_account_fingerprint_sha256",
      "payload_hash","claim_token","state","request_count","recovery_count",
      "marketplace_submission_id","marketplace_disposition","error_json",
      "claimed_at","requested_at","accepted_at","terminal_at","retry_after",
      "created_at","updated_at"
    FROM "${TABLE}_old"`,
    `DROP TABLE "${TABLE}_old"`,
    // The two fences that actually enforce one SKU / one POST.
    `CREATE UNIQUE INDEX "MarketplaceSubmissionAttempt_idempotency_key_key"
      ON "${TABLE}" ("idempotency_key")`,
    `CREATE UNIQUE INDEX "MarketplaceSubmissionAttempt_active_key_key"
      ON "${TABLE}" ("active_key")`,
    `CREATE UNIQUE INDEX "MarketplaceSubmissionAttempt_claim_token_key"
      ON "${TABLE}" ("claim_token")`,
    // Pilot evidence stays one-to-one for pilot rows; NULLs are distinct.
    `CREATE UNIQUE INDEX "MarketplaceSubmissionAttempt_pilot_permit_sha256_key"
      ON "${TABLE}" ("pilot_permit_sha256")`,
    `CREATE UNIQUE INDEX "MarketplaceSubmissionAttempt_pilot_permit_id_key"
      ON "${TABLE}" ("pilot_permit_id")`,
    `CREATE UNIQUE INDEX "MarketplaceSubmissionAttempt_owner_signature_sha256_key"
      ON "${TABLE}" ("owner_signature_sha256")`,
    `CREATE UNIQUE INDEX "MarketplaceSubmissionAttempt_pilot_slot_key"
      ON "${TABLE}" ("pilot_slot")`,
    `CREATE INDEX "MarketplaceSubmissionAttempt_channel_sku_id_state_idx"
      ON "${TABLE}" ("channel_sku_id","state")`,
    `CREATE INDEX "MarketplaceSubmissionAttempt_state_retry_after_idx"
      ON "${TABLE}" ("state","retry_after")`,
    `CREATE INDEX "MarketplaceSubmissionAttempt_marketplace_submission_id_idx"
      ON "${TABLE}" ("marketplace_submission_id")`,
    `PRAGMA foreign_keys=ON`,
  ],
  "write",
);

const after = await client.execute({ sql: `SELECT COUNT(*) AS n FROM "${TABLE}"` });
const afterCount = Number(after.rows[0]?.n ?? 0);
if (afterCount !== rowCount) {
  console.error(
    `✗ row count changed: ${rowCount} before, ${afterCount} after. Investigate before publishing.`,
  );
  process.exit(3);
}

// Prove the new shape on the live database rather than trusting the batch.
const newCols = await client.execute({ sql: `PRAGMA table_info("${TABLE}")` });
const slot = newCols.rows.find((r) => String(r.name) === "pilot_slot");
const basis = newCols.rows.find((r) => String(r.name) === "authorization_basis");
if (!basis || !slot || Number(slot.notnull) !== 0) {
  console.error("✗ post-migration shape is wrong");
  process.exit(4);
}
console.log(`✓ ${TABLE} migrated — ${afterCount} row(s), pilot_slot nullable`);

await client.execute({
  sql: `INSERT INTO "_prisma_migrations"
    ("id","checksum","finished_at","migration_name","logs","rolled_back_at","started_at","applied_steps_count")
    VALUES (?, ?, CURRENT_TIMESTAMP, ?, NULL, NULL, CURRENT_TIMESTAMP, 1)`,
  args: [
    `${MIGRATION_NAME}-manual`,
    "turso-manual-migration",
    MIGRATION_NAME,
  ],
}).catch((error) => {
  console.warn(`· could not register in _prisma_migrations: ${error.message}`);
});
console.log(`✓ registered ${MIGRATION_NAME}`);
client.close();
