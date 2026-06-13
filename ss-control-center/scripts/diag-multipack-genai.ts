// OPTION B test: generate a multipack hero via GPT Image (image->image), using
// the real single-unit photo as a reference. Compares against Option A (cutout
// + tile). Writes the result locally. Reports cost. One image only.
//
//   npx tsx scripts/diag-multipack-genai.ts FaisalX-2272
//
// Cost: gpt-image-1 1024x1024 ~ $0.04/image. Nothing published.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import OpenAI from "openai";
import { createClient } from "@libsql/client";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const OUT = join(process.cwd(), "..", "preview-multipack");

async function main() {
  const sku = process.argv[2] || "FaisalX-2272";
  mkdirSync(OUT, { recursive: true });

  const r = await db.execute({
    sql: `SELECT w.title wtitle, COALESCE(s.unitsInListing,c.packSize) pack, rp.imageUrls imgs
          FROM WalmartCatalogItem w
          LEFT JOIN SkuShippingData s ON s.sku=w.sku
          LEFT JOIN SkuCost c ON c.sku=w.sku
          LEFT JOIN RetailPrice rp ON rp.sku=w.sku AND rp.imageUrls IS NOT NULL AND rp.imageUrls!=''
          WHERE w.sku=? LIMIT 1`,
    args: [sku],
  });
  const row = r.rows[0] as any;
  if (!row) { console.log("no candidate"); process.exit(1); }
  const n = Number(row.pack) || 8;
  let imgs: string[] = []; try { imgs = JSON.parse(row.imgs); } catch { imgs = [row.imgs]; }
  const ref = imgs.find((u) => typeof u === "string" && u.startsWith("http"))!;
  console.log(`\nOPTION B — GPT Image, ${sku}  [${n}x]\n  ref: ${ref}\n`);

  const refBuf = Buffer.from(await (await fetch(ref)).arrayBuffer());
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const prompt =
    `Studio product photo on a pure white background (RGB 255,255,255). ` +
    `Take the EXACT product shown in the reference image and show ${n} identical copies of it ` +
    `arranged as a tight retail multipack: two neat rows, units touching and slightly overlapping, ` +
    `large and clearly visible, bottom-aligned, gentle realistic soft contact shadow. ` +
    `Keep the product's real label, colors, and shape exactly as in the reference — do not invent or alter packaging. ` +
    `No added text, no badges, no logos other than the product's own. Square 1:1 framing, product fills ~85% of the frame.`;

  const resp = await openai.images.edit({
    model: "gpt-image-1",
    image: await OpenAI.toFile(refBuf, "ref.png", { type: "image/png" }),
    prompt,
    size: "1024x1024",
  });
  const b64 = resp.data?.[0]?.b64_json;
  if (!b64) { console.log("no image returned", JSON.stringify(resp).slice(0, 300)); process.exit(1); }
  writeFileSync(join(OUT, `${sku}-3-OPTIONB-genai.png`), Buffer.from(b64, "base64"));
  console.log(`  wrote ${sku}-3-OPTIONB-genai.png  (~$0.04)\n`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e?.message || e); process.exit(1); });
