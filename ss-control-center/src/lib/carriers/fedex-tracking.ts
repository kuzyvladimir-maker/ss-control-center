/**
 * FedEx Track API client — OAuth client_credentials + tracking lookup.
 *
 * Mirrors ups-tracking.ts in shape so the enricher can call either with
 * the same expectations: returns null on failure, populates the same
 * canonical fields (currentStatus, estimatedDelivery, actualDelivery,
 * delivered, events[]).
 *
 * Endpoints:
 *   Prod:    https://apis.fedex.com
 *   Sandbox: https://apis-sandbox.fedex.com
 *
 * Reference: https://developer.fedex.com/api/en-us/catalog/track.html
 */

import type { UpsTrackingEvent, UpsTrackingInfo } from "./ups-tracking";

// Reuse the canonical types from ups-tracking so the enricher can treat
// both carriers identically. The names stay UPS-prefixed for now to
// avoid a churn rename — they're shape-compatible carrier-agnostic types.
export type FedexTrackingEvent = UpsTrackingEvent;
export type FedexTrackingInfo = UpsTrackingInfo;

type TokenCache = {
  accessToken: string;
  expiresAt: number;
};

let cachedToken: TokenCache | null = null;

function fedexBaseUrl(): string {
  return process.env.FEDEX_ENV === "production"
    ? "https://apis.fedex.com"
    : "https://apis-sandbox.fedex.com";
}

export async function getFedexAccessToken(): Promise<string> {
  const clientId = process.env.FEDEX_CLIENT_ID;
  const clientSecret = process.env.FEDEX_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "FedEx credentials missing — set FEDEX_CLIENT_ID and FEDEX_CLIENT_SECRET in .env"
    );
  }

  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken;
  }

  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");
  params.set("client_id", clientId);
  params.set("client_secret", clientSecret);

  const res = await fetch(`${fedexBaseUrl()}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`FedEx OAuth failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const token = data.access_token;
  const expiresInSec = Number(data.expires_in) || 3600;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("FedEx OAuth returned no access_token");
  }

  cachedToken = {
    accessToken: token,
    expiresAt: Date.now() + (expiresInSec - 300) * 1000,
  };
  return token;
}

function normaliseDate(d: unknown): string | null {
  if (typeof d !== "string") return null;
  const s = d.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

function normaliseTime(d: unknown): string | null {
  if (typeof d !== "string") return null;
  // FedEx returns ISO 8601 datetimes — extract HH:MM
  const m = d.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : null;
}

/**
 * Fetch tracking details for a single FedEx tracking number. Returns
 * null on failure (auth, HTTP error, parse error).
 */
export async function getFedexTracking(
  trackingNumber: string
): Promise<FedexTrackingInfo | null> {
  if (!trackingNumber || typeof trackingNumber !== "string") return null;
  const trimmed = trackingNumber.trim();
  if (!trimmed) return null;

  let token: string;
  try {
    token = await getFedexAccessToken();
  } catch (e) {
    console.error(
      "[FedEx] token fetch failed:",
      e instanceof Error ? e.message : String(e)
    );
    return null;
  }

  const body = {
    includeDetailedScans: true,
    trackingInfo: [
      {
        trackingNumberInfo: { trackingNumber: trimmed },
      },
    ],
  };

  let res: Response;
  try {
    res = await fetch(`${fedexBaseUrl()}/track/v1/trackingnumbers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-locale": "en_US",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error(
      "[FedEx] tracking fetch network error:",
      e instanceof Error ? e.message : String(e)
    );
    return null;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(
      `[FedEx] tracking ${trimmed} → ${res.status} ${text.slice(0, 300)}`
    );
    return null;
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (e) {
    console.error(
      "[FedEx] tracking JSON parse failed:",
      e instanceof Error ? e.message : String(e)
    );
    return null;
  }

  return parseFedexTrackingPayload(trimmed, payload);
}

/**
 * Parse the FedEx tracking response into our canonical TrackingInfo
 * shape. Public so it can be unit-tested with a captured fixture.
 *
 * FedEx response shape (relevant parts):
 *   output.completeTrackResults[0].trackResults[0]
 *     .latestStatusDetail.description     ("In transit", "Delivered", ...)
 *     .latestStatusDetail.code            ("IT", "DL", ...)
 *     .estimatedDeliveryTimeWindow.window.ends   (ISO datetime)
 *     .standardTransitTimeWindow.window.ends     (fallback ISO datetime)
 *     .dateAndTimes[]                     ([{type, dateTime}])
 *        type values: "ACTUAL_DELIVERY", "ESTIMATED_DELIVERY",
 *                     "ACTUAL_PICKUP", "SHIP", "ANTICIPATED_TENDER"
 *     .scanEvents[]                       ([{date, eventDescription, scanLocation, ...}])
 */
export function parseFedexTrackingPayload(
  trackingNumber: string,
  payload: unknown
): FedexTrackingInfo {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p: any = payload;

  const tr =
    p?.output?.completeTrackResults?.[0]?.trackResults?.[0] ||
    p?.completeTrackResults?.[0]?.trackResults?.[0] ||
    null;

  const currentStatus: string | null =
    tr?.latestStatusDetail?.description ||
    tr?.latestStatusDetail?.code ||
    null;

  // Delivery date — try several FedEx-specific paths in priority order
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dateTimes: any[] = Array.isArray(tr?.dateAndTimes)
    ? tr.dateAndTimes
    : [];
  const findDateByType = (type: string) =>
    normaliseDate(
      dateTimes.find(
        (d) =>
          typeof d?.type === "string" &&
          d.type.toUpperCase() === type.toUpperCase()
      )?.dateTime
    );

  const actualDelivery = findDateByType("ACTUAL_DELIVERY");
  const estimatedFromDateTimes = findDateByType("ESTIMATED_DELIVERY");

  // estimatedDeliveryTimeWindow tends to be the freshest carrier promise
  const estimatedFromWindow = normaliseDate(
    tr?.estimatedDeliveryTimeWindow?.window?.ends ||
      tr?.estimatedDeliveryTimeWindow?.window?.begins
  );
  const standardFromWindow = normaliseDate(
    tr?.standardTransitTimeWindow?.window?.ends
  );

  const estimatedDelivery =
    estimatedFromWindow ||
    estimatedFromDateTimes ||
    standardFromWindow ||
    null;

  // Events
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scanList: any[] = Array.isArray(tr?.scanEvents) ? tr.scanEvents : [];
  const events: FedexTrackingEvent[] = scanList.map((s) => ({
    date: normaliseDate(s?.date),
    time: normaliseTime(s?.date),
    description: s?.eventDescription || s?.derivedStatus || null,
    status: s?.eventType || s?.derivedStatusCode || null,
    location:
      [
        s?.scanLocation?.city,
        s?.scanLocation?.stateOrProvinceCode,
        s?.scanLocation?.countryCode,
      ]
        .filter((v) => typeof v === "string" && v.length > 0)
        .join(", ") || null,
  }));

  events.sort((a, b) => {
    const ak = `${a.date || ""}${a.time || ""}`;
    const bk = `${b.date || ""}${b.time || ""}`;
    return ak.localeCompare(bk);
  });

  const isDelivered =
    !!actualDelivery ||
    (typeof currentStatus === "string" &&
      currentStatus.toLowerCase().includes("delivered")) ||
    tr?.latestStatusDetail?.code === "DL";

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
