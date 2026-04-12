/**
 * USPS Tracking API v3 client — OAuth client_credentials + tracking lookup.
 *
 * Mirrors ups-tracking.ts / fedex-tracking.ts in shape so the enricher
 * can call all three identically. Returns null on failure, populates
 * the same canonical fields (currentStatus, estimatedDelivery,
 * actualDelivery, delivered, events[]).
 *
 * Endpoints (USPS only has one production base — no separate sandbox host):
 *   apis.usps.com  (production + test routed by env / scopes)
 *
 * Reference: https://developer.usps.com/trackingv3
 */

import type { UpsTrackingEvent, UpsTrackingInfo } from "./ups-tracking";

export type UspsTrackingEvent = UpsTrackingEvent;
export type UspsTrackingInfo = UpsTrackingInfo;

type TokenCache = {
  accessToken: string;
  expiresAt: number;
};

let cachedToken: TokenCache | null = null;

function uspsBaseUrl(): string {
  // USPS uses the same hostname for both, but keep this knob for parity.
  return "https://apis.usps.com";
}

export async function getUspsAccessToken(): Promise<string> {
  const clientId = process.env.USPS_CLIENT_ID;
  const clientSecret = process.env.USPS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "USPS credentials missing — set USPS_CLIENT_ID and USPS_CLIENT_SECRET in .env"
    );
  }

  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken;
  }

  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");
  params.set("client_id", clientId);
  params.set("client_secret", clientSecret);

  const res = await fetch(`${uspsBaseUrl()}/oauth2/v3/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`USPS OAuth failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const token = data.access_token;
  const expiresInSec = Number(data.expires_in) || 3600;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("USPS OAuth returned no access_token");
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
  const m = d.match(/T?(\d{2}:\d{2})/);
  return m ? m[1] : null;
}

/**
 * Fetch tracking details for a single USPS tracking number. Returns
 * null on failure (auth, HTTP error, parse error).
 */
export async function getUspsTracking(
  trackingNumber: string
): Promise<UspsTrackingInfo | null> {
  if (!trackingNumber || typeof trackingNumber !== "string") return null;
  const trimmed = trackingNumber.trim();
  if (!trimmed) return null;

  let token: string;
  try {
    token = await getUspsAccessToken();
  } catch (e) {
    console.error(
      "[USPS] token fetch failed:",
      e instanceof Error ? e.message : String(e)
    );
    return null;
  }

  // The tracking endpoint returns a richer payload when expand=DETAIL
  // so we get the full scan event history, not just the latest summary.
  const url = `${uspsBaseUrl()}/tracking/v3/tracking/${encodeURIComponent(
    trimmed
  )}?expand=DETAIL`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  } catch (e) {
    console.error(
      "[USPS] tracking fetch network error:",
      e instanceof Error ? e.message : String(e)
    );
    return null;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(
      `[USPS] tracking ${trimmed} → ${res.status} ${text.slice(0, 300)}`
    );
    return null;
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (e) {
    console.error(
      "[USPS] tracking JSON parse failed:",
      e instanceof Error ? e.message : String(e)
    );
    return null;
  }

  return parseUspsTrackingPayload(trimmed, payload);
}

/**
 * Parse the USPS Tracking v3 response into the canonical TrackingInfo
 * shape. Public so it can be unit-tested with a captured fixture.
 *
 * USPS response shape (relevant parts):
 *   {
 *     trackingNumber,
 *     statusSummary,                ← "Delivered" / "In Transit" / etc.
 *     statusCategory,               ← "Delivered" / "Pre-Shipment" / etc.
 *     expectedDeliveryDate,         ← "2026-04-15"  (carrier-promised ETA)
 *     expectedDeliveryTimeStart,
 *     expectedDeliveryTimeEnd,
 *     actualDeliveryDate,           ← present once delivered
 *     trackingEvents: [
 *       {
 *         eventType,                ← "DELIVERED", "ARRIVAL_AT_UNIT", ...
 *         eventCode,
 *         eventTimestamp,           ← "2026-04-15T14:32:00"
 *         eventCity,
 *         eventState,
 *         eventCountry,
 *         eventDescription,         ← human-readable
 *       },
 *     ],
 *   }
 */
export function parseUspsTrackingPayload(
  trackingNumber: string,
  payload: unknown
): UspsTrackingInfo {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p: any = payload;

  const currentStatus: string | null =
    p?.statusSummary || p?.statusCategory || null;

  const estimatedDelivery = normaliseDate(p?.expectedDeliveryDate);
  const actualDelivery = normaliseDate(p?.actualDeliveryDate);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eventList: any[] = Array.isArray(p?.trackingEvents)
    ? p.trackingEvents
    : [];
  const events: UspsTrackingEvent[] = eventList.map((e) => ({
    date: normaliseDate(e?.eventTimestamp),
    time: normaliseTime(e?.eventTimestamp),
    description: e?.eventDescription || e?.eventType || null,
    status: e?.eventType || e?.eventCode || null,
    location:
      [e?.eventCity, e?.eventState, e?.eventCountry]
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
    p?.statusCategory === "Delivered";

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
