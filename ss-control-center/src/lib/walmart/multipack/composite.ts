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
 * Smart cutout: make the white background TRANSPARENT by flood-filling from the
 * image borders. Only white connected to the edge is removed, so interior white
 * (a cap, a label) is preserved — we cut the product's true silhouette, not a
 * rectangle. This is what lets units overlap cleanly with no white-corner halos.
 */
export async function cutoutProduct(productImage: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(productImage)
    .flatten({ background: WHITE })
    .resize(1100, 1100, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const ch = info.channels; // 4 (RGBA)
  const TH = 240; // a pixel is "background white" when all of R,G,B >= TH
  const bg = new Uint8Array(w * h);
  const stack: number[] = [];

  const tryFlood = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = y * w + x;
    if (bg[p]) return;
    const i = p * ch;
    if (data[i] >= TH && data[i + 1] >= TH && data[i + 2] >= TH) {
      bg[p] = 1;
      stack.push(p);
    }
  };

  for (let x = 0; x < w; x++) { tryFlood(x, 0); tryFlood(x, h - 1); }
  for (let y = 0; y < h; y++) { tryFlood(0, y); tryFlood(w - 1, y); }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w;
    const y = (p / w) | 0;
    tryFlood(x - 1, y); tryFlood(x + 1, y); tryFlood(x, y - 1); tryFlood(x, y + 1);
  }
  for (let p = 0; p < w * h; p++) if (bg[p]) data[p * ch + 3] = 0;

  // Keep ONLY the largest connected foreground blob — this drops detached
  // marketing graphics baked into the source (e.g. a "5g protein" callout next
  // to the product), so we tile the product alone, never a product+infographic.
  const comp = new Int32Array(w * h); // 0 = unlabeled
  const cstack: number[] = [];
  let bestLabel = 0;
  let bestSize = 0;
  let label = 0;
  for (let start = 0; start < w * h; start++) {
    if (bg[start] || comp[start]) continue;
    label++;
    let size = 0;
    comp[start] = label;
    cstack.push(start);
    while (cstack.length) {
      const p = cstack.pop()!;
      size++;
      const x = p % w;
      const y = (p / w) | 0;
      const nbrs = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nbrs) {
        if (q >= 0 && !bg[q] && !comp[q]) { comp[q] = label; cstack.push(q); }
      }
    }
    if (size > bestSize) { bestSize = size; bestLabel = label; }
  }
  for (let p = 0; p < w * h; p++) if (comp[p] !== bestLabel) data[p * ch + 3] = 0;

  // Trim the now-transparent border tight to the product silhouette.
  const cut = await sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toBuffer();
  return sharp(cut).trim({ threshold: 0 }).png().toBuffer();
}

/** Split N units into grid rows: 1 row up to 3, otherwise 2 rows (3 rows past
 *  12). e.g. 4→[2,2], 6→[3,3], 7→[4,3], 8→[4,4]. Top row carries any extra. */
function rowSplit(n: number): number[] {
  const rows = n <= 3 ? 1 : n <= 12 ? 2 : 3;
  const perRow = Math.ceil(n / rows);
  const counts: number[] = [];
  let left = n;
  for (let r = 0; r < rows; r++) {
    const c = Math.min(perRow, left);
    counts.push(c);
    left -= c;
  }
  return counts;
}

/**
 * PRIMARY image: show the REAL product as a clean GRID of N identical units —
 * 2 rows, no overlap, a clear gap between units both horizontally and
 * vertically, sized as large as possible (~95% of the frame). Each unit is
 * fully visible and legible. No text/badges (Walmart forbids them on the main
 * image).
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

  const unit = await cutoutProduct(productImage);
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
