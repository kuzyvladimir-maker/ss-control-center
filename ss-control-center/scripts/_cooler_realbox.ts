// Real-box-INSIDE-cooler hero. The cooler + gel packs are OUR branded kit (an AI
// render is fine — it's our own IP). The boxes are 100% REAL donor pixels, cut
// out and composited in with sharp — AI never draws a box, so packaging can
// never be fabricated or garbled. This is the kit look the owner wants, made
// impossible to violate the IP rule.
//
// Geometry is env-tunable so the cavity fit can be dialed without editing:
//   COOLER_URL, OPEN_L, OPEN_R, BASE_Y, BOX_H, RIM_Y, OVERLAP, MAXBOX
// Draft is chosen with BF_ONLY_DRAFT; output key with OUT_KEY.
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });

const COOLER = process.env.COOLER_URL ||
  "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/bf-cooler/empty-cooler-v1.png";

// Default cavity geometry for empty-cooler-v1 (2048²). Tunable via env.
const N = (v: string | undefined, d: number) => (v ? parseInt(v, 10) : d);
const F = (v: string | undefined, d: number) => (v ? parseFloat(v) : d);
const OPEN_L = N(process.env.OPEN_L, 520);
const OPEN_R = N(process.env.OPEN_R, 1500);
const BASE_Y = N(process.env.BASE_Y, 970);   // box bottoms (below front lip → occluded)
const BOX_H  = N(process.env.BOX_H, 560);     // box height before fit-to-cavity scaling
const RIM_Y  = N(process.env.RIM_Y, 840);     // re-overlay cooler front from here down
const OVERLAP = F(process.env.OVERLAP, 0.22);
const MAXBOX = N(process.env.MAXBOX, 6);
const OUT_KEY = process.env.OUT_KEY || "bf-cooler/proto-realbox-cooler.png";

async function main() {
  const sharp = (await import("sharp")).default;
  const { prisma } = await import("@/lib/prisma");
  const { buildCompositeMainImage } = await import("@/lib/bundle-factory/composite-image");
  const { fetchImageBuffer, highResImageUrl, extractProduct } = await import("@/lib/walmart/multipack/composite");
  const { uploadToR2 } = await import("@/lib/walmart/multipack/r2");

  const draftId = process.env.BF_ONLY_DRAFT;
  if (!draftId) { console.error("set BF_ONLY_DRAFT"); process.exit(1); }

  const d = await prisma.bundleDraft.findUnique({
    where: { id: draftId },
    select: { draft_name: true, variation_matrix: { select: { selected_variant_idx: true, variants_json: true } } },
  });
  if (!d?.variation_matrix || d.variation_matrix.selected_variant_idx == null) { console.error("no variant"); process.exit(1); }
  const variant = JSON.parse(d.variation_matrix.variants_json)[d.variation_matrix.selected_variant_idx];
  console.log("draft:", d.draft_name);

  // Get the CLEAN real box photo per flavor (same picker the box-composite uses).
  const built = await buildCompositeMainImage({ variant, r2Slug: `realbox-${draftId}`, stamp: "plan" });
  if (!built.plan.length) { console.error("no plan:", built.error); process.exit(1); }
  console.log("flavors:", built.plan.map((p) => `${p.flavor.slice(0, 30)}×${p.boxes} [${p.photo_url?.slice(0, 45)}]`).join("\n        "));

  // Pick a representative, count-proportional set of boxes to SHOW (a cooler holds
  // a handful; the exact count lives in the title). Interleave flavors for variety.
  const totalBoxes = built.plan.reduce((s, p) => s + p.boxes, 0);
  const show = Math.min(totalBoxes, MAXBOX);
  const perFlavor = built.plan.map((p) => Math.max(1, Math.round((p.boxes / totalBoxes) * show)));
  // Fetch + extract each flavor's real box once.
  const boxByFlavor: Buffer[] = [];
  for (const p of built.plan) {
    const raw = await fetchImageBuffer(highResImageUrl(p.photo_url!));
    boxByFlavor.push(await extractProduct(raw));
  }
  // Interleave: f0,f1,f0,f1,... up to the per-flavor caps.
  const order: Buffer[] = [];
  const left = [...perFlavor];
  let idx = 0;
  while (order.length < show && left.some((n) => n > 0)) {
    if (left[idx] > 0) { order.push(boxByFlavor[idx]); left[idx]--; }
    idx = (idx + 1) % built.plan.length;
  }
  console.log(`showing ${order.length} boxes (of ${totalBoxes} real):`, perFlavor.join("+"));

  const C = 2048;
  const coolerBuf = await fetchImageBuffer(COOLER);
  const cooler = await sharp(coolerBuf).resize(C, C, { fit: "cover" }).png().toBuffer();

  // Size boxes to BOX_H, then shrink the whole row to fit the cavity width.
  const tiles = await Promise.all(order.map(async (b) => {
    const m = await sharp(b).metadata();
    const aspect = (m.width ?? 1) / (m.height ?? 1);
    const w = Math.round(BOX_H * aspect);
    return { buf: await sharp(b).resize(w, BOX_H, { fit: "fill" }).png().toBuffer(), w };
  }));
  const rowW = tiles.slice(0, -1).reduce((s, t) => s + t.w * (1 - OVERLAP), 0) + tiles[tiles.length - 1].w;
  const scale = Math.min(1, (OPEN_R - OPEN_L) / rowW);
  const H = Math.round(BOX_H * scale);
  const scaled = await Promise.all(tiles.map(async (t) => {
    const w = Math.round(t.w * scale);
    return { buf: await sharp(t.buf).resize(w, H, { fit: "fill" }).png().toBuffer(), w };
  }));
  const rowW2 = scaled.slice(0, -1).reduce((s, t) => s + t.w * (1 - OVERLAP), 0) + scaled[scaled.length - 1].w;
  let x = Math.round((OPEN_L + OPEN_R) / 2 - rowW2 / 2);

  // Per-box soft elliptical contact shadow at the base + the box, so each box
  // reads as SEATED in the cooler (a single flat strip looked pasted).
  const layers: import("sharp").OverlayOptions[] = [];
  const placed: Array<{ left: number; w: number }> = [];
  for (const t of scaled) {
    placed.push({ left: Math.round(x), w: t.w });
    x += t.w * (1 - OVERLAP);
  }
  for (const p of placed) {
    const shW = Math.round(p.w * 0.92), shH = 46;
    const shadow = await sharp({ create: { width: shW, height: shH, channels: 4, background: { r: 20, g: 25, b: 30, alpha: 0.34 } } })
      .composite([{ input: await sharp({ create: { width: shW, height: shH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer(), blend: "dest-in" }])
      .blur(16).png().toBuffer();
    layers.push({ input: shadow, left: p.left + Math.round((p.w - shW) / 2), top: BASE_Y - 30 });
  }
  for (const [i, t] of scaled.entries()) {
    layers.push({ input: t.buf, left: placed[i].left, top: BASE_Y - H });
  }
  // Re-overlay the cooler's FRONT (rim + wall + logo + front gel packs) so box
  // bottoms tuck BEHIND it → depth, seated INSIDE the cooler.
  const frontStrip = await sharp(cooler).extract({ left: 0, top: RIM_Y, width: C, height: C - RIM_Y }).png().toBuffer();
  layers.push({ input: frontStrip, left: 0, top: RIM_Y });

  const out = await sharp(cooler).composite(layers).png().toBuffer();
  const url = await uploadToR2(out, OUT_KEY);
  console.log("HERO:", url);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
