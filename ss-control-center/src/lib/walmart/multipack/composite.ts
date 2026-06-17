// Walmart Quantity-Confusion Fix — deterministic image compositing (no AI).
//
// Two outputs per multipack listing, both Walmart-policy compliant:
//   1. composeTiledMainImage — the REAL single-unit product photo tiled into N
//      copies on a pure-white 2000x2000 canvas. This is the PRIMARY image: it
//      shows the actual quantity the buyer receives, with NO text/badges
//      (Walmart forbids any overlay on the main image).
//   2. renderBadgeImage — a SECONDARY image (positions 2-10, where text IS
//      allowed) with a bold, high-contrast banner spelling out the pack count
//      and the "1 order = N packages" formula that kills the confusion.
//
// We use sharp (libvips) — pixels of the real product stay untouched; a
// generative model would hallucinate the packaging/logo and is the wrong tool.

import sharp from "sharp";

const CANVAS = 2000; // Walmart recommends 2000x2000, 1:1, white RGB 255,255,255
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

/**
 * Upgrade a Walmart CDN image URL to full resolution. Donor listings often
 * stored thumbnail URLs (e.g. `?odnHeight=180&odnWidth=180`) which look
 * pixelated when blown up; dropping those params returns the original image.
 */
export function highResImageUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.includes("walmartimages.com")) u.search = "";
    return u.toString();
  } catch {
    return url;
  }
}

/** Fetch a remote product image into a Buffer (runs locally / server-side). */
export async function fetchImageBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Find the product's bounding box and crop the ORIGINAL pixels to it.
 *
 * Why not a transparent cutout: punching the white background out by alpha
 * damages products that are themselves white/pale (a white bread bag's glossy
 * edge merges with the background) and deletes label elements that float free
 * of the body (a logo or name not touching the colored package becomes its own
 * blob and disappears). Instead we use the background analysis ONLY to locate
 * the product, then return its untouched original pixels on white. In the
 * non-overlapping grid the surrounding white is invisible on the white canvas.
 *
 * Detached marketing graphics baked into the source (e.g. Bush's "5g protein"
 * panel beside the can) are excluded: we take the largest blob's box and merge
 * in only nearby blobs (logo, text, package halves), leaving a far-separated
 * badge out.
 */
export async function extractProduct(productImage: Buffer): Promise<Buffer> {
  const SIZE = 1600;
  const flat = await sharp(productImage)
    .flatten({ background: WHITE })
    .resize(SIZE, SIZE, { fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  const { data, info } = await sharp(flat).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const ch = info.channels;
  const TH = 248; // only near-pure-white counts as background (renders are 255)
  const bg = new Uint8Array(w * h);
  const stack: number[] = [];
  const tryFlood = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = y * w + x;
    if (bg[p]) return;
    const i = p * ch;
    if (data[i] >= TH && data[i + 1] >= TH && data[i + 2] >= TH) { bg[p] = 1; stack.push(p); }
  };
  for (let x = 0; x < w; x++) { tryFlood(x, 0); tryFlood(x, h - 1); }
  for (let y = 0; y < h; y++) { tryFlood(0, y); tryFlood(w - 1, y); }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w;
    const y = (p / w) | 0;
    tryFlood(x - 1, y); tryFlood(x + 1, y); tryFlood(x, y - 1); tryFlood(x, y + 1);
  }

  // Label foreground blobs, tracking each one's bbox + pixel count.
  const comp = new Int32Array(w * h);
  const cstack: number[] = [];
  const size: number[] = [0];
  const x0: number[] = [0], y0: number[] = [0], x1: number[] = [0], y1: number[] = [0];
  let label = 0;
  for (let start = 0; start < w * h; start++) {
    if (bg[start] || comp[start]) continue;
    label++;
    size[label] = 0; x0[label] = w; y0[label] = h; x1[label] = 0; y1[label] = 0;
    comp[start] = label;
    cstack.push(start);
    while (cstack.length) {
      const p = cstack.pop()!;
      const x = p % w;
      const y = (p / w) | 0;
      size[label]++;
      if (x < x0[label]) x0[label] = x;
      if (y < y0[label]) y0[label] = y;
      if (x > x1[label]) x1[label] = x;
      if (y > y1[label]) y1[label] = y;
      const nbrs = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nbrs) if (q >= 0 && !bg[q] && !comp[q]) { comp[q] = label; cstack.push(q); }
    }
  }

  if (label === 0) return flat; // all white — nothing to crop

  // Start from the largest blob, then merge any nearby blob into its box.
  const labels = Array.from({ length: label }, (_, i) => i + 1).sort((a, b) => size[b] - size[a]);
  const main = labels[0];
  let bx0 = x0[main], by0 = y0[main], bx1 = x1[main], by1 = y1[main];
  const tol = Math.round(0.04 * Math.max(w, h)); // blobs within 4% are "same product"
  const speck = Math.round(0.0005 * w * h); // ignore tiny noise
  const used = new Set<number>([main]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const l of labels) {
      if (used.has(l) || size[l] < speck) continue;
      const gapX = Math.max(0, bx0 - x1[l], x0[l] - bx1);
      const gapY = Math.max(0, by0 - y1[l], y0[l] - by1);
      if (gapX <= tol && gapY <= tol) {
        bx0 = Math.min(bx0, x0[l]); by0 = Math.min(by0, y0[l]);
        bx1 = Math.max(bx1, x1[l]); by1 = Math.max(by1, y1[l]);
        used.add(l); changed = true;
      }
    }
  }

  // Crop the ORIGINAL (untouched) pixels to the product box, with a little pad.
  const pad = Math.round(0.012 * Math.max(w, h));
  const left = Math.max(0, bx0 - pad);
  const top = Math.max(0, by0 - pad);
  const cw = Math.min(w - left, bx1 - bx0 + 1 + pad * 2);
  const cht = Math.min(h - top, by1 - by0 + 1 + pad * 2);
  return sharp(flat).extract({ left, top, width: cw, height: cht }).png().toBuffer();
}

/** Split N units into grid rows: 1 row up to 3, otherwise 2 rows (3 rows past
 *  12). e.g. 4→[2,2], 6→[3,3], 7→[4,3], 8→[4,4]. Top row carries any extra. */
// Near-SQUARE grid so each unit is as LARGE as possible (a buyer must recognise
// the product even in a tiny search thumbnail). cols≈rows≈√N minimises the larger
// dimension → biggest cells. Rows are balanced (e.g. 10 → [4,3,3], not [5,5]).
// 4 → 2×2, 6 → 3×2, 8 → [3,3,2], 9 → 3×3, 12 → 4×3, 16 → 4×4.
function rowSplit(n: number): number[] {
  if (n <= 3) return [n];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const counts: number[] = [];
  let left = n;
  for (let r = rows; r > 0; r--) {
    const c = Math.ceil(left / r); // balance remaining units across remaining rows
    counts.push(c);
    left -= c;
  }
  return counts;
}

/**
 * PRIMARY image: show the REAL product as a clean NEAR-SQUARE grid of N identical
 * units (rows≈cols≈√N), no overlap, a clear gap between units, sized as large as
 * possible (~95% of the frame) so each unit is recognisable even in a tiny search
 * thumbnail. No text/badges (Walmart forbids them on the main image).
 */
export async function composeTiledMainImage(
  productImage: Buffer,
  packCount: number,
  opts: { gap?: number; fill?: number } = {},
): Promise<Buffer> {
  const n = Math.max(2, Math.floor(packCount));
  const fill = opts.fill ?? 0.95; // products fill ~95% of the frame
  const gapFrac = opts.gap ?? 0.08; // visible gap as a fraction of unit size
  const target = CANVAS * fill;

  const unit = await extractProduct(productImage);
  const um = await sharp(unit).metadata();
  const aspect = (um.width ?? 1) / (um.height ?? 1); // w/h

  const counts = rowSplit(n);
  const rows = counts.length;
  const maxPerRow = Math.max(...counts);

  // Grid bounding box at a reference unit height, then scale to fill the canvas.
  const gridDims = (h: number) => {
    const w = h * aspect;
    const gridW = maxPerRow * w + (maxPerRow - 1) * w * gapFrac;
    const gridH = rows * h + (rows - 1) * h * gapFrac;
    return { w, gridW, gridH };
  };
  let d = gridDims(1000);
  const scale = Math.min(target / d.gridW, target / d.gridH);
  const h = Math.floor(1000 * scale);
  const w = Math.floor(h * aspect);
  const gapX = Math.floor(w * gapFrac);
  const gapY = Math.floor(h * gapFrac);
  const tile = await sharp(unit).resize(w, h, { fit: "fill" }).png().toBuffer();

  const gridH = rows * h + (rows - 1) * gapY;
  const gridTop = Math.floor((CANVAS - gridH) / 2);

  const composites: sharp.OverlayOptions[] = [];
  for (let r = 0; r < rows; r++) {
    const count = counts[r];
    const rowW = count * w + (count - 1) * gapX;
    const xStart = Math.floor((CANVAS - rowW) / 2);
    const top = gridTop + r * (h + gapY);
    for (let c = 0; c < count; c++) {
      composites.push({ input: tile, left: xStart + c * (w + gapX), top });
    }
  }

  return sharp({ create: { width: CANVAS, height: CANVAS, channels: 4, background: WHITE } })
    .composite(composites)
    .png()
    .toBuffer();
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (ch) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[ch]!),
  );
}

/**
 * SECONDARY image: real product centered up top + a bold high-contrast banner
 * across the bottom with the pack count and the anti-confusion formula. Text on
 * a secondary image is allowed by Walmart's image policy.
 */
export async function renderBadgeImage(
  productImage: Buffer,
  packCount: number,
  opts: { noun?: string; accent?: string } = {},
): Promise<Buffer> {
  const n = Math.max(2, Math.floor(packCount));
  const noun = opts.noun ?? "packages";
  const accent = opts.accent ?? "#0071DC"; // Walmart blue — clear, not garish
  const bandH = 560;
  const productBox = CANVAS - bandH - 120;

  const product = await sharp(productImage)
    .flatten({ background: WHITE })
    .resize(productBox, productBox, { fit: "inside", background: WHITE })
    .png()
    .toBuffer();
  const pm = await sharp(product).metadata();
  const pw = pm.width ?? productBox;
  const ph = pm.height ?? productBox;
  const pLeft = Math.floor((CANVAS - pw) / 2);
  const pTop = Math.floor((CANVAS - bandH - ph) / 2);

  const bigNoun = escapeXml(noun.toUpperCase());
  const svg = `
<svg width="${CANVAS}" height="${CANVAS}" xmlns="http://www.w3.org/2000/svg">
  <style>
    .head { font: 700 200px Arial, Helvetica, sans-serif; fill: #ffffff; }
    .sub  { font: 700 96px Arial, Helvetica, sans-serif; fill: #ffffff; }
    .burst{ font: 800 150px Arial, Helvetica, sans-serif; fill: #ffffff; }
  </style>
  <!-- bottom banner -->
  <rect x="0" y="${CANVAS - bandH}" width="${CANVAS}" height="${bandH}" fill="${accent}"/>
  <text x="${CANVAS / 2}" y="${CANVAS - bandH + 250}" text-anchor="middle" class="head">${n} ${bigNoun}</text>
  <text x="${CANVAS / 2}" y="${CANVAS - bandH + 410}" text-anchor="middle" class="sub">1 ORDER = ${n} ${bigNoun} — NOT 1</text>
  <!-- corner burst -->
  <circle cx="300" cy="300" r="230" fill="${accent}"/>
  <text x="300" y="355" text-anchor="middle" class="burst">×${n}</text>
</svg>`;

  return sharp({ create: { width: CANVAS, height: CANVAS, channels: 4, background: WHITE } })
    .composite([
      { input: product, left: pLeft, top: pTop },
      { input: Buffer.from(svg), top: 0, left: 0 },
    ])
    .png()
    .toBuffer();
}
