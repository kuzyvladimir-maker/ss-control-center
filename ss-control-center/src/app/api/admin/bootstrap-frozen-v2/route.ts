// POST /api/admin/bootstrap-frozen-v2
//
// One-shot turnkey bootstrap for Frozen Analytics v2:
//   1. Applies the v2 schema migration to whatever DB the running app is
//      pointed at (Turso in prod, local SQLite in dev). Idempotent — each
//      statement is wrapped so "table already exists" / "duplicate column"
//      errors are treated as a no-op.
//   2. Seeds the default rule set into FrozenRule (also idempotent).
//
// Auth: relies on the existing /api/* middleware (src/proxy.ts) which
// accepts either a logged-in session cookie OR `Authorization: Bearer
// ${SSCC_API_TOKEN}`. No per-route auth check needed here.
//
// Why this exists: Vercel build only runs `prisma generate`, NOT
// `prisma migrate deploy`, so a schema change committed to the repo
// doesn't reach Turso on its own. Until we wire `migrate deploy` into
// the build, this endpoint is the bridge — POST it once after each
// schema change ships and you're good.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { DEFAULT_RULES } from "@/lib/frozen-analytics/default-rules";

// Each migration SQL statement is run independently so a failure on one
// doesn't abort the rest. Errors expected on a re-run (table already
// exists / duplicate column) are noted in `idempotentSkips`.
const MIGRATION_STATEMENTS: Array<{ label: string; sql: string }> = [
  {
    label: "alter FrozenIncident add linkedAlertId",
    sql: `ALTER TABLE "FrozenIncident" ADD COLUMN "linkedAlertId" TEXT`,
  },
  {
    label: "index FrozenIncident_linkedAlertId_idx",
    sql: `CREATE INDEX "FrozenIncident_linkedAlertId_idx" ON "FrozenIncident"("linkedAlertId")`,
  },
  {
    label: "create FrozenRiskAlert",
    sql: `CREATE TABLE "FrozenRiskAlert" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      "orderId" TEXT NOT NULL,
      "veeqoOrderId" TEXT,
      "storeIndex" INTEGER,
      "storeName" TEXT,
      "channel" TEXT NOT NULL DEFAULT 'Amazon',
      "sku" TEXT NOT NULL,
      "productName" TEXT,
      "asin" TEXT,
      "shipDate" TEXT NOT NULL,
      "edd" TEXT,
      "transitDays" INTEGER,
      "plannedCarrier" TEXT,
      "plannedService" TEXT,
      "destZip" TEXT NOT NULL,
      "destCity" TEXT,
      "destState" TEXT,
      "destLat" REAL,
      "destLon" REAL,
      "originTempF" REAL,
      "originFeelsLikeF" REAL,
      "originTempMaxF" REAL,
      "originNormalF" REAL,
      "originAnomalyF" REAL,
      "originWeatherDesc" TEXT,
      "destTempF" REAL,
      "destFeelsLikeF" REAL,
      "destTempMaxF" REAL,
      "destNormalF" REAL,
      "destAnomalyF" REAL,
      "destWeatherDesc" TEXT,
      "riskLevel" TEXT NOT NULL,
      "riskScore" INTEGER NOT NULL,
      "triggeredRules" TEXT NOT NULL,
      "recommendations" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "appliedAt" DATETIME,
      "appliedBy" TEXT,
      "userNotes" TEXT,
      "shippingChoiceFollowed" BOOLEAN,
      "resultedInComplaint" BOOLEAN,
      "linkedIncidentId" TEXT
    )`,
  },
  {
    label: "index FrozenRiskAlert_orderId_shipDate_key",
    sql: `CREATE UNIQUE INDEX "FrozenRiskAlert_orderId_shipDate_key" ON "FrozenRiskAlert"("orderId", "shipDate")`,
  },
  {
    label: "index FrozenRiskAlert_riskLevel_status_idx",
    sql: `CREATE INDEX "FrozenRiskAlert_riskLevel_status_idx" ON "FrozenRiskAlert"("riskLevel", "status")`,
  },
  {
    label: "index FrozenRiskAlert_shipDate_idx",
    sql: `CREATE INDEX "FrozenRiskAlert_shipDate_idx" ON "FrozenRiskAlert"("shipDate")`,
  },
  {
    label: "index FrozenRiskAlert_sku_idx",
    sql: `CREATE INDEX "FrozenRiskAlert_sku_idx" ON "FrozenRiskAlert"("sku")`,
  },
  {
    label: "index FrozenRiskAlert_storeIndex_idx",
    sql: `CREATE INDEX "FrozenRiskAlert_storeIndex_idx" ON "FrozenRiskAlert"("storeIndex")`,
  },
  {
    label: "create FrozenRule",
    sql: `CREATE TABLE "FrozenRule" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      "ruleCode" TEXT NOT NULL,
      "ruleType" TEXT NOT NULL,
      "description" TEXT NOT NULL,
      "conditions" TEXT NOT NULL,
      "riskLevel" TEXT,
      "modifier" INTEGER,
      "recommendation" TEXT,
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "priority" INTEGER NOT NULL DEFAULT 100
    )`,
  },
  {
    label: "index FrozenRule_ruleCode_key",
    sql: `CREATE UNIQUE INDEX "FrozenRule_ruleCode_key" ON "FrozenRule"("ruleCode")`,
  },
];

// SQLite + libsql phrasings for "this is fine to skip on a re-run".
// Lowercased message must contain at least one of these substrings.
const SKIPPABLE_ERROR_FRAGMENTS = [
  "already exists",
  "duplicate column",
  "duplicate column name",
];

function isSkippable(err: unknown): boolean {
  const msg =
    err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return SKIPPABLE_ERROR_FRAGMENTS.some((f) => msg.includes(f));
}

export async function POST() {
  const applied: string[] = [];
  const idempotentSkips: string[] = [];
  const failures: Array<{ label: string; error: string }> = [];

  for (const stmt of MIGRATION_STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(stmt.sql);
      applied.push(stmt.label);
    } catch (err) {
      if (isSkippable(err)) {
        idempotentSkips.push(stmt.label);
      } else {
        failures.push({
          label: stmt.label,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // If the FrozenRule table itself exists (either freshly created or pre-
  // existing), run the seed. We use upsert so re-runs don't clobber any
  // tuning Vladimir has already applied.
  let rulesCreated = 0;
  let rulesSkipped = 0;
  let seedError: string | null = null;
  try {
    for (const r of DEFAULT_RULES) {
      const existing = await prisma.frozenRule.findUnique({
        where: { ruleCode: r.ruleCode },
      });
      if (existing) {
        rulesSkipped++;
        continue;
      }
      await prisma.frozenRule.create({
        data: {
          ruleCode: r.ruleCode,
          ruleType: r.ruleType,
          description: r.description,
          conditions: JSON.stringify(r.conditions),
          riskLevel: r.riskLevel ?? null,
          modifier: r.modifier ?? null,
          recommendation: r.recommendation,
          priority: r.priority,
        },
      });
      rulesCreated++;
    }
  } catch (err) {
    seedError = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json(
    {
      ok: failures.length === 0 && !seedError,
      schema: {
        applied,
        idempotentSkips,
        failures,
      },
      rules: {
        created: rulesCreated,
        skippedExisting: rulesSkipped,
        error: seedError,
      },
    },
    { status: failures.length === 0 && !seedError ? 200 : 500 },
  );
}
