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

import Anthropic from "@anthropic-ai/sdk";

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

export async function detectForeignLogosInImage(
  imageUrl: string,
  ownBrand: string,
): Promise<VisionCheckResult> {
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

    return {
      has_foreign_logos: parsed.has_foreign_logos === true,
      detected_logos: Array.isArray(parsed.detected_logos)
        ? parsed.detected_logos.filter((s: unknown) => typeof s === "string")
        : [],
      cost_cents,
    };
  } catch (e) {
    return {
      ...SAFE_EMPTY,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
