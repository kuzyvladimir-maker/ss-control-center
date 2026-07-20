/**
 * Owner-approval previews only. Generates three local MAIN-image candidates
 * with the explicitly selected OpenAI gpt-image-2 model. Nothing is uploaded
 * to R2, Amazon, or the database.
 *
 *   npx tsx scripts/generate-uncrustables-gpt-image-2-previews.ts
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import { withMeteredProviderCall } from "@/lib/sourcing/metered-provider-call";

const ROOT = process.cwd();
const OUT = join(ROOT, "data", "audits", "uncrustables-gpt-image-2-previews-20260718");
const APPROVED_ANCHOR = join(ROOT, "public", "bundle-factory", "frozen-refs", "ref-uncrustables.png");
const PB_CARTON = join(OUT, "donor-peanut-butter.jpg");
const BLACKBERRY_CARTON = join(
  ROOT,
  "data",
  "audits",
  "uncrustables-approved-reference-qa-20260718",
  "product-blackberry-target.jpg",
);
const APPROVED_WRAPS_MIX = join(
  ROOT,
  "data",
  "audits",
  "uncrustables-approved-reference-qa-20260718",
  "B0H85P9F3R-live.jpg",
);
const GENERATED_SIX_CARTON_LAYOUT = join(OUT, "02-retail-boxes-mix-pb-blackberry-24.png");
const GENERATED_SINGLE_SIX_CARTONS = join(OUT, "01b-retail-boxes-single-pb-24-six-carton-retry.png");

const KIT_INVARIANTS = `
The owner-approved frozen gift-set reference is authoritative for the physical kit and composition.
Preserve the exact ornate green Salutem emblem, the black SALUTEM SOLUTIONS wordmark, and the black
OUR BEST SOLUTIONS FOR YOU slogan on the cooler. Every gel pack must remain a white sealed pouch with
the BLUE FROZEN GEL PACK header, green ornate emblem, and black Salutem wordmark/slogan.

All product cartons or wrappers must physically sit inside the cooler cavity. Their lower edges must be
occluded by the front inner rim. Use shared perspective, realistic scale, natural overlap, contact shadows,
and believable cavity depth. No visible gaps below products, alpha halos, flat pasted edges, floating items,
wall intersections, or products protruding unnaturally through the cooler.

Pure white Amazon MAIN background, square 1:1, premium photorealistic studio product photography.
No people, hands, retailer marks added by the model, price labels, watermarks, UI, overlay text, loose ice,
ice cubes, crushed ice, snow piles, extra products, or fictional packaging.
`.trim();

type Preview = {
  id: string;
  sku: string;
  asin: string;
  recipe: string;
  refs: Array<{ path: string; name: string; type: "image/png" | "image/jpeg" }>;
  prompt: string;
};

const previews: Preview[] = [
  {
    id: "01c-retail-boxes-single-pb-24-four-gel-packs",
    sku: "PB-ASAF-G2T6",
    asin: "B0H82K7Y7S",
    recipe: "24 Peanut Butter sandwiches = six genuine 4-count cartons; four gel packs",
    refs: [
      { path: GENERATED_SINGLE_SIX_CARTONS, name: "verified-single-six-cartons.png", type: "image/png" },
      { path: APPROVED_ANCHOR, name: "approved-four-gel-pack-anchor.png", type: "image/png" },
    ],
    prompt: `Surgically edit reference image 1 and change only one thing: add ONE white branded gel pack
inside the cooler on the inner RIGHT side, matching the corresponding internal right gel pack in reference
image 2. The final image must show exactly four gel packs: two inside the cooler, one on each side of the
six cartons, plus the existing two standing outside in front. Preserve all SIX genuine orange Peanut Butter
4-count cartons, their exact positions, count badges, packaging art, perspective, occlusion, and shadows.
Preserve the cooler, lid, ornate logo, exterior gel packs, background, framing, and every other pixel-level
design feature. Do not add/remove/change any carton or any other object.

${KIT_INVARIANTS}`,
  },
  {
    id: "02b-retail-boxes-mix-pb-blackberry-24-four-gel-packs",
    sku: "YG-ASH6-BCXX",
    asin: "B0H8511Y5G",
    recipe: "12 Peanut Butter + 12 Blackberry = three genuine 4-count cartons each; four gel packs",
    refs: [
      { path: GENERATED_SIX_CARTON_LAYOUT, name: "verified-mix-six-cartons.png", type: "image/png" },
      { path: APPROVED_ANCHOR, name: "approved-four-gel-pack-anchor.png", type: "image/png" },
    ],
    prompt: `Surgically edit reference image 1 and change only one thing: add ONE white branded gel pack
inside the cooler on the inner RIGHT side, matching the corresponding internal right gel pack in reference
image 2. The final image must show exactly four gel packs: two inside the cooler, one on each side of the
six cartons, plus the existing two standing outside in front. Preserve all THREE orange Peanut Butter and
THREE purple Blackberry Boom genuine 4-count cartons, their exact positions, flavor text, count badges,
packaging art, perspective, occlusion, and shadows. Preserve the cooler, lid, ornate logo, exterior gel packs,
background, framing, and every other design feature. Do not add/remove/change any carton or other object.

${KIT_INVARIANTS}`,
  },
  {
    id: "01b-retail-boxes-single-pb-24-six-carton-retry",
    sku: "PB-ASAF-G2T6",
    asin: "B0H82K7Y7S",
    recipe: "24 Peanut Butter sandwiches = exactly six genuine 4-count cartons",
    refs: [
      { path: GENERATED_SIX_CARTON_LAYOUT, name: "verified-six-carton-layout.png", type: "image/png" },
      { path: PB_CARTON, name: "genuine-peanut-butter-4ct.jpg", type: "image/jpeg" },
    ],
    prompt: `Surgically edit reference image 1. Preserve its cooler, lid, ornate Salutem logo, all four
blue-header gel packs, white background, camera angle, lighting, shadows, six-carton geometry, perspective,
and every object position. Keep the THREE existing orange Peanut Butter cartons exactly where they are.
Replace ONLY the THREE purple Blackberry cartons with exact copies of the genuine orange Smucker's
Uncrustables Peanut Butter Sandwich 4-count carton from reference image 2. The result must contain EXACTLY
SIX visible and identical genuine Peanut Butter 4-count cartons in the same two rows: three back + three
front, representing exactly 24 sandwiches. Preserve the genuine 4-count badge and all donor packaging art.
Do not remove, merge, hide, or add cartons. Do not change anything else.

${KIT_INVARIANTS}`,
  },
  {
    id: "01-retail-boxes-single-pb-24",
    sku: "PB-ASAF-G2T6",
    asin: "B0H82K7Y7S",
    recipe: "24 Peanut Butter sandwiches = exactly six genuine 4-count cartons",
    refs: [
      { path: APPROVED_ANCHOR, name: "approved-kit-anchor.png", type: "image/png" },
      { path: PB_CARTON, name: "genuine-peanut-butter-4ct.jpg", type: "image/jpeg" },
    ],
    prompt: `Edit reference image 1 into a new owner-approval MAIN image. Keep its exact cooler, lid, logo,
gel-pack design, white background, camera angle, lighting, and premium commercial style. Replace every
third-party product in the cooler with EXACTLY SIX copies of the genuine Smucker's Uncrustables Peanut
Butter Sandwich 4-count retail carton from reference image 2. The six visible cartons represent exactly
24 sandwiches. Arrange them in a compact, naturally packed staggered two-tier display: three seated deeper
in back and three seated lower in front, with the front row visibly occluded by the cooler rim. Preserve the
real orange carton design and genuine printed 4-count badge from reference 2 verbatim. Show no other flavor,
no wrappers, and no invented or hybrid carton.

${KIT_INVARIANTS}`,
  },
  {
    id: "02-retail-boxes-mix-pb-blackberry-24",
    sku: "YG-ASH6-BCXX",
    asin: "B0H8511Y5G",
    recipe: "12 Peanut Butter + 12 Blackberry = three genuine 4-count cartons of each flavor",
    refs: [
      { path: APPROVED_ANCHOR, name: "approved-kit-anchor.png", type: "image/png" },
      { path: PB_CARTON, name: "genuine-peanut-butter-4ct.jpg", type: "image/jpeg" },
      { path: BLACKBERRY_CARTON, name: "genuine-blackberry-4ct.jpg", type: "image/jpeg" },
    ],
    prompt: `Edit reference image 1 into a new owner-approval MAIN image. Keep its exact cooler, lid, logo,
gel-pack design, white background, camera angle, lighting, and premium commercial style. Place EXACTLY SIX
genuine retail cartons inside: THREE copies of the orange Smucker's Uncrustables Peanut Butter Sandwich
4-count carton from reference 2 and THREE copies of the purple Smucker's Uncrustables BLACKBERRY BOOM /
Peanut Butter & Blackberry Spread Sandwich 4-count carton from reference 3. Together they represent exactly
12 sandwiches of each flavor, 24 total. Both flavors must be immediately visible in balanced staggered rows.
Preserve each donor carton independently and verbatim, including its real flavor name, colors, brand art,
food image, and genuine printed 4-count badge. Never merge the two designs or invent a third flavor.

${KIT_INVARIANTS}`,
  },
  {
    id: "03-individual-wraps-mix-hazelnut-berry-24",
    sku: "TL-ASHN-ZRKG",
    asin: "B0H85P9F3R",
    recipe: "12 Chocolate Flavored Hazelnut + 12 Morning Protein Peanut Butter & Mixed Berry wrappers",
    refs: [
      { path: APPROVED_WRAPS_MIX, name: "owner-approved-wraps-mix.jpg", type: "image/jpeg" },
    ],
    prompt: `Create a polished owner-approval variant of reference image 1 while preserving the exact physical
cooler, lid, ornate Salutem logo, blue-header gel packs, white background, camera angle, and the two genuine
individual Uncrustables wrapper designs already shown there. Show ONLY individually wrapped sandwiches:
exactly TWELVE brown Chocolate Flavored Hazelnut Spread wrappers and exactly TWELVE red Morning Protein
Peanut Butter & Mixed Berry Spread wrappers, 24 total, in a clean six-row by four-column packed display.
Keep the two flavors separated into two readable color groups while still looking naturally packed. Preserve
the genuine Smucker's Uncrustables wordmark, flavor text, wrapper colors, and artwork from the reference.
No retail cartons, no naked sandwiches, no generic wrappers, no additional flavor, and no invented package.

${KIT_INVARIANTS}`,
  },
];

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function generate(openai: OpenAI, preview: Preview) {
  const images = await Promise.all(
    preview.refs.map(async (ref) =>
      OpenAI.toFile(readFileSync(ref.path), ref.name, { type: ref.type }),
    ),
  );
  const response = await withMeteredProviderCall({
    provider: "openai",
    operation: "image_generation",
    requestFingerprint: {
      previewId: preview.id,
      model: "gpt-image-2",
      size: "1536x1536",
      quality: "high",
      promptSha256: sha256(preview.prompt),
      references: preview.refs.map((ref) => ({ name: ref.name, sha256: sha256(readFileSync(ref.path)) })),
    },
  }, () => openai.images.edit({
      model: "gpt-image-2",
      image: images,
      prompt: preview.prompt,
      // @ts-expect-error The installed SDK's legacy size union predates the
      // flexible gpt-image-2 dimensions accepted by the live API.
      size: "1536x1536",
      quality: "high",
    }));
  const b64 = response.data?.[0]?.b64_json;
  if (!b64) throw new Error(`${preview.id}: gpt-image-2 returned no image data`);
  const png = Buffer.from(b64, "base64");
  const output = join(OUT, `${preview.id}.png`);
  writeFileSync(output, png);
  return {
    id: preview.id,
    sku: preview.sku,
    asin: preview.asin,
    recipe: preview.recipe,
    model: "gpt-image-2",
    size: "1536x1536",
    quality: "high",
    prompt_sha256: sha256(preview.prompt),
    reference_files: preview.refs.map((ref) => ({
      path: ref.path.replace(`${ROOT}/`, ""),
      sha256: sha256(readFileSync(ref.path)),
    })),
    output: output.replace(`${ROOT}/`, ""),
    output_sha256: sha256(png),
  };
}

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  mkdirSync(OUT, { recursive: true });
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const requestedIds = new Set(process.argv.slice(2));
  const selected = requestedIds.size > 0
    ? previews.filter((preview) => requestedIds.has(preview.id))
    : previews.filter((preview) => !/^(01b|01c|02b)-/.test(preview.id));
  if (selected.length === 0) throw new Error("No matching preview ids were requested");
  const results = await Promise.all(selected.map((preview) => generate(openai, preview)));
  writeFileSync(
    join(OUT, "preview-manifest.json"),
    `${JSON.stringify({ schema_version: 1, generated_at: new Date().toISOString(), results }, null, 2)}\n`,
  );
  for (const result of results) console.log(`${result.id}\t${result.output}\t${result.output_sha256}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
