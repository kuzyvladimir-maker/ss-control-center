function messages(value: unknown): string[] {
  if (typeof value === "string") {
    const message = value.replace(/\s+/g, " ").trim();
    return message ? [message.slice(0, 160)] : [];
  }
  if (Array.isArray(value)) return value.flatMap(messages);
  if (value && typeof value === "object") {
    const entry = value as Record<string, unknown>;
    return messages(entry.message ?? entry.reason ?? Object.values(entry));
  }
  return [];
}

function describeEmptyPool(
  response: Record<string, unknown> | null | undefined,
  attempts: number,
): string {
  const details = [`attempts=${attempts}`];
  if (Array.isArray(response?.unavailable)) {
    const reasons = response.unavailable
      .flatMap((entry: unknown) => {
        if (!entry || typeof entry !== "object") return messages(entry);
        const rate = entry as Record<string, unknown>;
        return messages(rate.reason ?? rate.message ?? rate.errors ?? rate.error_messages);
      })
      .slice(0, 2);
    const summary = reasons.length > 0 ? ` (${reasons.join("; ")})` : "";
    details.push(`unavailableCount=${response.unavailable.length}${summary}`);
  }
  for (const field of ["errors", "error_messages"] as const) {
    const summary = messages(response?.[field]).slice(0, 2).join("; ");
    if (summary) details.push(`${field}=${summary}`);
  }
  return details.join(", ");
}

/** Retry a read-only quote when Veeqo returns an empty pool. HTTP errors propagate. */
export async function fetchLiveRatesWithRetry<R = Record<string, unknown>>(
  fetchFn: () => Promise<Record<string, unknown> | null | undefined>,
  {
    retryDelaysMs = [600, 1400],
    sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: { retryDelaysMs?: number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ rates: R[]; attempts: number; emptyDiag: string | null }> {
  let response = await fetchFn();
  let attempts = 1;
  while (!Array.isArray(response?.available) || response.available.length === 0) {
    if (attempts > retryDelaysMs.length) {
      return { rates: [], attempts, emptyDiag: describeEmptyPool(response, attempts) };
    }
    await sleep(retryDelaysMs[attempts - 1]);
    response = await fetchFn();
    attempts++;
  }
  return { rates: response.available as R[], attempts, emptyDiag: null };
}
