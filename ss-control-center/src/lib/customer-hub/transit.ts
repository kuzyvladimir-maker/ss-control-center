/**
 * Transit facts from carrier tracking events — pure.
 *
 * In seven months of owner-approved ChatGPT answers (see
 * docs/wiki/customer-hub-owner-playbook.md) the strongest single argument
 * was transit time in hours: "picked up Tuesday 14:06, delivered Thursday
 * 15:34, about 49 hours". The analyzer prompt only had ship/delivery dates,
 * so it could not say this. These helpers derive it from the events.
 *
 * Event times are local to each scan location, so the hour count is an
 * approximation (± a couple of hours across time zones) — the prompt says
 * "approximately".
 */

export interface TransitEvent {
  date?: string | null;
  time?: string | null;
  description?: string | null;
  status?: string | null;
  location?: string | null;
}

export interface TransitFacts {
  /** First scan where the carrier actually had the package. */
  firstCarrierScan: string | null;
  delivered: string | null;
  transitHours: number | null;
  /** Delivered-event wording worth quoting ("Left at front door", "Received by …"). */
  deliveryDetail: string | null;
  /** Most recent scan (any event), "YYYY-MM-DD HH:MM" — the latest known position. */
  lastScan: string | null;
  /** Location of the most recent scan ("Flint, MI"). */
  lastLocation: string | null;
  /** Wording of the most recent scan ("Arrived at a carrier facility", "Package delayed in transit"). */
  lastStatus: string | null;
  /** Carrier flagged the package delayed somewhere in its history. */
  delayed: boolean;
  /** Distinct scan locations in order ("Portland, OR → Indianapolis, IN → Flint, MI") — shows looping. */
  route: string | null;
  /** Number of carrier scans (movement events), to spot a package bouncing around. */
  scanCount: number;
  /**
   * Days the carrier has held the package: first scan → delivery, or first
   * scan → `now` when still undelivered (so "12 days and counting" is a fact,
   * not a guess). Null without a carrier scan.
   */
  daysInTransit: number | null;
}

function at(e: TransitEvent): number | null {
  if (!e.date) return null;
  const t = Date.parse(`${e.date}T${(e.time || "12:00").slice(0, 5)}:00Z`);
  return Number.isNaN(t) ? null : t;
}

const LABEL_ONLY_RE =
  /label created|created a label|has not received|label has been created|shipment information sent|awaiting item|pre-shipment|shipping label created/i;

function isCarrierScan(e: TransitEvent): boolean {
  if ((e.status || "").toUpperCase() === "M") return false;
  return !LABEL_ONLY_RE.test(e.description || "");
}

function isDelivered(e: TransitEvent): boolean {
  return (e.status || "").toUpperCase() === "D" || /\bdelivered\b/i.test(e.description || "");
}

function label(e: TransitEvent): string {
  return [e.date, e.time].filter(Boolean).join(" ");
}

const DELAY_RE = /delay|held|exception|not be delivered|rescheduled|return to sender|undeliverable/i;

export function transitFacts(
  events: TransitEvent[] | null | undefined,
  now: Date = new Date(),
): TransitFacts {
  const list = (events || []).filter((e) => at(e) !== null);
  list.sort((a, b) => (at(a) as number) - (at(b) as number));
  const first = list.find(isCarrierScan) || null;
  const delivered = [...list].reverse().find(isDelivered) || null;
  const last = list.length ? list[list.length - 1] : null;
  let transitHours: number | null = null;
  if (first && delivered) {
    const h = ((at(delivered) as number) - (at(first) as number)) / 3_600_000;
    transitHours = h >= 0 ? Math.round(h) : null;
  }
  let daysInTransit: number | null = null;
  if (first) {
    const end = delivered ? (at(delivered) as number) : now.getTime();
    const d = (end - (at(first) as number)) / 86_400_000;
    daysInTransit = d >= 0 ? Math.round(d) : null;
  }
  const detail = delivered
    ? [delivered.description, delivered.location].map((s) => (s || "").trim()).filter(Boolean).join(" @ ")
    : null;
  // Route = distinct scan locations in order (consecutive duplicates collapsed),
  // so a package bouncing Portland → Indianapolis → Pontiac → Flint is visible.
  const scans = list.filter(isCarrierScan);
  const locs: string[] = [];
  for (const e of scans) {
    const loc = (e.location || "").trim();
    if (loc && loc !== locs[locs.length - 1]) locs.push(loc);
  }
  return {
    firstCarrierScan: first ? label(first) : null,
    delivered: delivered ? label(delivered) : null,
    transitHours,
    deliveryDetail: detail || null,
    lastScan: last ? label(last) : null,
    lastLocation: (last?.location || "").trim() || null,
    lastStatus: (last?.description || "").trim() || null,
    delayed: list.some((e) => DELAY_RE.test(e.description || "")),
    daysInTransit,
    route: locs.length ? locs.join(" → ") : null,
    scanCount: scans.length,
  };
}

/** ISO dates the owner wrote in a correction: 2026-10-20, 20.10(.2026), 10/20. */
export function ownerStatedDates(text: string | null | undefined, refIso?: string | null): string[] {
  if (!text) return [];
  const year = (refIso || new Date().toISOString()).slice(0, 4);
  const pad = (n: string) => n.padStart(2, "0");
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) out.add(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of text.matchAll(/\b(\d{1,2})\.(\d{2})(?:\.(20\d{2}))?\b/g))
    if (+m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) out.add(`${m[3] || year}-${pad(m[2])}-${pad(m[1])}`);
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?\b/g))
    if (+m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31) out.add(`${m[3] || year}-${pad(m[1])}-${pad(m[2])}`);
  return [...out];
}
