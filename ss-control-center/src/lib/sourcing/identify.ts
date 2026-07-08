// COGS engine "brain" (shared, channel-agnostic).
//
// Identifies the EXACT physical product behind ONE of OUR listings from the
// FOUR inputs Vladimir specified — TITLE + DESCRIPTION + BULLET POINTS + ALL
// PHOTOS — and decomposes bundles / kits / gift-sets into their component
// products so each can be sourced and priced separately.
//
// Supersedes the per-channel pilot scripts scripts/cogs-identify*.ts (which fed
// only title + the single main photo). Used by scripts/cogs-enrich-batch.ts and,
// later, the background enrichment worker — one source of truth so Amazon and
// Walmart resolve identically.

import type { Client } from "@libsql/client";
// UNIFIED VISION ROUTER (2026-07-08, owner-approved division of labor): identify goes
// through the SHARED scheduler in sourcing/vision.ts (askVisionJson) — the SAME
// weighted, in-flight-aware, circuit-breaker dispatcher the image chat uses. One
// scheduler for both chats = no more two blind round-robins saturating each other's
// lanes on the box. Lane policy (Gemini→Codex→Claude-reserve + paid-Sonnet thin
// spillover) lives THERE now, not here.
import { askVisionJson } from "@/lib/sourcing/vision";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { getListing, flattenListing } from "@/lib/amazon-sp-api/listings";
import { fetchVeeqoDetailBySku } from "@/lib/veeqo/product-image";

export interface ProductComponent {
  product: string;
  flavor?: string;
  size?: string;
  qty: number;
}

export interface ProductIdentity {
  brand: string;
  product_line: string;
  flavor: string;
  size: string;
  container_type: string;
  base_unit: string;
  units_in_listing: number;
  unit_basis: string;
  is_bundle: boolean;
  components: ProductComponent[];
  retail_search_query: string;
  confidence: number;
  notes: string;
}

export interface IdentifyInputs {
  title: string;
  description?: string | null;
  bullets?: string[];
  imageUrls?: string[];
}

// Cap the number of photos we base64 + send to vision, to bound cost/latency.
// Photo 0 (main) + up to 5 gallery shots is plenty to read a variety pack.
const MAX_IMAGES = 6;

const PROMPT = `You are a product-identification engine for an e-commerce RESELLER.
You are given a marketplace listing's TITLE, DESCRIPTION, BULLET POINTS, and one or
more PHOTOS (photo 0 is the main image; the rest are gallery images). Use ALL of them
together — the PHOTOS override the text when they conflict, and the DESCRIPTION often
spells out exactly what is inside a gift set / kit / variety pack.

Identify the EXACT physical product and how many PROCUREMENT units are in this listing
(a procurement unit = the single item we would buy on a store shelf to fulfill it).

Return ONLY JSON:
{
  "brand": "",
  "product_line": "",
  "flavor": "",                // or "variety" for multi-flavor
  "size": "",                  // e.g. "15 oz", "20 oz", "4.9 oz"
  "container_type": "",        // can | cup | pouch | bag | box | loaf | tray | bottle | jar
  "base_unit": "",             // ONE shelf unit, e.g. "Chef Boyardee Beef Ravioli 15 oz can"
  "units_in_listing": 1,       // total base units in THIS listing. "10 count Pack of 3" = 3 boxes; multi-flavor 4x3 = 12
  "unit_basis": "",            // what one unit is: can/box/bag/loaf/etc
  "is_bundle": false,          // TRUE only if the listing has MULTIPLE DIFFERENT products (variety/assorted pack, gift set, kit). A multipack of the SAME product ("Pack of 6", "12 count") is NOT a bundle -> false + units_in_listing>1.
  "components": [],            // REQUIRED when is_bundle=true: one entry per DISTINCT product, decomposed from the PHOTOS + DESCRIPTION: [{"product":"","flavor":"","size":"","qty":0}]. Each product must be a real retail shelf item we can buy and price. Else [].
  "retail_search_query": "",   // best query to find ONE base unit at Walmart/Target (for a bundle, the most representative single item)
  "confidence": 0.0,           // 0..1 — how sure you are of the EXACT product+size. Be honest: low when the photo is unclear or the item is ambiguous.
  "notes": ""
}
Use the PHOTOS to confirm container type, visible count, and flavor — titles can be wrong
or ambiguous. Be precise about size and container (can vs cup vs pouch is a different SKU).
For a gift set / kit, EVERY distinct item must appear in components[] with its own size and
quantity so each can be priced separately.`;

// Identify a product from its images + text — ONE pass through the SHARED vision
// router (askVisionJson): weighted lanes Gemini→Codex→Claude-reserve with in-flight
// load-balancing + per-lane circuit breaker + backoff retries, and vision.ts's own
// thin paid-Sonnet spillover at the end (owner-endorsed). It swallows errors → null.
// No result = throw, so the caller records NOTHING (the resumable sweep retries the
// SKU later) instead of writing a junk identity.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runIdentify(urls: string[], prompt: string): Promise<any> {
  if (urls.length) {
    const r = await askVisionJson(urls, prompt, 900);
    if (r && typeof r === "object" && (r as any).brand !== undefined) return r;
    throw new Error("vision unavailable (shared router exhausted) — SKU skipped, will retry later");
  }
  // NO photos → text-only identify from title/description via the box's Claude-text
  // lane ($0, its own queue) — the shared vision router requires ≥1 image.
  try {
    const { generateTextViaClaudeWorker } = await import("@/lib/text-gen/claude-text-worker");
    const { text } = await generateTextViaClaudeWorker({ prompt, model: "sonnet", timeoutMs: 120_000 });
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { const r = JSON.parse(m[0]); if (r && r.brand !== undefined) return r; }
  } catch { /* worker busy/down — skip, retried later */ }
  throw new Error("text-only identify unavailable — SKU skipped, will retry later");
}

// Normalize a raw model output into a trustworthy ProductIdentity (defaults, sane
// bundle flag, clean components).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeIdentity(raw: any, inp: IdentifyInputs): ProductIdentity {
  const id = (raw || {}) as Partial<ProductIdentity>;
  const components: ProductComponent[] = Array.isArray(id.components)
    ? (id.components as any[])
        .map((c) => ({
          product: String(c?.product || "").trim(),
          flavor: c?.flavor ? String(c.flavor) : undefined,
          size: c?.size ? String(c.size) : undefined,
          qty: Number(c?.qty) > 0 ? Number(c.qty) : 1,
        }))
        .filter((c) => c.product)
    : [];
  return {
    brand: id.brand || "",
    product_line: id.product_line || "",
    flavor: id.flavor || "",
    size: id.size || "",
    container_type: id.container_type || "",
    base_unit: id.base_unit || "",
    units_in_listing: Number(id.units_in_listing) > 0 ? Number(id.units_in_listing) : 1,
    unit_basis: id.unit_basis || "",
    is_bundle: !!id.is_bundle || components.length > 1,
    components,
    retail_search_query: id.retail_search_query || id.base_unit || inp.title || "",
    confidence: typeof id.confidence === "number" ? id.confidence : 0,
    notes: id.notes || "",
  };
}

// Run the vision brain over the gathered inputs in ONE pass on a strong model:
// GPT-5.4 (high reasoning) via the free ChatGPT-subscription Codex worker, falling
// back to Sonnet only if the box is unreachable. No cheap-model tier and no second
// escalation call — the provider is a single strong model, so re-running it wouldn't
// improve the read and would only burn a slot in the box's serial Codex queue.
export async function identifyProduct(inp: IdentifyInputs): Promise<ProductIdentity & { imagesUsed: number }> {
  // URLs go straight to the shared router — it downloads (with retries) itself.
  const urls = (inp.imageUrls ?? []).filter((u) => typeof u === "string" && u.startsWith("http")).slice(0, MAX_IMAGES);

  const ctx =
    `${PROMPT}\n\nLISTING TITLE: ${inp.title || "(none)"}` +
    (inp.description ? `\nDESCRIPTION: ${String(inp.description).slice(0, 1500)}` : "") +
    (inp.bullets?.length ? `\nBULLET POINTS:\n- ${inp.bullets.slice(0, 8).join("\n- ")}` : "") +
    `\nPHOTOS PROVIDED: ${urls.length}`;

  const id = normalizeIdentity(await runIdentify(urls, ctx), inp);
  return { ...id, imagesUsed: urls.length };
}

// --- per-channel input gathering -------------------------------------------

// Stores we can read via SP-API today (store2 no US seller_id, store4 no SP-API
// app, store5 US-suspended — getMerchantToken throws for those, we skip).
const AMAZON_STORES = [1, 3, 5];

export async function gatherAmazonInputs(
  sku: string,
): Promise<(IdentifyInputs & { found: true; store: number }) | { found: false }> {
  for (const store of AMAZON_STORES) {
    try {
      const sellerId = await getMerchantToken(store);
      const listing = await getListing(store, sellerId, sku);
      if (!listing || (!listing.attributes && !listing.summaries)) continue;
      const f = flattenListing(listing);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const attrs = (listing.attributes ?? {}) as Record<string, any>;

      // Collect ALL photos: main_product_image_locator + other_product_image_locator_1..8.
      const imgs: string[] = [];
      const main = attrs.main_product_image_locator?.[0]?.media_location || f.main_image_url;
      if (main) imgs.push(main);
      for (let i = 1; i <= 8; i++) {
        const loc = attrs[`other_product_image_locator_${i}`]?.[0]?.media_location;
        if (typeof loc === "string" && !imgs.includes(loc)) imgs.push(loc);
      }

      const title = f.title || "";
      if (!title && !imgs.length) continue;
      return {
        found: true,
        store,
        title,
        description: f.description || null,
        bullets: f.bullets || [],
        imageUrls: imgs,
      };
    } catch {
      /* store not accessible / SKU not there — try next */
    }
  }
  return { found: false };
}

export async function gatherWalmartInputs(
  db: Client,
  sku: string,
): Promise<(IdentifyInputs & { found: true }) | { found: false }> {
  const cat = await db.execute({ sql: `SELECT title, mainImageUrl FROM WalmartCatalogItem WHERE sku=? LIMIT 1`, args: [sku] });
  const ship = await db.execute({ sql: `SELECT productTitle FROM SkuShippingData WHERE sku=? LIMIT 1`, args: [sku] });
  let title = (cat.rows[0]?.title as string) || (ship.rows[0]?.productTitle as string) || "";

  const imgs: string[] = [];
  const catImg = cat.rows[0]?.mainImageUrl as string | undefined;
  if (catImg) imgs.push(catImg);

  // Walmart's Marketplace API exposes no description/gallery → Veeqo fills them so
  // vision can read a variety pack's cans and the "what's inside" description.
  let description: string | null = null;
  try {
    const v = await fetchVeeqoDetailBySku(sku);
    if (v.title && !title) title = v.title;
    description = v.description;
    for (const u of v.images) if (!imgs.includes(u)) imgs.push(u);
  } catch {
    /* keep what we have from the catalog cache */
  }

  if (!title && !imgs.length) return { found: false };
  return { found: true, title, description, bullets: [], imageUrls: imgs };
}
