/**
 * Read-only official Uncrustables package-art capture.
 *
 * Fetches only public manufacturer pages/assets and writes an immutable local
 * evidence bundle. It never calls Amazon, R2, the database, or any mutation
 * endpoint.
 *
 *   npx tsx scripts/fetch-uncrustables-official-package-art.ts
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import sharp from "sharp";

const ROOT = process.cwd();
const OUT = join(
  ROOT,
  "data",
  "audits",
  "uncrustables-official-package-art-20260718",
);
const PAGE_ORIGIN = "https://www.smuckersuncrustables.com";
const ALLOWED_IMAGE_HOSTS = new Set([
  "www.smuckersuncrustables.com",
  "smuckersuncrustables.com",
]);
const MAX_BYTES = 20 * 1024 * 1024;

const products = [
  ["peanut-butter", "peanut-butter-only", true],
  ["peanut-butter-grape", "peanut-butter-and-grape-jelly", true],
  ["peanut-butter-strawberry", "peanut-butter-and-strawberry-jam-sandwich", true],
  ["peanut-butter-raspberry", "peanut-butter-and-raspberry", true],
  ["chocolate-hazelnut", "hazelnut-spread-sandwich", true],
  ["peanut-butter-honey", "peanut-butter-and-honey-sandwich", true],
  ["reduced-sugar-grape-on-wheat", "peanut-butter-and-grape-jelly-on-wheat", true],
  ["reduced-sugar-strawberry-on-wheat", "peanut-butter-and-strawberry-jam-on-wheat", true],
  ["up-and-apple-protein", "peanut-butter-and-apple-cinnamon-protein", true],
  ["bright-eyed-berry-protein", "peanut-butter-and-strawberry-protein", true],
  ["beamin-berry-blend-protein", "peanut-butter-and-mixed-berry-protein", true],
  ["burstin-blueberry-protein", "peanut-butter-and-blueberry-protein", true],
  ["peanut-butter-chocolate-spread", "peanut-butter-and-chocolate", true],
  ["peanut-butter-blackberry", "peanut-butter-blackberry", true],
  ["peanut-butter-chocolate-hazelnut", "peanut-butter-chocolate-flavored-hazelnut", true],
  // Historical/limited 4-count Mixed Berry art is useful for one legacy
  // listing, but it is not advertised in the current all-products grid. A
  // missing page therefore records evidence failure without invalidating the
  // current-product capture.
  ["peanut-butter-mixed-berry-legacy", "peanut-butter-and-mixed-berry", false],
  ["red-white-and-berry-limited", "peanut-butter-and-mixed-berry-rwb", true],
] as const;

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fetchBounded(url: string): Promise<{
  bytes: Buffer;
  finalUrl: string;
  status: number;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
}> {
  const response = await fetch(url, {
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
    headers: { "user-agent": "SalutemSolutions-BundleFactory-Audit/1.0" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new Error(`content-length ${declared} exceeds ${MAX_BYTES}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error("empty response");
  if (bytes.length > MAX_BYTES) throw new Error(`body exceeds ${MAX_BYTES}`);
  return {
    bytes,
    finalUrl: response.url,
    status: response.status,
    contentType: response.headers.get("content-type"),
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}

function officialImageUrls(html: string): string[] {
  const decoded = html
    .replaceAll("&amp;", "&")
    .replaceAll("\\u002F", "/")
    .replaceAll("\\/", "/");
  const matches = decoded.match(
    /https?:\/\/www\.smuckersuncrustables\.com\/smuckersuncrustables\/products\/[^"'<> ]+?\.(?:jpe?g|png|webp)(?:\?[^"'<> ]*)?/gi,
  ) ?? [];
  return Array.from(new Set(matches.map((value) => value.replace(/^http:/i, "https:"))));
}

function selectFrontCenter(urls: string[]): string {
  const ranked = [...urls].sort((a, b) => {
    const score = (value: string) => {
      let result = 0;
      if (/schema_image/i.test(value)) result += 100;
      if (/C1C1/i.test(value)) result += 80;
      if (/front/i.test(value)) result += 30;
      if (/thumb/i.test(value)) result += 10;
      return result;
    };
    return score(b) - score(a);
  });
  if (!ranked[0]) throw new Error("official page contains no package-art URL");
  const parsed = new URL(ranked[0]);
  if (parsed.protocol !== "https:" || !ALLOWED_IMAGE_HOSTS.has(parsed.hostname)) {
    throw new Error(`untrusted package-art URL ${parsed.toString()}`);
  }
  return parsed.toString();
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const records: Array<Record<string, unknown>> = [];
  let requiredFailures = 0;

  for (const [flavorId, slug, required] of products) {
    const pageUrl = `${PAGE_ORIGIN}/sandwiches/${slug}`;
    try {
      const page = await fetchBounded(pageUrl);
      const html = page.bytes.toString("utf8");
      const imageUrl = selectFrontCenter(officialImageUrls(html));
      const image = await fetchBounded(imageUrl);
      const finalImageUrl = new URL(image.finalUrl);
      if (
        finalImageUrl.protocol !== "https:" ||
        !ALLOWED_IMAGE_HOSTS.has(finalImageUrl.hostname)
      ) {
        throw new Error(`image redirected to untrusted host ${image.finalUrl}`);
      }
      if (!/^image\//i.test(image.contentType ?? "")) {
        throw new Error(`unexpected content-type ${image.contentType ?? "<missing>"}`);
      }
      const metadata = await sharp(image.bytes).metadata();
      if (!metadata.width || !metadata.height || !metadata.format) {
        throw new Error("image metadata is incomplete");
      }
      const ext = metadata.format === "jpeg" ? "jpg" : metadata.format;
      const localName = `${flavorId}-front-center.${ext}`;
      writeFileSync(join(OUT, localName), image.bytes);
      records.push({
        flavor_id: flavorId,
        required,
        status: "CAPTURED",
        source_page: pageUrl,
        source_page_final_url: page.finalUrl,
        source_page_sha256: sha256(page.bytes),
        source_page_bytes: page.bytes.length,
        package_art_url: imageUrl,
        package_art_final_url: image.finalUrl,
        package_art_etag: image.etag,
        package_art_last_modified: image.lastModified,
        package_art_sha256: sha256(image.bytes),
        package_art_bytes: image.bytes.length,
        package_art_content_type: image.contentType,
        local_path: `data/audits/${basename(OUT)}/${localName}`,
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
      });
    } catch (error) {
      if (required) requiredFailures++;
      records.push({
        flavor_id: flavorId,
        required,
        status: "FAILED",
        source_page: pageUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const capturedAt = new Date().toISOString();
  const body = {
    schema_version: "uncrustables-official-package-art/v1",
    immutable: true,
    captured_at: capturedAt,
    safety: {
      network_scope: "public manufacturer GET only",
      marketplace_writes: 0,
      r2_writes: 0,
      database_writes: 0,
    },
    source_authority: "The J.M. Smucker Company / Uncrustables official US site",
    summary: {
      requested: products.length,
      captured: records.filter((item) => item.status === "CAPTURED").length,
      failed: records.filter((item) => item.status === "FAILED").length,
      required_failures: requiredFailures,
    },
    records,
  };
  const bodySha = sha256(JSON.stringify(body));
  const manifest = { ...body, body_sha256: bodySha };
  const manifestPath = join(OUT, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(`${manifestPath}.sha256`, `${sha256(readFileSync(manifestPath))}  manifest.json\n`);
  process.stdout.write(
    `${manifestPath}\tcaptured=${body.summary.captured}\trequired_failures=${requiredFailures}\tbody_sha256=${bodySha}\n`,
  );
  if (requiredFailures > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
