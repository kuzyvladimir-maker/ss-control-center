/**
 * Critical Alert Evaluator
 *
 * Called after each Amazon / Walmart Account Health sync. Walks every rule
 * in alert-rules.ts, compares the new value to its threshold, and creates
 * a CriticalAlert row when it breaches. To avoid spamming Telegram during
 * a flaky metric we deduplicate within a rolling 24-hour window per
 * (store, metric).
 */

import { prisma } from "@/lib/prisma";
import { ALERT_RULES, type AlertChannel } from "./alert-rules";
import { sendCriticalAlert } from "@/lib/telegram";

export interface SnapshotInput {
  storeId: string;       // Store.id (cuid)
  storeName: string;
  channel: AlertChannel;
  // Flat key→value map of metric values. Unknown keys are skipped silently.
  metrics: Record<string, number | null | undefined>;
}

export interface CreatedAlertSummary {
  id: string;
  alertType: string;
  severity: string;
  telegramSent: boolean;
}

export async function evaluateCriticalAlerts(
  input: SnapshotInput
): Promise<CreatedAlertSummary[]> {
  const rules = ALERT_RULES.filter((r) => r.channel === input.channel);
  const created: CreatedAlertSummary[] = [];
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  for (const rule of rules) {
    const v = input.metrics[rule.metric];
    if (v == null || !Number.isFinite(v)) continue;

    const breached =
      rule.threshold.direction === "gte"
        ? v >= rule.threshold.value
        : v <= rule.threshold.value;
    if (!breached) continue;

    // Dedup: same (store, metric) within 24h, still unresolved → skip.
    const recent = await prisma.criticalAlert.findFirst({
      where: {
        storeId: input.storeId,
        alertType: rule.metric,
        detectedAt: { gte: cutoff },
        resolvedAt: null,
      },
      select: { id: true },
    });
    if (recent) continue;

    const alert = await prisma.criticalAlert.create({
      data: {
        storeId: input.storeId,
        channel: rule.channel,
        alertType: rule.metric,
        severity: rule.severity,
        metricName: rule.metric,
        metricValue: typeof v === "number" ? v.toFixed(2) : String(v),
        metricThreshold: `${rule.threshold.direction === "gte" ? ">=" : "<="} ${rule.threshold.value}`,
        title: rule.title(v),
        message: rule.message(v, input.storeName),
        actionUrl: `/account-health?tab=${rule.channel.toLowerCase()}&store=${input.storeId}`,
      },
    });

    let telegramSent = false;
    if (rule.severity === "CRITICAL" || rule.severity === "HIGH") {
      try {
        const result = await sendCriticalAlert(formatTelegramAlert(alert));
        if (result.sent) {
          telegramSent = true;
          await prisma.criticalAlert.update({
            where: { id: alert.id },
            data: {
              telegramSent: true,
              telegramSentAt: new Date(),
              telegramMessageId: result.messageId ?? null,
            },
          });
        }
      } catch (err) {
        console.error("[CriticalAlert] Telegram send failed:", err);
      }
    }

    created.push({
      id: alert.id,
      alertType: alert.alertType,
      severity: alert.severity,
      telegramSent,
    });
  }

  return created;
}

function formatTelegramAlert(alert: {
  severity: string;
  title: string;
  message: string;
  metricName: string;
  metricValue: string;
  metricThreshold: string;
  actionUrl: string | null;
}): string {
  const emoji =
    alert.severity === "CRITICAL"
      ? "🚨"
      : alert.severity === "HIGH"
        ? "⚠️"
        : "ℹ️";
  const base = process.env.NEXT_PUBLIC_APP_URL || "";
  const link = alert.actionUrl ? `\n\n🔗 ${base}${alert.actionUrl}` : "";
  return (
    `${emoji} *${alert.title}*\n\n` +
    `${alert.message}\n\n` +
    `📊 ${alert.metricName}: ${alert.metricValue} (порог: ${alert.metricThreshold})` +
    link
  );
}
