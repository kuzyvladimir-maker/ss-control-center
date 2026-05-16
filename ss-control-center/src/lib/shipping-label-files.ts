// File naming and Drive folder layout for purchased shipping label PDFs.

// Format date as "Mmm DD" (e.g. "Apr 07").
function fmtDate(dateStr: string | null): string {
  if (!dateStr) return "N-A";
  const d = new Date(dateStr + "T12:00:00");
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[d.getMonth()]} ${String(d.getDate()).padStart(2, "0")}`;
}

// Build PDF filename per MASTER_PROMPT section 9.
// Optional `frozenRisk` — when a Frozen Analytics v2 alert exists for this
// order at MEDIUM or higher, prepend a tag so the warehouse sees the
// recommendation in the filename itself (Drive folder listings, Slack
// previews, etc.). Format: "[FROZEN-RISK HIGH: 2-Day required] (EDD…)".
export interface FrozenRiskHint {
  level: string; // medium | high | critical
  shortAdvice: string | null;
}

export function buildPdfFilename(
  item: {
    edd: string | null;
    deliveryBy: string | null;
    product: string;
    qty: number;
  },
  frozenRisk?: FrozenRiskHint | null,
): string {
  const edd = fmtDate(item.edd);
  const dl = fmtDate(item.deliveryBy);
  const product = item.product.substring(0, 80).replace(/[/\\:*?"<>|]/g, "");
  const base = `(EDD ${edd} | DL ${dl}) ${product} -- ${item.qty}.pdf`;
  if (frozenRisk && ["medium", "high", "critical"].includes(frozenRisk.level)) {
    const advice = frozenRisk.shortAdvice
      ? `: ${frozenRisk.shortAdvice.replace(/[/\\:*?"<>|]/g, "").slice(0, 50)}`
      : "";
    return `[FROZEN-RISK ${frozenRisk.level.toUpperCase()}${advice}] ${base}`;
  }
  return base;
}

// Build folder path per MASTER_PROMPT section 8.
export function buildFolderPath(item: {
  actualShipDay: string | null;
  channel: string;
}): string {
  const shipDay = item.actualShipDay || new Date().toISOString().split("T")[0];
  const d = new Date(shipDay + "T12:00:00");
  const monthNum = String(d.getMonth() + 1).padStart(2, "0");
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const monthName = monthNames[d.getMonth()];
  const day = String(d.getDate()).padStart(2, "0");
  const channelName = item.channel || "Amazon";
  // Shipping Labels / 04 April / 07 / Amazon /
  return `${monthNum} ${monthName}/${day}/${channelName}`;
}
