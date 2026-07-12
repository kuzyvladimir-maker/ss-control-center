// Generate empty-cooler-v2: same branded Salutem kit as v1, but with a LARGE
// CLEAN EMPTY interior cavity (no gel packs crammed inside) so real box photos
// can be composited in at a readable size. AI draws ONLY our own cooler + gel
// packs (our IP) — never any product.
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
async function main() {
  const { generateImagePngViaCodex } = await import("@/lib/image-gen/codex-worker");
  const { uploadToR2 } = await import("@/lib/walmart/multipack/r2");
  const V1 = "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/bf-cooler/empty-cooler-v1.png";
  const prompt = [
    "Professional e-commerce product photo, pure white seamless background, square 1:1, soft studio lighting, subtle condensation droplets.",
    "Reference image #1 shows the exact branded kit to reproduce faithfully: a white expanded-polystyrene (styrofoam) shipping cooler with, printed in GREEN on its front face, a lotus-flower logo above the words 'SALUTEM SOLUTIONS' and beneath them 'OUR BEST SOLUTIONS FOR YOU'; plus white 'FROZEN GEL PACK / KEEP FROZEN / FOR FROZEN SHIPMENTS' pouches carrying the same green lotus logo.",
    "Reproduce this cooler and these gel packs EXACTLY — same shape, same green branding, same correctly-spelled text, same white styrofoam texture, lid leaning open upright behind the cooler.",
    "Composition change: the open cooler's interior must be a LARGE, EMPTY, clean rectangular cavity — completely empty, nothing inside, the white interior walls and floor clearly visible, wide and tall, ready to be filled later.",
    "Do NOT place anything inside the cavity. Place exactly TWO branded gel packs lying flat on the white surface in FRONT of the cooler (outside it).",
    "No product, no food, no boxes, no sandwiches, no people, no hands, no text overlays, no watermarks, no extra props.",
  ].join("\n");
  console.log(new Date().toISOString(), "generating empty cooler v2…");
  const r = await generateImagePngViaCodex({ prompt, size: "2048x2048", timeoutMs: 285000, referenceUrls: [V1] });
  if (!r.png) { console.log("FAILED:", r.error ?? "no png"); process.exit(1); }
  const url = await uploadToR2(r.png, "bf-cooler/empty-cooler-v2.png");
  console.log(new Date().toISOString(), "cooler v2:", url);
}
main().catch((e) => { console.error(e); process.exit(1); });
