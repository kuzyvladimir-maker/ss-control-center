// Paid-service health monitor — so a data provider can NEVER silently run dry again.
//
// The COGS/enrichment engine depends on paid services (Oxylabs, Unwrangle). When one
// runs out of credits it fails quietly and the engine degrades to Google-estimates
// (junk) without anyone noticing. This probes each service on a schedule, persists a
// health snapshot, and the dashboard surfaces a LOUD banner when anything is low/dry.

import { type Client } from "@libsql/client";

const clean = (v?: string) => (v || "").trim().replace(/^['"]|['"]$/g, "");

export type ServiceStatus = "ok" | "low" | "dry" | "dead" | "unconfigured" | "unknown";
export interface ServiceHealth {
  key: string;
  name: string;
  status: ServiceStatus;
  remaining: number | null; // credits left, when the API exposes it
  note?: string;
  at: string;
}
export interface ServiceHealthSnapshot {
  at: string;
  services: ServiceHealth[];
  anyDry: boolean; // a configured, engine-critical service is at 0
  anyLow: boolean; // below the alert floor
}

const UNWRANGLE_LOW_FLOOR = 5000; // warn below this many credits

/** Build a paid-service snapshot without making billable synthetic requests.
 *  Unwrangle has no free balance endpoint, so only its last provider receipt is
 *  reported. Oxylabs has no cheap balance API; configured does not mean live. */
export async function probePaidServices(db: Client): Promise<ServiceHealthSnapshot> {
  const at = new Date().toISOString();
  const services: ServiceHealth[] = [];

  // ── Unwrangle (Target / Sam's / Costco / Instacart→Publix,Aldi,BJ's) ──
  const uw = clean(process.env.UNWRANGLE_API_KEY);
  if (!uw) {
    services.push({ key: "unwrangle", name: "Unwrangle (Target/Sam's/Costco/Instacart)", status: "unconfigured", remaining: null, at });
  } else {
    const h: ServiceHealth = { key: "unwrangle", name: "Unwrangle (Target/Sam's/Costco/Instacart)", status: "unknown", remaining: null, at };
    try {
      const cached = await db.execute(`SELECT value FROM "Setting" WHERE key='svc_unwrangle_credits' LIMIT 1`);
      const raw = cached.rows[0]?.value;
      const receipt: any = raw ? JSON.parse(String(raw)) : null;
      const rem = typeof receipt?.remaining === "number" ? receipt.remaining : null;
      h.remaining = rem;
      h.status = rem === 0 ? "dry" : rem != null && rem < UNWRANGLE_LOW_FLOOR ? "low" : rem != null ? "ok" : "unknown";
      h.note = rem == null
        ? "live paid probe disabled; no cached provider receipt"
        : `cached provider receipt${receipt?.at ? ` from ${receipt.at}` : ""}; live paid probe disabled`;
    } catch { h.status = "unknown"; h.note = "cached provider receipt unavailable; live paid probe disabled"; }
    services.push(h);
  }

  // ── Oxylabs (Walmart 1P + Google Shopping) — no cheap balance API; liveness only ──
  const ox = clean(process.env.OXYLABS_USERNAME);
  services.push({ key: "oxylabs", name: "Oxylabs (Walmart 1P + Google)", status: ox ? "unknown" : "unconfigured", remaining: null, note: ox ? "configured; live paid probe disabled" : undefined, at });

  // ── BlueCart — deactivated permanently ──
  services.push({ key: "bluecart", name: "BlueCart", status: "dead", remaining: null, note: "deactivated permanently", at });

  const anyDry = services.some((s) => s.status === "dry");
  const anyLow = services.some((s) => s.status === "low");
  const snap: ServiceHealthSnapshot = { at, services, anyDry, anyLow };

  try {
    await db.execute({
      sql: `INSERT INTO "Setting"(key, value) VALUES('svc_health', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      args: [JSON.stringify(snap)],
    });
  } catch { /* best-effort persist */ }
  return snap;
}

/** Read the last persisted health snapshot (for the dashboard). */
export async function getPaidServiceHealth(db: Client): Promise<ServiceHealthSnapshot | null> {
  try {
    const r = await db.execute(`SELECT value FROM "Setting" WHERE key='svc_health' LIMIT 1`);
    const v = r.rows[0]?.value as string | undefined;
    return v ? (JSON.parse(v) as ServiceHealthSnapshot) : null;
  } catch {
    return null;
  }
}
