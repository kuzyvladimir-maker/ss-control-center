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

import Anthropic from "@anthropic-ai/sdk";

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
export function filterRealLogos(logos: string[]): string[] {
  const whitelist = OWN_BRANDS_WHITELIST.map((s) => s.toLowerCase());
  const ignorelist = GENERIC_DELI_TERMS_IGNORELIST.map((s) =>
    s.toLowerCase(),
  );
  return logos.filter((raw) => {
    const lower = (raw ?? "").trim().toLowerCase();
    if (!lower) return false;
    if (whitelist.includes(lower)) return false;
    if (ignorelist.includes(lower)) return false;
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

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (_client) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  _client = new Anthropic({ apiKey: key });
  return _client;
}

// Sonnet 4.5 pricing per Anthropic public pricing page (per 1M tokens):
//   input  $3.00
//   output $15.00
// We convert to cents per request from the usage block.
function estimateCostCents(usage: {
  input_tokens: number;
  output_tokens: number;
}): number {
  const dollars =
    (usage.input_tokens / 1_000_000) * 3.0 +
    (usage.output_tokens / 1_000_000) * 15.0;
  return Math.max(1, Math.ceil(dollars * 100));
}

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

export async function detectForeignLogosInImage(
  imageUrl: string,
  ownBrand: string,
): Promise<VisionCheckResult> {
  const stub = getVisionStub();
  if (stub) return stub(imageUrl, ownBrand);
  if (!imageUrl) return SAFE_EMPTY;
  const client = getClient();
  if (!client) {
    return { ...SAFE_EMPTY, error: "ANTHROPIC_API_KEY not set" };
  }

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: imageUrl } },
            {
              type: "text",
              text:
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
                `{"detected_logos": ["Brand1", "Brand2"], "has_foreign_logos": true_or_false}`,
            },
          ],
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return { ...SAFE_EMPTY, error: "no text block in response" };
    }
    // Claude sometimes wraps JSON in ```json fences even when told not to.
    // Strip leading/trailing prose conservatively.
    const raw = textBlock.text.trim();
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd <= jsonStart) {
      return { ...SAFE_EMPTY, error: "no JSON object in response" };
    }
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));

    const cost_cents = estimateCostCents({
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    });

    // Raw Vision output may include own-brand mentions or generic
    // deli/snack terms — strip both before they reach the risk-scorer
    // so we don't fire +35 risk on a Salutem-branded box.
    const rawLogos: string[] = Array.isArray(parsed.detected_logos)
      ? parsed.detected_logos.filter((s: unknown) => typeof s === "string")
      : [];
    const realLogos = filterRealLogos(rawLogos);

    return {
      has_foreign_logos: realLogos.length > 0,
      detected_logos: realLogos,
      cost_cents,
    };
  } catch (e) {
    return {
      ...SAFE_EMPTY,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
