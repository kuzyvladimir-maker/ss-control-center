/**
 * UPS Tracking API client — OAuth client_credentials flow + shipment
 * lookup. Used by the Customer Hub enricher to pull the real carrier ETA
 * and event history that Veeqo does not surface.
 *
 * Why we need this: Veeqo's /shipments/:id returns shipment metadata but
 * no updated carrier promise. Amazon's LatestDeliveryDate is frozen at
 * purchase time. The only source of truth for "when will this package
 * actually arrive" is the carrier's tracking API directly. Without it
 * our AI responses quote stale or missing ETAs.
 *
 * OAuth: client_credentials → bearer token good for ~1 hour. We cache
 * in-process with a 55-minute TTL so subsequent calls skip the auth
 * round-trip. The module is imported lazily so startup isn't blocked.
 *
 * Endpoints:
 *   Prod:    https://onlinetools.ups.com
 *   Sandbox: https://wwwcie.ups.com
 *
 * Reference: https://developer.ups.com/api/reference/tracking/
 */

type TokenCache = {
  accessToken: string;
  expiresAt: number; // epoch millis
};

let cachedToken: TokenCache | null = null;

function upsBaseUrl(): string {
  return process.env.UPS_ENV === "production"
    ? "https://onlinetools.ups.com"
    : "https://wwwcie.ups.com";
}

/**
 * Get a UPS OAuth access token via client_credentials flow. Caches the
 * token in-process with a 55-minute TTL (UPS tokens live ~1 hour). Throws
 * if credentials are missing or the exchange fails.
 */
export async function getUpsAccessToken(): Promise<string> {
  const clientId = process.env.UPS_CLIENT_ID;
  const clientSecret = process.env.UPS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "UPS credentials missing — set UPS_CLIENT_ID and UPS_CLIENT_SECRET in .env"
    );
  }

  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken;
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(`${upsBaseUrl()}/security/v1/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "x-merchant-id": "", // optional, leave empty
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`UPS OAuth failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const token = data.access_token;
  const expiresInSec = Number(data.expires_in) || 3600;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("UPS OAuth returned no access_token");
  }

  // Cache for (expires_in - 5min) to give callers slack
  cachedToken = {
    accessToken: token,
    expiresAt: Date.now() + (expiresInSec - 300) * 1000,
  };
  return token;
}

export interface UpsTrackingEvent {
  /** ISO date (YYYY-MM-DD) when the event occurred */
  date: string | null;
  /** Local event time (HH:MM) when present */
  time: string | null;
  /** Human-readable description — e.g. "Out For Delivery Today" */
  description: string | null;
  /** Normalised status class — e.g. "I" in transit, "D" delivered */
  status: string | null;
  /** City/state string from UPS */
  location: string | null;
}

export interface UpsTrackingInfo {
  trackingNumber: string;
  /** Current overall status text — e.g. "In Transit" */
  currentStatus: string | null;
  /** ISO date (YYYY-MM-DD) of the latest carrier-promised delivery */
  estimatedDelivery: string | null;
  /** ISO date (YYYY-MM-DD) of actual delivery if already delivered */
  actualDelivery: string | null;
  /** Whether UPS considers this package delivered */
  delivered: boolean;
  /** Ordered list of events, earliest first */
  events: UpsTrackingEvent[];
  /** Raw UPS payload, kept for debugging — we log the first N chars */
  raw: unknown;
}

/** Convert "20260415" or "2026-04-15" → "2026-04-15". Returns null on junk. */
function normaliseDate(d: unknown): string | null {
  if (typeof d !== "string") return null;
  const s = d.trim();
  if (!s) return null;
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

function normaliseTime(t: unknown): string | null {
  if (typeof t !== "string") return null;
  const s = t.trim();
  if (/^\d{6}$/.test(s)) {
    return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
  }
  if (/^\d{2}:\d{2}/.test(s)) return s.slice(0, 5);
  return null;
}

/**
 * Fetch tracking details for a single UPS tracking number. Returns null
 * on transient failure (auth, 4xx/5xx, parse error) — callers should
 * treat the result as best-effort and leave fields unchanged on null.
 */
export async function getUpsTracking(
  trackingNumber: string
): Promise<UpsTrackingInfo | null> {
  if (!trackingNumber || typeof trackingNumber !== "string") return null;
  const trimmed = trackingNumber.trim();
  if (!trimmed) return null;

  let token: string;
  try {
    token = await getUpsAccessToken();
  } catch (e) {
    console.error(
      "[UPS] token fetch failed:",
      e instanceof Error ? e.message : String(e)
    );
    return null;
  }

  // UPS requires a unique transaction id per request. Any short string
  // works — we use a timestamp + random suffix.
  const transactionId = `ssccenter-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const url = `${upsBaseUrl()}/api/track/v1/details/${encodeURIComponent(
    trimmed
  )}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        transId: transactionId,
        transactionSrc: "ssccenter",
        Accept: "application/json",
      },
    });
  } catch (e) {
    console.error(
      "[UPS] tracking fetch network error:",
      e instanceof Error ? e.message : String(e)
    );
    return null;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(
      `[UPS] tracking ${trimmed} → ${res.status} ${text.slice(0, 300)}`
    );
    return null;
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (e) {
    console.error(
      "[UPS] tracking JSON parse failed:",
      e instanceof Error ? e.message : String(e)
    );
    return null;
  }

  return parseUpsTrackingPayload(trimmed, payload);
}

/**
 * Parse the UPS tracking response into our flat UpsTrackingInfo shape.
 * Extracted so it can be unit-tested with a captured fixture payload.
 *
 * UPS response shape (relevant parts):
 *   trackResponse.shipment[0].package[0]
 *     .currentStatus.description
 *     .deliveryDate[]          { type, date }
 *     .deliveryTime            { type, endTime, startTime }
 *     .activity[]              { date, time, status{type,description}, location }
 *
 * deliveryDate[].type values:
 *   "RDD" = Rescheduled Delivery Date   (most current)
 *   "SDD" = Scheduled Delivery Date
 *   "DEL" = Actual Delivery (when delivered)
 */
export function parseUpsTrackingPayload(
  trackingNumber: string,
  payload: unknown
): UpsTrackingInfo {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p: any = payload;
  const pkg =
    p?.trackResponse?.shipment?.[0]?.package?.[0] ||
    p?.trackResponse?.shipment?.[0] ||
    null;

  const currentStatus: string | null =
    pkg?.currentStatus?.description || pkg?.currentStatus?.code || null;

  // Delivery date extraction — prefer Rescheduled, then Scheduled, then Delivered.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deliveryDateList: any[] = Array.isArray(pkg?.deliveryDate)
    ? pkg.deliveryDate
    : [];
  const findByType = (type: string) =>
    normaliseDate(
      deliveryDateList.find((d) => d?.type === type)?.date
    );

  const rescheduled = findByType("RDD");
  const scheduled = findByType("SDD");
  const delivered = findByType("DEL");

  // Best carrier-promised ETA — rescheduled first (most accurate), then
  // scheduled. If neither is present, estimatedDelivery is null.
  const estimatedDelivery = rescheduled || scheduled || null;
  const actualDelivery = delivered || null;

  // Events
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activityList: any[] = Array.isArray(pkg?.activity) ? pkg.activity : [];
  const events: UpsTrackingEvent[] = activityList.map((a) => ({
    date: normaliseDate(a?.date),
    time: normaliseTime(a?.time),
    description:
      a?.status?.description || a?.description || a?.status?.code || null,
    status: a?.status?.type || a?.status?.code || null,
    location:
      [
        a?.location?.address?.city,
        a?.location?.address?.stateProvince,
        a?.location?.address?.country,
      ]
        .filter((v) => typeof v === "string" && v.length > 0)
        .join(", ") || null,
  }));

  // Sort events earliest → latest so the analyzer reads them chronologically.
  events.sort((a, b) => {
    const ak = `${a.date || ""}${a.time || ""}`;
    const bk = `${b.date || ""}${b.time || ""}`;
    return ak.localeCompare(bk);
  });

  // `delivered` flag — trust either an explicit DEL delivery date or a
  // currentStatus that says so.
  const isDelivered =
    !!actualDelivery ||
    (typeof currentStatus === "string" &&
      currentStatus.toLowerCase().includes("delivered"));

  return {
    trackingNumber,
    currentStatus,
    estimatedDelivery,
    actualDelivery,
    delivered: isDelivered,
    events,
    raw: p,
  };
}
