import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
async function main() {
  const { generateImagePngViaCodex } = await import("@/lib/image-gen/codex-worker");
  const { uploadToR2 } = await import("@/lib/walmart/multipack/r2");
  const prompt = [
    "A professional e-commerce product photo on a pure white background, square 1:1.",
    "A single white EPS styrofoam insulated shipping cooler, realistic 3/4 front angle, its lid leaning upright behind it.",
    "The cooler front carries a printed green lotus logo and the words 'SALUTEM SOLUTIONS' and 'OUR BEST SOLUTIONS FOR YOU'.",
    "The cooler interior is COMPLETELY EMPTY — no food, no boxes, no product of any kind inside. Just the empty white foam cavity, clearly open and ready to be filled.",
    "Place 3 white branded gel-pack pouches reading 'FROZEN GEL PACK', 'KEEP FROZEN', 'FOR FROZEN SHIPMENTS' with the same green lotus logo — one or two standing inside the empty cooler against the walls, two lying in front of the cooler.",
    "Subtle frost and cold condensation on the cooler and the pouches. NO loose ice, NO ice cubes.",
    "No people, no hands, no text overlays, no watermarks, no other props."
  ].join("\n");
  console.log(new Date().toISOString(), "generating empty cooler…");
  const r = await generateImagePngViaCodex({ prompt, size: "2048x2048", timeoutMs: 285000 });
  if (!r.png) { console.log("FAILED:", r.error ?? "no png"); process.exit(1); }
  const url = await uploadToR2(r.png, "bf-cooler/empty-cooler-v1.png");
  console.log(new Date().toISOString(), "cooler:", url);
}
main().catch(e=>{console.error(e);process.exit(1);});
