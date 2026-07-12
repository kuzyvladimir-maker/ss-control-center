// Brand the BLANK cooler with the owner's REAL logo (exact pixels, not an AI
// approximation). White background is keyed out, then the logo is composited
// onto the flat front panel + the two front gel packs. Output = a real-branded
// empty cooler; feed it into _cooler_realbox.ts (COOLER_URL=...) to add real boxes.
//
// Everything tunable via env so placement can be dialed once we see it with the
// real logo:  LOGO_PATH, BLANK_URL, FRONT_CX/CY/W, GL_/GR_ CX/CY/W/ROT, OUT_KEY
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });

const N = (v: string | undefined, d: number) => (v ? parseInt(v, 10) : d);
const F = (v: string | undefined, d: number) => (v ? parseFloat(v) : d);
const BLANK = process.env.BLANK_URL ||
  "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/bf-cooler/blank-cooler-v3.png";
const LOGO_PATH = process.env.LOGO_PATH || "public/bundle-factory/brand/salutem-logo.png";
const OUT_KEY = process.env.OUT_KEY || "bf-cooler/branded-cooler-v4.png";

// Front panel logo (near head-on, so a flat paste sits right).
const FRONT_CX = N(process.env.FRONT_CX, 875);
const FRONT_CY = N(process.env.FRONT_CY, 1090);
const FRONT_W  = N(process.env.FRONT_W, 760);
const FRONT_OPACITY = F(process.env.FRONT_OPACITY, 0.96);
// Gel-pack logos (smaller, slight tilt to match each pack).
const GL_CX = N(process.env.GL_CX, 525), GL_CY = N(process.env.GL_CY, 1600), GL_W = N(process.env.GL_W, 235), GL_ROT = F(process.env.GL_ROT, -4);
const GR_CX = N(process.env.GR_CX, 1205), GR_CY = N(process.env.GR_CY, 1655), GR_W = N(process.env.GR_W, 235), GR_ROT = F(process.env.GR_ROT, 5);

async function main() {
  const sharp = (await import("sharp")).default;
  const { existsSync } = await import("node:fs");
  const { fetchImageBuffer } = await import("@/lib/walmart/multipack/composite");
  const { uploadToR2 } = await import("@/lib/walmart/multipack/r2");

  if (!existsSync(LOGO_PATH)) {
    console.error(`LOGO NOT FOUND at ${LOGO_PATH} — save the real Salutem logo there (or set LOGO_PATH).`);
    process.exit(2);
  }

  // Key out the white background: flatten onto white (normalizes transparent PNGs
  // too), then build an alpha from "is-this-ink?" (anything darker than near-white).
  const flat = await sharp(LOGO_PATH).flatten({ background: "#ffffff" }).png().toBuffer();
  const { data: rgb, info } = await sharp(flat).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = await sharp(flat).greyscale().threshold(238).negate().blur(0.8).raw().toBuffer();
  const logoCut = await sharp(rgb, { raw: { width: info.width, height: info.height, channels: 3 } })
    .joinChannel(alpha, { raw: { width: info.width, height: info.height, channels: 1 } })
    .png().toBuffer();
  const lm = await sharp(logoCut).metadata();
  const logoAspect = (lm.width ?? 2) / (lm.height ?? 1);

  async function sized(w: number, opacity: number, rot: number): Promise<{ buf: Buffer; w: number; h: number }> {
    const h = Math.round(w / logoAspect);
    let b = await sharp(logoCut).resize(w, h, { fit: "fill" }).png().toBuffer();
    if (opacity < 1) {
      b = await sharp(b).ensureAlpha().composite([{
        input: Buffer.from([255, 255, 255, Math.round(opacity * 255)]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: "dest-in",
      }]).png().toBuffer();
    }
    if (rot) b = await sharp(b).rotate(rot, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    const mm = await sharp(b).metadata();
    return { buf: b, w: mm.width ?? w, h: mm.height ?? h };
  }

  const C = 2048;
  const cooler = await sharp(await fetchImageBuffer(BLANK)).resize(C, C, { fit: "cover" }).png().toBuffer();

  const front = await sized(FRONT_W, FRONT_OPACITY, 0);
  const gl = await sized(GL_W, 0.98, GL_ROT);
  const gr = await sized(GR_W, 0.98, GR_ROT);

  const layers: import("sharp").OverlayOptions[] = [
    { input: front.buf, left: Math.round(FRONT_CX - front.w / 2), top: Math.round(FRONT_CY - front.h / 2) },
    { input: gl.buf, left: Math.round(GL_CX - gl.w / 2), top: Math.round(GL_CY - gl.h / 2) },
    { input: gr.buf, left: Math.round(GR_CX - gr.w / 2), top: Math.round(GR_CY - gr.h / 2) },
  ];
  const out = await sharp(cooler).composite(layers).png().toBuffer();
  const url = await uploadToR2(out, OUT_KEY);
  console.log("branded cooler:", url);
}
main().catch((e) => { console.error(e); process.exit(1); });
