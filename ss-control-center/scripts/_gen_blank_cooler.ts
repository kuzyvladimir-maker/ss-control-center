// Generate a COMPLETELY BLANK, unbranded styrofoam cooler — AI draws ONLY the
// foam shape (no logo, no text, nothing to fabricate). The REAL Salutem logo
// (owner's exact pixels) gets composited onto the front panel + gel packs
// afterward, and REAL Uncrustables boxes go inside. Near head-on so the front
// panel is flat/rectangular → the real logo lays down cleanly without perspective.
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
async function main() {
  const { generateImagePngViaCodex } = await import("@/lib/image-gen/codex-worker");
  const { uploadToR2 } = await import("@/lib/walmart/multipack/r2");
  const V2 = "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/bf-cooler/empty-cooler-v2.png";
  const prompt = [
    "Professional e-commerce product photo, pure white seamless background, square 1:1, soft even studio lighting, subtle condensation droplets on the foam.",
    "Reference image #1 shows the cooler SHAPE to reproduce: a white expanded-polystyrene (styrofoam) shipping cooler, open, with a large clean EMPTY rectangular interior cavity and its lid leaning upright behind it, plus white gel-pack pouches lying in front.",
    "Camera is slightly ABOVE and nearly HEAD-ON (directly in front): you can see DOWN into the open empty cavity, and the cooler's FRONT panel faces the camera flat and rectangular (minimal perspective).",
    "CRITICAL: the cooler and the gel packs must be COMPLETELY BLANK and UNBRANDED — plain smooth white surfaces with NO logo, NO lotus flower, NO text, NO printing or graphics of any kind anywhere on them.",
    "The interior cavity is completely empty. Place exactly TWO blank white gel packs lying flat in front of the cooler.",
    "No product, no food, no boxes, no sandwiches, no people, no hands, no text overlays, no watermarks, no extra props.",
  ].join("\n");
  console.log(new Date().toISOString(), "generating BLANK cooler v3…");
  const r = await generateImagePngViaCodex({ prompt, size: "2048x2048", timeoutMs: 285000, referenceUrls: [V2] });
  if (!r.png) { console.log("FAILED:", r.error ?? "no png"); process.exit(1); }
  const url = await uploadToR2(r.png, "bf-cooler/blank-cooler-v3.png");
  console.log(new Date().toISOString(), "blank cooler v3:", url);
}
main().catch((e) => { console.error(e); process.exit(1); });
