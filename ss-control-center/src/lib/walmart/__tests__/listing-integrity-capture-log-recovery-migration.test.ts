import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createClient } from "@libsql/client";

const STAGE_A = path.join(
  process.cwd(),
  "prisma/migrations/20260801172000_walmart_listing_integrity_control_plane_stage_a/migration.sql",
);
const RECOVERY = path.join(
  process.cwd(),
  "prisma/migrations/20260801235000_walmart_listing_integrity_capture_log_recovery/migration.sql",
);
const H = (value: string) => value.repeat(64);

test("capture-log migration permits only artifact-bound zero-write requeue", async () => {
  const client = createClient({ url: "file::memory:" });
  try {
    await client.executeMultiple(await readFile(STAGE_A, "utf8"));
    await client.executeMultiple(await readFile(RECOVERY, "utf8"));
    await client.execute({
      sql: `INSERT INTO WalmartListingIntegrityControlRun (
        runId,schemaVersion,poolBodySha256,releaseIdSha256,manifestSha256,
        runtimeStage,status,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,'OFF','ACTIVE',?,?)`,
      args: ["run-1", "walmart-listing-integrity-control-run/v1", H("a"), H("b"), H("c"),
        "2026-08-01T23:00:00.000Z", "2026-08-01T23:00:00.000Z"],
    });
    await client.execute({
      sql: `INSERT INTO WalmartListingIntegrityControlItem (
        itemControlId,runId,ordinal,listingKey,sku,itemId,storeIndex,state,
        revision,stateBodySha256,previousStateSha256,evidenceSha256,
        executionPackageSha256,ownerPermitSha256,feedId,marketplaceWriteCalls,
        automaticRetryAllowed,automaticReplayAllowed,transitionedAt,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,1,'QUARANTINED_SOURCE_REQUIRED',3,?,?,?,?,?,?,0,0,0,?,?,?)`,
      args: ["item-1", "run-1", 1, "walmart:1:FaisalX-2554", "FaisalX-2554", "10303218977",
        H("d"), H("e"), H("f"), null, null, null,
        "2026-08-01T23:01:00.000Z", "2026-08-01T23:00:00.000Z", "2026-08-01T23:01:00.000Z"],
    });
    const update = {
      sql: `UPDATE WalmartListingIntegrityControlItem SET
        state='QUEUED',revision=4,stateBodySha256=?,previousStateSha256=?,
        evidenceSha256=?,transitionedAt=?,updatedAt=? WHERE itemControlId='item-1'`,
      args: [H("1"), H("d"), H("2"), "2026-08-01T23:02:00.000Z", "2026-08-01T23:02:00.000Z"],
    };
    await assert.rejects(client.execute(update), /terminal item is immutable|transition is not permitted/u);
    await client.execute({
      sql: `INSERT INTO WalmartListingIntegrityControlArtifact (
        artifactId,runId,itemControlId,role,mediaType,byteSize,sha256,locator,
        createdAt,createdByPrincipal
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      args: ["artifact-1", "run-1", "item-1", "CAPTURE_LOG_FALSE_QUARANTINE_RECOVERY",
        "application/json", 100, H("2"), `sha256:${H("2")}`,
        "2026-08-01T23:02:00.000Z", "codex-owner-recovery"],
    });
    await client.execute(update);
    const rows = await client.execute(
      "SELECT state,revision,marketplaceWriteCalls FROM WalmartListingIntegrityControlItem",
    );
    assert.deepEqual(rows.rows.map((row) => ({
      state: row.state,
      revision: Number(row.revision),
      writes: Number(row.marketplaceWriteCalls),
    })), [{ state: "QUEUED", revision: 4, writes: 0 }]);
  } finally {
    client.close();
  }
});
