/**
 * Owner-controlled Walmart channel circuit breaker.
 *
 * The marketplace account was blocked on 2026-08-10. Keep this as a source-
 * controlled, fail-closed switch so a stale route, script or restored cron
 * cannot contact Walmart merely because credentials still exist in production.
 * Re-enabling the channel requires an intentional code change and deployment.
 */
export const WALMART_CHANNEL_SUSPENDED = true as const;

export const WALMART_CHANNEL_SUSPENSION = Object.freeze({
  code: "WALMART_CHANNEL_SUSPENDED",
  reason: "Walmart marketplace account blocked; channel automation suspended by owner.",
  suspendedAt: "2026-08-10",
});

export class WalmartChannelSuspendedError extends Error {
  readonly code = WALMART_CHANNEL_SUSPENSION.code;

  constructor(operation = "Walmart operation") {
    super(`${WALMART_CHANNEL_SUSPENSION.code}: ${operation} is disabled. ${WALMART_CHANNEL_SUSPENSION.reason}`);
    this.name = "WalmartChannelSuspendedError";
  }
}

export function assertWalmartChannelActive(
  operation?: string,
  options: { allowNonProductionTest?: boolean } = {},
): void {
  if (!WALMART_CHANNEL_SUSPENDED) return;
  if (options.allowNonProductionTest && process.env.NODE_ENV !== "production") return;
  throw new WalmartChannelSuspendedError(operation);
}
