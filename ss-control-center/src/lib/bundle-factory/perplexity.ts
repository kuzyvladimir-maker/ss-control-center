/**
 * Perplexity API client for Bundle Factory Stage 2 (Research).
 *
 * Model: `sonar-pro` — grounded research with web citations. We instruct it
 * to find retail-available products near Clearwater, FL and return a strict
 * JSON object. Temperature is low (0.2) because we want grounded facts, not
 * creative writing.
 *
 * Docs: https://docs.perplexity.ai/reference/post_chat_completions
 *
 * Failure modes are surfaced as thrown errors with the raw response embedded
 * in the message so the orchestrator can stash it into
 * `GenerationStage.error` for post-mortem.
 */

const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";
const MODEL = "sonar-pro";

export interface PerplexityResearchProduct {
  product_name: string;
  brand: string;
  manufacturer?: string;
  upc?: string;
  pack_sizes?: string[];
  flavors?: string[];
  weight_oz?: number;
  ingredients?: string;
  allergens?: string[];
  storage_temp?: "Frozen" | "Refrigerated" | "Ambient";
  expiration_days?: number;
  avg_price_cents?: number;
  source_store_name?: string;
  source_url?: string;
  reference_image_urls?: string[];
  freshness_score?: number;
  in_stock_confidence?: "high" | "medium" | "low";
  notes?: string;
}

export interface PerplexityResearchResponse {
  products: PerplexityResearchProduct[];
  citations: string[];
  raw_response: string;
}

export interface ResearchProductsParams {
  query: string;
  category: string;
  brand_hint?: string;
  max_products?: number;
  sourcing_radius_stores: string[];
}

export async function researchProducts(
  params: ResearchProductsParams,
): Promise<PerplexityResearchResponse> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error("PERPLEXITY_API_KEY is not set");

  const systemPrompt = buildSystemPrompt(params);
  const userPrompt = buildUserPrompt(params);

  const response = await fetch(PERPLEXITY_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 4000,
      return_citations: true,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Perplexity API ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    citations?: string[];
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  const citations: string[] = Array.isArray(data.citations) ? data.citations : [];

  const products = parseProductsFromResponse(content);

  return { products, citations, raw_response: content };
}

function buildSystemPrompt(params: ResearchProductsParams): string {
  const minCount = /variety|assortment/i.test(params.query) ? 15 : 10;
  return `You are a retail product researcher for an e-commerce business in Clearwater, Florida.
Your job is to find retail-available products that can be purchased TODAY from physical stores within a 10-mile radius of zip code 33765 and used as components in gift bundles.

AVAILABLE STORES (priority order):
${params.sourcing_radius_stores.join(", ")}

PRODUCT CATEGORY: ${params.category}

OUTPUT FORMAT: Return ONLY a valid JSON object with this exact structure (no markdown, no commentary, only the object):
{
  "products": [
    {
      "product_name": "string (full retail name)",
      "brand": "string (manufacturer brand)",
      "manufacturer": "string (legal manufacturer entity, if known)",
      "upc": "string (12-digit UPC if known, omit otherwise)",
      "pack_sizes": ["array of available pack counts"],
      "flavors": ["array of flavor variants"],
      "weight_oz": number,
      "ingredients": "string (short, if known)",
      "allergens": ["Milk", "Wheat", "Soybeans", "Eggs", "Fish", "Crustacean shellfish", "Tree nuts", "Peanuts", "Sesame"],
      "storage_temp": "Frozen" | "Refrigerated" | "Ambient",
      "expiration_days": number,
      "avg_price_cents": number,
      "source_store_name": "string",
      "source_url": "string",
      "reference_image_urls": ["https://..."],
      "freshness_score": number,
      "in_stock_confidence": "high" | "medium" | "low",
      "notes": "string"
    }
  ]
}

RULES:
- Only include products that exist at major US retailers TODAY (2026).
- Prefer broad availability (Walmart > Target > Publix > specialty).
- For frozen items, verify they ship/store frozen.
- freshness_score: established brands like Lunchables / Jimmy Dean = 90+, seasonal items 60-80, specialty 40-60.
- Allergens MUST use the exact FDA terms listed above; omit field if none apply.
- Return AT LEAST ${minCount} products if the query allows.
- avg_price_cents is the retail single-unit price in cents (850 = $8.50).
- NO markdown, NO commentary, ONLY the JSON object.`;
}

function buildUserPrompt(params: ResearchProductsParams): string {
  const brandLine = params.brand_hint
    ? `Focus brand: ${params.brand_hint}.`
    : "Broad search across multiple brands.";
  return `Find 15-25 retail products that match this concept:

"${params.query}"

${brandLine}

These products will be combined into a gift bundle. Prioritize:
1. Visually appealing packaging.
2. Reliable retail availability (in stock 90%+ of the year).
3. Reasonable per-unit price ($1-$10 typical).
4. Compatible storage requirements.

Return the JSON object now.`;
}

/**
 * Strip ```json fences (Perplexity occasionally adds them despite the
 * instruction) and pull out the JSON object between the first `{` and
 * last `}`. Throws with a snippet of the raw response on failure so
 * upstream can persist it for debugging.
 */
export function parseProductsFromResponse(
  content: string,
): PerplexityResearchProduct[] {
  let jsonStr = content.trim();
  if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*/, "").replace(/\s*```\s*$/, "");
  }
  const firstBrace = jsonStr.indexOf("{");
  const lastBrace = jsonStr.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("Perplexity response did not contain a JSON object");
  }
  jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);

  let parsed: { products?: unknown };
  try {
    parsed = JSON.parse(jsonStr) as { products?: unknown };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    throw new Error(
      `Failed to parse Perplexity JSON: ${msg}\n\nRaw: ${jsonStr.slice(0, 500)}`,
    );
  }
  if (!parsed.products || !Array.isArray(parsed.products)) {
    throw new Error("Perplexity response missing 'products' array");
  }
  return parsed.products as PerplexityResearchProduct[];
}

/**
 * Three-product mock returned in development when PERPLEXITY_API_KEY is
 * not configured. Lets the rest of the pipeline + UI be exercised without
 * burning API credit. Production NEVER returns this — the orchestrator
 * checks for the env var and only falls back to the mock in non-prod.
 */
export const MOCK_RESEARCH_RESPONSE: PerplexityResearchResponse = {
  products: [
    {
      product_name: "Lunchables Pizza with Pepperoni",
      brand: "Lunchables",
      manufacturer: "Kraft Heinz",
      upc: "044700022344",
      pack_sizes: ["4.3 oz", "10.6 oz"],
      flavors: ["Pepperoni", "Cheese"],
      weight_oz: 4.3,
      ingredients: "Crust, pizza sauce, mozzarella cheese, pepperoni.",
      allergens: ["Milk", "Wheat", "Soybeans"],
      storage_temp: "Refrigerated",
      expiration_days: 30,
      avg_price_cents: 250,
      source_store_name: "Walmart Clearwater US-19",
      source_url: "https://www.walmart.com/ip/Lunchables-Pizza-Pepperoni",
      reference_image_urls: [
        "https://i5.walmartimages.com/asr/lunchables-pizza-pepperoni.jpg",
      ],
      freshness_score: 95,
      in_stock_confidence: "high",
      notes: "Mock fixture — dev only.",
    },
    {
      product_name: "Lunchables Ham + Cheddar Cracker Stackers",
      brand: "Lunchables",
      manufacturer: "Kraft Heinz",
      pack_sizes: ["3.5 oz"],
      flavors: ["Ham", "Cheddar"],
      weight_oz: 3.5,
      allergens: ["Milk", "Wheat"],
      storage_temp: "Refrigerated",
      expiration_days: 30,
      avg_price_cents: 230,
      source_store_name: "Publix Clearwater Mall",
      reference_image_urls: [],
      freshness_score: 90,
      in_stock_confidence: "high",
      notes: "Mock fixture — dev only.",
    },
    {
      product_name: "Capri Sun Pacific Cooler Juice Pouches",
      brand: "Capri Sun",
      manufacturer: "Kraft Heinz",
      pack_sizes: ["10 ct"],
      flavors: ["Pacific Cooler"],
      weight_oz: 60,
      allergens: [],
      storage_temp: "Ambient",
      expiration_days: 180,
      avg_price_cents: 449,
      source_store_name: "Target Clearwater",
      reference_image_urls: [],
      freshness_score: 92,
      in_stock_confidence: "high",
      notes: "Mock fixture — dev only.",
    },
  ],
  citations: ["mock://development"],
  raw_response: "[mock]",
};
