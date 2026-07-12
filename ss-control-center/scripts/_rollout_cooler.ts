// ROLLOUT: replace the fabricated-product cooler heroes with the reference cooler
// holding REAL Uncrustables boxes (v10 look). Deterministic — the cooler + gel
// packs are the owner-approved reference; only real donor box pixels go inside,
// so packaging can never be fabricated. Per draft: build the composite → point
// the live SKU's main_image_url at it → re-PUT (republish).
//
// Scope:
//   BF_DRAFTS=id,id,...   explicit list
//   BF_HARD=1             all hard-defect (fabricated) drafts from the audit
//   BF_ALL=1              every Uncrustables cooler draft in the map (guarantee)
//   BF_ONLY_DRAFT=id      one draft (pilot)
//   BF_DRY=1              build image + set DB url, but do NOT PUT to Amazon
//
// Layout knobs default to the locked v10 values (see _cooler_realbox.ts).
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync } from "node:fs";

const N = (v: string | undefined, d: number) => (v ? parseInt(v, 10) : d);
const F = (v: string | undefined, d: number) => (v ? parseFloat(v) : d);
const COOLER = process.env.COOLER_URL || "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/bf-cooler/empty-cooler-v2.png";
// Locked v10 geometry.
const P = {
  MAXBOX: N(process.env.MAXBOX, 6), FRONT_N: N(process.env.FRONT_N, 2),
  OPEN_L: N(process.env.OPEN_L, 640), OPEN_R: N(process.env.OPEN_R, 1270), BASE_Y: N(process.env.BASE_Y, 828),
  BOX_H: N(process.env.BOX_H, 555), RIM_Y: N(process.env.RIM_Y, 685), OVERLAP: F(process.env.OVERLAP, 0.12),
  BACK_L: N(process.env.BACK_L, 480), BACK_R: N(process.env.BACK_R, 1320), BACK_Y: N(process.env.BACK_Y, 688),
  BACK_H: N(process.env.BACK_H, 393), BACK_OVERLAP: F(process.env.BACK_OVERLAP, 0.34), ROT: F(process.env.ROT, 2.5),
};

type Placed = { left: number; top: number; buf: Buffer; w: number; h: number };

async function main() {
  const sharp = (await import("sharp")).default;
  const { prisma } = await import("@/lib/prisma");
  const { buildCompositeMainImage } = await import("@/lib/bundle-factory/composite-image");
  const { fetchImageBuffer, highResImageUrl, extractProduct } = await import("@/lib/walmart/multipack/composite");
  const { uploadToR2 } = await import("@/lib/walmart/multipack/r2");
  const { runDistribution } = await import("@/lib/bundle-factory/distribution/distribution-pipeline");
  const say = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

  const map = JSON.parse(readFileSync("data/uncrustables-image-map.json", "utf8")) as Array<{ draft_id: string; name: string }>;
  const audit = JSON.parse(readFileSync("data/cooler-audit.json", "utf8")) as Array<{ draft_id: string; reasons: string[] }>;
  const HARD = ["FABRICATED packaging", "packaging not real Uncrustables", "garbled brand text"];
  const isHard = (r: string[]) => (r || []).some((x) => HARD.includes(x) || x.startsWith("missing a flavor"));

  let draftIds: string[];
  if (process.env.BF_ONLY_DRAFT) draftIds = [process.env.BF_ONLY_DRAFT];
  else if (process.env.BF_DRAFTS) draftIds = process.env.BF_DRAFTS.split(",").map((s) => s.trim()).filter(Boolean);
  else if (process.env.BF_HARD === "1") draftIds = audit.filter((a) => isHard(a.reasons)).map((a) => a.draft_id);
  else if (process.env.BF_ALL === "1") draftIds = map.map((m) => m.draft_id);
  else { console.error("set scope: BF_ONLY_DRAFT | BF_DRAFTS | BF_HARD=1 | BF_ALL=1"); process.exit(1); }
  const APPLY = process.env.BF_DRY !== "1";
  say(`rollout cooler+realboxes | ${draftIds.length} drafts | apply=${APPLY}`);

  const C = 2048;
  const cooler = await sharp(await fetchImageBuffer(COOLER)).resize(C, C, { fit: "cover" }).png().toBuffer();

  async function makeRow(boxes: Buffer[], boxH: number, openL: number, openR: number, baseY: number, overlap: number): Promise<Placed[]> {
    if (!boxes.length) return [];
    const tiles = await Promise.all(boxes.map(async (b, i) => {
      const m = await sharp(b).metadata();
      let buf = await sharp(b).resize(Math.round(boxH * ((m.width ?? 1) / (m.height ?? 1))), boxH, { fit: "fill" }).png().toBuffer();
      const ang = boxes.length > 1 ? (i % 2 === 0 ? -P.ROT : P.ROT) : 0;
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

  async function buildHero(draftId: string): Promise<string | null> {
    const d = await prisma.bundleDraft.findUnique({ where: { id: draftId }, select: { variation_matrix: { select: { selected_variant_idx: true, variants_json: true } } } });
    if (!d?.variation_matrix || d.variation_matrix.selected_variant_idx == null) return null;
    const variant = JSON.parse(d.variation_matrix.variants_json)[d.variation_matrix.selected_variant_idx];
    const built = await buildCompositeMainImage({ variant, r2Slug: `rollout-${draftId}`, stamp: "plan" });
    if (!built.plan.length) return null;
    const totalBoxes = built.plan.reduce((s, p) => s + p.boxes, 0);
    const show = Math.min(totalBoxes, P.MAXBOX);
    const perFlavor = built.plan.map((p) => Math.max(1, Math.round((p.boxes / totalBoxes) * show)));
    const boxByFlavor: Buffer[] = [];
    for (const p of built.plan) boxByFlavor.push(await extractProduct(await fetchImageBuffer(highResImageUrl(p.photo_url!))));
    const order: Buffer[] = []; const left = [...perFlavor]; let idx = 0;
    while (order.length < show && left.some((n) => n > 0)) { if (left[idx] > 0) { order.push(boxByFlavor[idx]); left[idx]--; } idx = (idx + 1) % built.plan.length; }

    const backRow = await makeRow(order.slice(P.FRONT_N), P.BACK_H, P.BACK_L, P.BACK_R, P.BACK_Y, P.BACK_OVERLAP);
    const frontRow = await makeRow(order.slice(0, P.FRONT_N), P.BOX_H, P.OPEN_L, P.OPEN_R, P.BASE_Y, P.OVERLAP);
    const layers: import("sharp").OverlayOptions[] = [];
    const addWithShadow = async (placed: Placed[]) => {
      for (const p of placed) {
        const shadow = await sharp({ create: { width: p.w, height: p.h, channels: 4, background: { r: 12, g: 16, b: 20, alpha: 0.45 } } })
          .composite([{ input: p.buf, blend: "dest-in" }]).extend({ top: 24, bottom: 24, left: 24, right: 24, background: { r: 0, g: 0, b: 0, alpha: 0 } }).blur(18).png().toBuffer();
        layers.push({ input: shadow, left: p.left - 24 + 10, top: p.top - 24 + 14 });
      }
      for (const p of placed) layers.push({ input: p.buf, left: p.left, top: p.top });
    };
    await addWithShadow(backRow); await addWithShadow(frontRow);
    const frontStrip = await sharp(cooler).extract({ left: 0, top: P.RIM_Y, width: C, height: C - P.RIM_Y }).png().toBuffer();
    layers.push({ input: frontStrip, left: 0, top: P.RIM_Y });
    const out = await sharp(cooler).composite(layers).png().toBuffer();
    return uploadToR2(out, `bf-cooler-real/draft-${draftId}/main-v10.png`);
  }

  let ok = 0, skip = 0, fail = 0;
  for (const draftId of draftIds) {
    try {
      const url = await buildHero(draftId);
      if (!url) { skip++; say("  SKIP (no plan/variant):", draftId); continue; }
      const d = await prisma.bundleDraft.findUnique({ where: { id: draftId }, select: { master_bundle_id: true, draft_name: true } });
      if (!d?.master_bundle_id) { skip++; say("  SKIP (no master_bundle):", draftId); continue; }
      await prisma.channelSKU.updateMany({ where: { master_bundle_id: d.master_bundle_id }, data: { main_image_url: url } });
      await prisma.generatedContent.updateMany({ where: { bundle_draft_id: draftId }, data: { main_image_url: url } });
      if (!APPLY) { ok++; say(`  DRY built+set: ${d.draft_name?.slice(0, 40)}`); continue; }
      const dist = await runDistribution({ bundle_draft_id: draftId, apply: true, republish: true, actor: "rollout-cooler" });
      const s = dist.per_sku.find((x: any) => x.marketplace_kind === "amazon") ?? dist.per_sku[0];
      if (s && (s.status === "SUBMITTED" || s.status === "LIVE")) { ok++; say(`  OK (${ok}) ${s.sku} → ${s.marketplace_status}  [${d.draft_name?.slice(0, 38)}]`); }
      else { fail++; say("  PUT issue:", JSON.stringify({ st: s?.status, err: (s?.error ?? "").slice(0, 120) })); }
    } catch (e) { fail++; say("  ERR", draftId, (e as Error).message.slice(0, 140)); }
    await new Promise((r) => setTimeout(r, 6_000));
  }
  say(`\nrollout done: ${ok} ok, ${skip} skipped, ${fail} failed`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
