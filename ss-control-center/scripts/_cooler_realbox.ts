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
  const ROT = F(process.env.ROT, 2.5); // max alternating tilt (deg) so boxes look placed
  const coolerBuf = await fetchImageBuffer(COOLER);
  const cooler = await sharp(coolerBuf).resize(C, C, { fit: "cover" }).png().toBuffer();

  type Placed = { left: number; top: number; buf: Buffer; w: number; h: number };
  // Lay out one row of boxes: size to boxH, tilt slightly, shrink to fit the cavity
  // width, then position bottoms at baseY. Returns placed boxes.
  async function makeRow(boxes: Buffer[], boxH: number, openL: number, openR: number, baseY: number, overlap: number): Promise<Placed[]> {
    if (!boxes.length) return [];
    const tiles = await Promise.all(boxes.map(async (b, i) => {
      const m = await sharp(b).metadata();
      const aspect = (m.width ?? 1) / (m.height ?? 1);
      let buf = await sharp(b).resize(Math.round(boxH * aspect), boxH, { fit: "fill" }).png().toBuffer();
      const ang = boxes.length > 1 ? (i % 2 === 0 ? -ROT : ROT) : 0;
      if (ang) buf = await sharp(buf).rotate(ang, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
      const mm = await sharp(buf).metadata();
      return { buf, w: mm.width ?? boxH, h: mm.height ?? boxH };
    }));
    const rowW = tiles.slice(0, -1).reduce((s, t) => s + t.w * (1 - overlap), 0) + tiles[tiles.length - 1].w;
    const scale = Math.min(1, (openR - openL) / rowW);
    const scaled = await Promise.all(tiles.map(async (t) => {
      const w = Math.max(1, Math.round(t.w * scale)), h = Math.max(1, Math.round(t.h * scale));
      return { buf: await sharp(t.buf).resize(w, h, { fit: "fill" }).png().toBuffer(), w, h };
    }));
    const rowW2 = scaled.slice(0, -1).reduce((s, t) => s + t.w * (1 - overlap), 0) + scaled[scaled.length - 1].w;
    let x = Math.round((openL + openR) / 2 - rowW2 / 2);
    return scaled.map((t) => { const p = { left: Math.round(x), top: baseY - t.h, buf: t.buf, w: t.w, h: t.h }; x += t.w * (1 - overlap); return p; });
  }

  // Two rows for a FULL cooler with readable heroes: a BACK row (smaller, higher,
  // wider — fills the cavity) + a FRONT row (2 big readable boxes). order is
  // flavor-interleaved, so front = one of each flavor, back = the rest.
  const FRONT_N = N(process.env.FRONT_N, 2);
  const backRow = await makeRow(order.slice(FRONT_N), N(process.env.BACK_H, 360), N(process.env.BACK_L, 360), N(process.env.BACK_R, 1300), N(process.env.BACK_Y, 706), F(process.env.BACK_OVERLAP, 0.28));
  const frontRow = await makeRow(order.slice(0, FRONT_N), BOX_H, OPEN_L, OPEN_R, BASE_Y, OVERLAP);

  const layers: import("sharp").OverlayOptions[] = [];
  const addWithShadow = async (placed: Placed[]) => {
    for (const p of placed) {
      const shadow = await sharp({ create: { width: p.w, height: p.h, channels: 4, background: { r: 12, g: 16, b: 20, alpha: 0.45 } } })
        .composite([{ input: p.buf, blend: "dest-in" }])
        .extend({ top: 24, bottom: 24, left: 24, right: 24, background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .blur(18).png().toBuffer();
      layers.push({ input: shadow, left: p.left - 24 + 10, top: p.top - 24 + 14 });
    }
    for (const p of placed) layers.push({ input: p.buf, left: p.left, top: p.top });
  };
  await addWithShadow(backRow);   // behind
  await addWithShadow(frontRow);  // in front

  // Re-overlay the cooler's FRONT so all box bottoms tuck BEHIND the rim → seated.
  const frontStrip = await sharp(cooler).extract({ left: 0, top: RIM_Y, width: C, height: C - RIM_Y }).png().toBuffer();
  layers.push({ input: frontStrip, left: 0, top: RIM_Y });

  const out = await sharp(cooler).composite(layers).png().toBuffer();
  const url = await uploadToR2(out, OUT_KEY);
  console.log("HERO:", url);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
