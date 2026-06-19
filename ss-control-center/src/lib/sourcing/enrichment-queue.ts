// EnrichmentJob queue helpers — the Reference Catalog work queue. Producers (the
// manual "vector" button, Bundle Factory on a miss, and an optional auto-seeder)
// enqueue targets here; the reference-enrichment-worker cron drains them.
// See docs/wiki/reference-catalog-engine.md.

import type { Client } from "@libsql/client";
import crypto from "crypto";

export type EnrichTargetType = "brand" | "product" | "sku" | "query";

// Enqueue one enrichment target. Dedup: if an identical target is already
// queued/running, return that job instead of piling up duplicates.
export async function enqueueEnrichment(
  db: Client,
  opts: { targetType: EnrichTargetType; target: string; source?: string; priority?: number; requestedBy?: string | null },
): Promise<{ created: boolean; id: string }> {
  const target = opts.target.trim();
  if (!target) throw new Error("empty enrichment target");

  const existing = await db.execute({
    sql: `SELECT id FROM "EnrichmentJob" WHERE targetType=? AND target=? AND status IN ('queued','running') LIMIT 1`,
    args: [opts.targetType, target],
  });
  if (existing.rows.length) return { created: false, id: existing.rows[0].id as string };

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO "EnrichmentJob" (id, targetType, target, status, source, priority, requestedBy, attempts, queuedAt, createdAt, updatedAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [id, opts.targetType, target, "queued", opts.source ?? "manual", opts.priority ?? 0, opts.requestedBy ?? null, 0, now, now, now],
  });
  return { created: true, id };
}
