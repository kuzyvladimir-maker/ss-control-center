interface GenerationJobChannelProbe {
  current_stage: string;
  brief: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** True only for explicit Walmart routing fields; prompt prose is not inspected. */
export function generationJobTargetsWalmart(job: GenerationJobChannelProbe): boolean {
  if (job.current_stage.toUpperCase().startsWith("WALMART")) return true;
  let brief: Record<string, unknown> | null = null;
  try {
    brief = asRecord(JSON.parse(job.brief));
  } catch {
    return false;
  }
  if (!brief) return false;
  if (String(brief.channel ?? "").toUpperCase() === "WALMART") return true;
  if (String(brief.marketplace ?? "").toUpperCase() === "WALMART") return true;
  if (String(brief.workflow ?? "").toUpperCase().includes("WALMART")) return true;
  if (Object.hasOwn(brief, "walmart_shipping")) return true;
  return Array.isArray(brief.target_channels) && brief.target_channels.some(
    (channel) => String(channel).toUpperCase() === "WALMART",
  );
}
