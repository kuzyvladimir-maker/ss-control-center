// Claude Vision logo-detection wrapper for the listing audit.
//
// One call = one main-product image. We ask Sonnet 4.5 to list every
// brand logo or packaging label visible, distinguishing the seller's own
// brand from foreign brands. The risk-scorer adds +35 when this returns
// `has_foreign_logos: true`.
//
// Cost: roughly $0.01–0.02 per image. The scanner skips the call when
// score is already at BLOCKED (>=80) to keep a typical 1k-listing scan
// under ~$20.
//
// Failure mode: any error (no API key, network, JSON parse) returns a
// "clean" result with cost 0. We DO NOT want a flaky vision call to
// silently down-rank a risky listing — that's a separate signal handled
// by the scanner (it logs the failure to scan.error_message and the
// listing keeps whatever score came out of the text-only rules).
//
// False-positive filtering: Claude Vision occasionally tags our own
// brand ("Salutem Solutions" / "Salutem Vita" / "Starfit") as a foreign
// logo, and sometimes confuses generic deli-meat product-type names
// ("Olive Loaf", "Bologna", …) for brand names. Both groups are
// filtered out via `filterRealLogos` before the result is returned, so
// the risk-scorer never sees them as foreign-brand violations.

import { identifyImageViaClaudeCli } from "@/lib/image-gen/codex-worker";

/**
 * Names that may appear in Vision detections but are NOT foreign
 * brands — they're our own. Compared case-insensitively. Add new
 * Salutem-owned brands here when they launch.
 */
export const OWN_BRANDS_WHITELIST = [
  "Salutem Vita",
  "Salutem Solutions",
  "Starfit",
  "Salutem",
] as const;

/**
 * Generic product-type names that GPT-style models sometimes report as
 * "brand logos" because packaging puts them in logo-like badges. These
 * are categories, not brands — filtering them out removes a large chunk
 * of WARNING false-positives on deli, snack, and gift-set listings.
 * Compared case-insensitively.
 */
export const GENERIC_DELI_TERMS_IGNORELIST = [
  "Olive Loaf",
  "Bologna",
  "Pastrami",
  "Salami",
  "Mortadella",
  "Hot Dogs",
  "Bacon",
  "Ham",
  "Turkey",
  "Chicken",
  "Beef",
  "Pork",
  "Lunch Meat",
  "Deli Meat",
  "Cold Cuts",
  "Snack Mix",
  "Gift Set",
  "Pack",
  "Lunch Snacks",
  "Original",
  "Classic",
] as const;

/**
 * Apply both filters to a raw Vision detected_logos array and return
 * only the "real foreign logos" — neither our own brand nor a generic
 * product-type. Used by `detectForeignLogosInImage` (live path) AND
 * by `scripts/rescore-audit-scan.ts` (offline re-evaluation of stored
 * detections without re-running the Vision API).
 */
export function filterRealLogos(
  logos: string[],
  allowedBrands: string[] = [],
): string[] {
  const whitelist = OWN_BRANDS_WHITELIST.map((s) => s.toLowerCase());
  const ignorelist = GENERIC_DELI_TERMS_IGNORELIST.map((s) =>
    s.toLowerCase(),
  );
  // Component brands the bundle legitimately resells (Phase 3): they APPEAR in
  // the frozen-hero image on purpose (genuine goods, first-sale / gift-basket
  // exception), so they are expected — not foreign-brand violations.
  const allowed = allowedBrands
    .map((s) => (s ?? "").trim().toLowerCase())
    .filter(Boolean);
  return logos.filter((raw) => {
    const lower = (raw ?? "").trim().toLowerCase();
    if (!lower) return false;
    if (whitelist.includes(lower)) return false;
    if (ignorelist.includes(lower)) return false;
    if (allowed.some((a) => lower.includes(a) || a.includes(lower))) return false;
    return true;
  });
}

export interface VisionCheckResult {
  has_foreign_logos: boolean;
  detected_logos: string[];
  cost_cents: number;
  /** When the call failed (no key, network, JSON parse). Scanner uses
   *  this to log the failure rather than silently treating "no logos" as
   *  a real signal. */
  error?: string;
}

const SAFE_EMPTY: VisionCheckResult = {
  has_foreign_logos: false,
  detected_logos: [],
  cost_cents: 0,
};


/**
 * Test seam — when set, `detectForeignLogosInImage` skips the real
 * Anthropic call and delegates here. Used by smoke scripts so an end-to-
 * end run of the image pipeline can exercise Rule 6 without paying for
 * Vision. Matches the stub pattern in content-generation.ts and
 * image-generation.ts.
 */
type VisionStub = (imageUrl: string, ownBrand: string) => Promise<VisionCheckResult>;

function getVisionStub(): VisionStub | null {
  const stub = (globalThis as { __BUNDLE_FACTORY_VISION_STUB__?: VisionStub })
    .__BUNDLE_FACTORY_VISION_STUB__;
  return typeof stub === "function" ? stub : null;
}

function visionPrompt(ownBrand: string): string {
  return (
    `You are a compliance reviewer for Amazon product listings. ` +
    `Identify ALL brand logos and packaging visible in this image.\n\n` +
    `Own brand: "${ownBrand}" — OK to appear.\n\n` +
    `Identify any OTHER brands clearly visible (logos, branded ` +
    `packaging, brand text). Common brands to watch for: Kraft, ` +
    `Goya, Ore-Ida, El Monterey, Oh Snap!, Lunchables, ` +
    `Uncrustables, Jimmy Dean, Hormel, Tyson, Hershey's, ` +
    `Ghirardelli, Coca-Cola, Pepsi, Starbucks, Pringles, ` +
    `Cheez-It, Goldfish, Cheetos, Doritos, Pop-Tarts.\n\n` +
    `Respond ONLY with valid JSON, no preamble:\n` +
    `{"detected_logos": ["Brand1", "Brand2"], "has_foreign_logos": true_or_false}`
  );
}

/** Subscription-first vision (Claude Max via the box worker, $0) — fetches the
 *  image and asks /analyze-claude. Returns null on ANY failure so the caller
 *  falls back to the paid API. Same architecture as content-gen + identify. */
async function detectViaSubscription(
  imageUrl: string,
  ownBrand: string,
  allowedBrands: string[],
): Promise<VisionCheckResult | null> {
  try {
    const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) });
    if (!imgRes.ok) return null;
    const b64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");
    const parsed = await identifyImageViaClaudeCli([b64], visionPrompt(ownBrand), {
      timeoutMs: 200_000,
    });
    if (!parsed || typeof parsed !== "object") return null;
    const rawLogos: string[] = Array.isArray(parsed.detected_logos)
      ? (parsed.detected_logos as unknown[]).filter((s): s is string => typeof s === "string")
      : [];
    const realLogos = filterRealLogos(rawLogos, allowedBrands);
    return {
      has_foreign_logos: realLogos.length > 0,
      detected_logos: realLogos,
      cost_cents: 0, // Max subscription — no metered spend
    };
  } catch {
    return null;
  }
}

export async function detectForeignLogosInImage(
  imageUrl: string,
  ownBrand: string,
  /** Component brands the bundle legitimately resells (Phase 3) — expected in
   *  the frozen hero, so not counted as foreign-brand violations. */
  allowedBrands: string[] = [],
): Promise<VisionCheckResult> {
  const stub = getVisionStub();
  if (stub) return stub(imageUrl, ownBrand);
  if (!imageUrl) return SAFE_EMPTY;
  // Env-based skip survives the HTTP boundary — unlike
  // __BUNDLE_FACTORY_VISION_STUB__, which is globalThis-only and never
  // reaches a long-running dev/Vercel process from a separate smoke
  // runner. Set BUNDLE_FACTORY_VISION_SKIP=1 when launching the dev
  // server during smoke runs to make every Rule 6 invocation return
  // SAFE_EMPTY (no logos, no API call, no cost). Never set this in prod.
  if (process.env.BUNDLE_FACTORY_VISION_SKIP === "1") {
    return SAFE_EMPTY;
  }

  // Subscription FIRST (Vladimir 2026-07-07): the paid-API credit exhaustion
  // silently blocked EVERY generated image via this gate — the generation ran
  // fine, then rule-6 failed each attempt. $0 on the Max subscription.
  const viaSub = await detectViaSubscription(imageUrl, ownBrand, allowedBrands);
  if (viaSub) return viaSub;

  // No paid fallback. It used to sit here, and it was worse than useless: the
  // paid balance ran out, so EVERY generated image failed this gate silently
  // while generation itself looked fine. A gate that cannot answer must say so.
  return {
    ...SAFE_EMPTY,
    error: "The Claude subscription vision lane did not answer. This platform "
      + "holds no paid API keys, so there is no fallback.",
  };
}
