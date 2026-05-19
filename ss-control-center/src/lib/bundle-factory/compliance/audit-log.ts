// Compliance audit-log helper.
//
// Writes one ComplianceAuditLog row. Used by the orchestrator (one entry
// per gate run with event_type='gate_check') and reserved for the UI's
// manual-override flow (event_type='manual_override') and the future
// pattern-detector cron (event_type='pattern_detected').

import { prisma } from "@/lib/prisma";

export type AuditEventType =
  | "gate_check"
  | "manual_override"
  | "pattern_detected"
  | "auto_fix";

export interface AuditLogEntry {
  bundle_draft_id: string;
  channel_sku_id?: string | null;
  event_type: AuditEventType;
  event_details: Record<string, unknown>;
  actor: string;
  decision?: "CAN_PUBLISH" | "BLOCKED" | null;
}

export async function writeAuditLog(entry: AuditLogEntry): Promise<void> {
  await prisma.complianceAuditLog.create({
    data: {
      bundle_draft_id: entry.bundle_draft_id,
      channel_sku_id: entry.channel_sku_id ?? null,
      event_type: entry.event_type,
      event_details: JSON.stringify(entry.event_details ?? {}),
      actor: entry.actor,
      decision: entry.decision ?? null,
    },
  });
}
