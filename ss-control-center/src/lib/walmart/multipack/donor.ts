// Donor-listing detail fetch for Walmart multipack remediation.
//
// The paid SEARCH endpoints only return one image + no bullets. The BlueCart
// PRODUCT (detail) endpoint returns the full image gallery (5-13) plus
// feature_bullets + a long description. We pull that so the rebuilt listing
// keeps real product imagery and real bullets — not just our two generated
// images. Keyed by the BlueCart item_id we already stored in RetailPrice.

interface DonorDetail {
  title: string;
  images: string[];        // de-duped, full-res product gallery (excludes nothing — caller orders/caps)
  bullets: string[];       // feature_bullets, else parsed <li> from description
  description: string;     // plain text (HTML stripped)
}

/** Strip Walmart CDN thumbnail params + normalize for de-dup. */
export function normUrl(u: string): string {
  return u.split("?")[0];
}

export function htmlToText(html: string): string {
  return html
    .replace(/<li>/gi, "\n• ")
    .replace(/<\/li>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#39;|&rsquo;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function liItems(html: string): string[] {
  const out: string[] = [];
  const re = /<li>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(html))) {
    const t = m[1].replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    if (t) out.push(t);
  }
  return out;
}

/** Fetch the full donor detail from BlueCart by item_id. */
export async function fetchDonorDetail(itemId: string): Promise<DonorDetail | null> {
  const key = process.env.BLUECART_API_KEY;
  if (!key) throw new Error("BLUECART_API_KEY missing");
  const url = `https://api.bluecartapi.com/request?api_key=${key}&type=product&item_id=${encodeURIComponent(itemId)}&walmart_domain=walmart.com`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const j: any = await res.json();
  const p = j.product || {};
  if (!p || (!p.main_image && !(p.images || []).length)) return null;

  // Gallery: main first, then the rest; de-dupe by URL base; keep walmartimages only.
  const raw: string[] = [p.main_image, ...(p.images || []).map((x: any) => (typeof x === "string" ? x : x?.link))]
    .filter((u): u is string => typeof u === "string" && u.startsWith("http"));
  const seen = new Set<string>();
  const images: string[] = [];
  for (const u of raw) {
    const n = normUrl(u);
    if (seen.has(n)) continue;
    seen.add(n);
    images.push(n);
  }

  const descHtml = p.description || "";
  let bullets: string[] = Array.isArray(p.feature_bullets) ? p.feature_bullets.map((b: any) => String(b).trim()).filter(Boolean) : [];
  if (!bullets.length) bullets = liItems(descHtml);

  return {
    title: p.title || "",
    images,
    bullets,
    description: htmlToText(descHtml),
  };
}
