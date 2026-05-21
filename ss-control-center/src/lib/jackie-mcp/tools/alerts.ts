/**
 * Jackie MCP tools — Critical Alerts (cross-channel).
 */

import { prisma } from "@/lib/prisma";
import { optionalString, optionalBoolean, requireString } from "../channels";
import type { JackieTool } from "../registry";

const criticalAlertsList: JackieTool = {
  name: "critical_alerts_list",
  description:
    "List CriticalAlert rows. Defaults to active (not acknowledged, not resolved). Filters: channel ('Amazon'|'Walmart'), severity ('CRITICAL'|'HIGH'|'WARNING'), acknowledged, resolved.",
  write: false,
  input_schema: {
    type: "object",
    properties: {
      channel: { type: "string" },
      severity: { type: "string" },
      acknowledged: { type: "boolean" },
      resolved: { type: "boolean" },
      limit: { type: "number", default: 50 },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    const where: Record<string, unknown> = {};
    const channel = optionalString(args, "channel");
    if (channel) where.channel = channel;
    const severity = optionalString(args, "severity");
    if (severity) where.severity = severity;
    const acknowledged = optionalBoolean(args, "acknowledged");
    if (acknowledged !== undefined) where.acknowledged = acknowledged;
    const resolved = optionalBoolean(args, "resolved");
    if (resolved !== undefined) {
      where.resolvedAt = resolved ? { not: null } : null;
    } else if (acknowledged === undefined) {
      // Default: active = not acknowledged + not resolved.
      where.acknowledged = false;
      where.resolvedAt = null;
    }
    const limit = typeof args.limit === "number" ? args.limit : 50;
    const rows = await prisma.criticalAlert.findMany({
      where,
      orderBy: { detectedAt: "desc" },
      take: Math.min(limit, 200),
    });
    return { count: rows.length, alerts: rows };
  },
};

const alertAcknowledge: JackieTool = {
  name: "alert_acknowledge",
  description: "Acknowledge one CriticalAlert (sets acknowledged=true + acknowledgedAt + acknowledgedBy='jackie').",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      alert_id: { type: "string" },
      dry_run: { type: "boolean", default: false },
    },
    required: ["alert_id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = requireString(args, "alert_id");
    const dry_run = args.dry_run === true;
    if (dry_run) return { dry_run: true, would_acknowledge: id };
    const row = await prisma.criticalAlert.update({
      where: { id },
      data: {
        acknowledged: true,
        acknowledgedAt: new Date(),
        acknowledgedBy: ctx.actor,
      },
    });
    return { ok: true, alert: row };
  },
};

const alertResolve: JackieTool = {
  name: "alert_resolve",
  description:
    "Mark a CriticalAlert as resolved (sets resolvedAt). Use when the underlying issue is fixed (e.g. ODR fell back below threshold).",
  write: true,
  input_schema: {
    type: "object",
    properties: {
      alert_id: { type: "string" },
      dry_run: { type: "boolean", default: false },
    },
    required: ["alert_id"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const id = requireString(args, "alert_id");
    const dry_run = args.dry_run === true;
    if (dry_run) return { dry_run: true, would_resolve: id };
    const row = await prisma.criticalAlert.update({
      where: { id },
      data: { resolvedAt: new Date() },
    });
    return { ok: true, alert: row };
  },
};

export const tools: JackieTool[] = [
  criticalAlertsList,
  alertAcknowledge,
  alertResolve,
];
