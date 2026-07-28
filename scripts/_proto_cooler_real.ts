// Prototype: real Uncrustables box photos composited INTO our empty cooler.
// 100% real packaging (untouched donor pixels) — no AI can invent a design here.
// For his listing B0H85MXFH8: Apple Cinnamon Jelly Protein + Grape Jelly, 24 ct.
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });

const COOLER = "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/bf-cooler/empty-cooler-v1.png";
const BOXES = [
  "https://target.scene7.com/is/image/Target/GUEST_7ccb918d-ede9-497a-839a-770fd1308b18", // Apple Cinnamon Protein
  "https://target.scene7.com/is/image/Target/GUEST_cacbb32a-8095-4b31-83f4-180a6c5420c7", // Grape Jelly
];

async function main() {
  const sharp = (await import("sharp")).default;
  const { fetchImageBuffer, highResImageUrl, extractProduct } = await import("@/lib/walmart/multipack/composite");
  const { uploadToR2 } = await import("@/lib/walmart/multipack/r2");

  const C = 2048;
  const coolerBuf = await fetchImageBuffer(COOLER);
  const cooler = await sharp(coolerBuf).resize(C, C, { fit: "cover" }).png().toBuffer();

  const raw = await Promise.all(BOXES.map(async (u) => extractProduct(await fetchImageBuffer(highResImageUrl(u)))));
  const order = [raw[0], raw[1], raw[0]]; // apple, grape, apple — real variety, fits the cavity

  // INTERIOR opening of THIS cooler (measured): the cavity between the walls is
  // x:[470,1170]; front rim ~y=865. Keep boxes INSIDE that x-range so they never
  // overflow the walls, seat their bottoms LOW (behind where we re-cover the
  // front wall), and let their tops rise out of the cooler.
  const openL = 470, openR = 1175;
  const frontRimY = 815;      // re-overlay the cooler from here down → hides box bottoms
  const baseY = 980;          // box bottoms go below the rim (will be occluded)
  const boxH = 500;
  const overlap = 0.30;

  const tiles = await Promise.all(order.map(async (b) => {
    const m = await sharp(b).metadata();
    const aspect = (m.width ?? 1) / (m.height ?? 1);
    const w = Math.round(boxH * aspect);
    return { buf: await sharp(b).resize(w, boxH, { fit: "fill" }).png().toBuffer(), w };
  }));
  const rowW = tiles.slice(0, -1).reduce((s, t) => s + t.w * (1 - overlap), 0) + tiles[tiles.length - 1].w;
  const scale = Math.min(1, (openR - openL) / rowW); // shrink to fit the cavity if needed
  const H = Math.round(boxH * scale);
  const scaled = await Promise.all(tiles.map(async (t) => {
    const w = Math.round(t.w * scale);
    return { buf: await sharp(t.buf).resize(w, H, { fit: "fill" }).png().toBuffer(), w };
  }));
  const rowW2 = scaled.slice(0, -1).reduce((s, t) => s + t.w * (1 - overlap), 0) + scaled[scaled.length - 1].w;
  let x = Math.round((openL + openR) / 2 - rowW2 / 2);

  const boxLayers: import("sharp").OverlayOptions[] = [];
  for (const t of scaled) {
    boxLayers.push({ input: t.buf, left: Math.round(x), top: baseY - H });
    x += t.w * (1 - overlap);
  }

  // The cooler's FRONT half (rim + wall + logo + front gel packs), re-overlaid on
  // top of the boxes → the box bottoms tuck BEHIND the front wall, so they read as
  // sitting DOWN inside the cooler instead of pasted on front.
  const frontStrip = await sharp(cooler).extract({ left: 0, top: frontRimY, width: C, height: C - frontRimY }).png().toBuffer();

  const out = await sharp(cooler)
    .composite([...boxLayers, { input: frontStrip, left: 0, top: frontRimY }])
    .png()
    .toBuffer();
  const url = await uploadToR2(out, "bf-cooler/proto-real-B0H85MXFH8-v2.png");
  console.log("prototype:", url);
}
main().catch((e) => { console.error(e); process.exit(1); });
