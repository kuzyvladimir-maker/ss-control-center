/**
 * Live smoke test for the Codex image worker path (no DB).
 *
 * Drives the REAL generateMainImage() → Codex worker → R2 chain using the
 * env in .env.local. Proves the subscription image_gen path works
 * end-to-end and that the resulting R2 URL is a real PNG. Costs $0 (runs on
 * the ChatGPT subscription, not the paid OpenAI Images API).
 *
 * Run:  npx tsx scripts/smoke-codex-image.ts
 */
import { config } from "dotenv";
config(); // .env
config({ path: ".env.local", override: true }); // .env.local (worker + R2 creds)
import { generateMainImage } from "@/lib/bundle-factory/image-generation";

async function main() {
  console.log("Worker URL:", process.env.CODEX_IMAGE_WORKER_URL || "(unset)");
  console.log("Generating (subscription image_gen, ~30-60s)…");
  const t0 = Date.now();
  const out = await generateMainImage({
    prompt:
      "A wicker gift basket holding an assortment of shelf-stable snack packages, " +
      "on a plain white studio background, soft even lighting, product catalog photo, " +
      "generic unbranded packaging, no text, no logos, no watermark.",
    r2_path_slug: "smoke-codex-image",
    size: "1024x1024",
  });
  console.log(`Done in ${Date.now() - t0}ms`);
  console.log("mock_mode:", out.mock_mode);
  console.log("cost_cents:", out.cost_cents, "(must be 0 — subscription is free)");
  console.log("error:", out.error ?? "(none)");
  console.log("image_url:", out.image_url?.slice(0, 120));

  if (out.mock_mode) throw new Error("FAIL: fell back to dev-mock — worker env not loaded");
  if (out.cost_cents !== 0) throw new Error(`FAIL: cost_cents=${out.cost_cents}, expected 0`);
  if (!out.image_url) throw new Error(`FAIL: no image_url (error: ${out.error})`);

  // Verify the URL actually serves a PNG (skip for data: URLs).
  if (out.image_url.startsWith("http")) {
    const res = await fetch(out.image_url, { signal: AbortSignal.timeout(20000) });
    const buf = Buffer.from(await res.arrayBuffer());
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    console.log(`Fetched R2 URL: HTTP ${res.status}, ${buf.length} bytes, PNG=${isPng}, ${w}x${h}`);
    if (!res.ok || !isPng) throw new Error("FAIL: R2 URL did not serve a valid PNG");
  }
  console.log("\nPASS");
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
