import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
async function main() {
  const { generateImagePngViaCodex } = await import("@/lib/image-gen/codex-worker");
  const { uploadToR2 } = await import("@/lib/walmart/multipack/r2");
  const CLEAN_ANCHOR = "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/bf-cooler/empty-cooler-v1.png";
  const BOX_APPLE = "https://target.scene7.com/is/image/Target/GUEST_7ccb918d-ede9-497a-839a-770fd1308b18";
  const BOX_GRAPE = "https://target.scene7.com/is/image/Target/GUEST_cacbb32a-8095-4b31-83f4-180a6c5420c7";
  const prompt = [
    "A professional e-commerce main product photo on a pure white background, square 1:1.",
    "Reference image #1 is the KIT ANCHOR: copy from it EXACTLY the white Salutem Solutions styrofoam cooler, its green lotus logo and 'SALUTEM SOLUTIONS' text, the branded white 'FROZEN GEL PACK' pouches, the leaning lid, and the overall layout and lighting. Do NOT change the cooler or the gel packs.",
    "Reference images #2 and #3 are the REAL retail product boxes that must go INSIDE the cooler: #2 = Smucker's Uncrustables 'UP & APPLE' Peanut Butter & Apple Cinnamon Jelly (yellow/orange box), #3 = Smucker's Uncrustables Peanut Butter & Grape Jelly (purple box).",
    "Fill the open cooler with these REAL boxes standing upright, front faces toward the camera: about three or four Uncrustables retail boxes, a mix of the yellow 'UP & APPLE' box and the purple 'Grape Jelly' box.",
    "CRITICAL: reproduce the packaging EXACTLY as shown in references #2 and #3 — the real 'SMUCKER'S UnCrustables' wordmark spelled correctly, the real flavor art and colours. Do NOT invent any packaging, do NOT create fictional boxes, do NOT show any non-Uncrustables product, do NOT alter or garble the brand text.",
    "Subtle frost and condensation. No people, no hands, no text overlays, no watermarks, no extra props.",
  ].join("\n");
  console.log(new Date().toISOString(), "generating clean-anchor hero…");
  const r = await generateImagePngViaCodex({ prompt, size: "2048x2048", timeoutMs: 285000, referenceUrls: [CLEAN_ANCHOR, BOX_APPLE, BOX_GRAPE] });
  if (!r.png) { console.log("FAILED:", r.error ?? "no png"); process.exit(1); }
  const url = await uploadToR2(r.png, "bf-cooler/proto-aihero-B0H85MXFH8.png");
  console.log(new Date().toISOString(), "hero:", url);
}
main().catch(e=>{console.error(e);process.exit(1);});
