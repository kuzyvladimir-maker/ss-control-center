#!/usr/bin/env node

/**
 * Build an owner-readable one-SKU preview for an exact text + MAIN + gallery
 * repair. Local/read-only only; it never writes Walmart, a database, or R2.
 */

import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ProductTruthSnapshot } from "../src/lib/sourcing/product-truth-read-contract.ts";

type JsonRecord = Record<string, unknown>;

const MAX_JSON_BYTES = 100 * 1024 * 1024;

function fail(message: string): never {
  throw new Error(`Walmart image-set repair preview rejected input: ${message}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as JsonRecord;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(object[key])}`
  ).join(",")}}`;
}

function bodySha256(value: unknown): string {
  return sha256(Buffer.from(canonical(value), "utf8"));
}

function exactPath(value: string | undefined, label: string): string {
  if (!value || value !== value.trim() || value.includes("\0")) {
    fail(`${label} must be an explicit path`);
  }
  return path.resolve(value);
}

function parseArgs(argv: readonly string[]) {
  const flags = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([a-z0-9-]+)=(.+)$/u.exec(argument);
    if (!match || flags.has(match[1]!)) fail(`unsupported or duplicate argument: ${argument}`);
    flags.set(match[1]!, match[2]!);
  }
  const expected = [
    "product-truth",
    "diagnosis",
    "buyer-snapshot",
    "buyer-pdp",
    "curated-candidate-dir",
    "r2-staging",
    "output-dir",
  ] as const;
  if (flags.size !== expected.length || expected.some((key) => !flags.has(key))) {
    fail(`arguments must be exactly ${expected.map((key) => `--${key}=...`).join(" ")}`);
  }
  return {
    productTruth: exactPath(flags.get("product-truth"), "--product-truth"),
    diagnosis: exactPath(flags.get("diagnosis"), "--diagnosis"),
    buyerSnapshot: exactPath(flags.get("buyer-snapshot"), "--buyer-snapshot"),
    buyerPdp: exactPath(flags.get("buyer-pdp"), "--buyer-pdp"),
    curatedCandidateDir: exactPath(
      flags.get("curated-candidate-dir"),
      "--curated-candidate-dir",
    ),
    r2Staging: exactPath(flags.get("r2-staging"), "--r2-staging"),
    outputDir: exactPath(flags.get("output-dir"), "--output-dir"),
  };
}

async function readJson<T = JsonRecord>(pathname: string, label: string): Promise<{
  bytes: Buffer;
  value: T;
}> {
  const bytes = await readFile(pathname);
  if (!bytes.length || bytes.length > MAX_JSON_BYTES) fail(`${label} exceeds the byte bound`);
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) as T };
  } catch {
    return fail(`${label} is not JSON`);
  }
}

function verifySeal(value: JsonRecord, label: string): string {
  if (typeof value.body_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.body_sha256)) {
    fail(`${label}.body_sha256 is invalid`);
  }
  const body = { ...value };
  delete body.body_sha256;
  if (bodySha256(body) !== value.body_sha256) fail(`${label} body SHA mismatch`);
  return value.body_sha256;
}

function numberWord(value: number): string {
  const words: Record<number, string> = {
    1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six",
    7: "seven", 8: "eight", 9: "nine", 10: "ten", 11: "eleven", 12: "twelve",
  };
  return words[value] ?? String(value);
}

function html(value: unknown): string {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

async function writeExclusive(pathname: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(pathname, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o400);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function renderImages(images: JsonRecord[]): string {
  return images.map((image) => `
    <figure>
      <img src="${html(image.local_path)}" alt="${html(image.slot)}">
      <figcaption><b>${html(image.slot)}</b><br>${html(image.caption)}</figcaption>
    </figure>`).join("");
}

function renderGallery(preview: JsonRecord): string {
  const before = preview.before as JsonRecord;
  const after = preview.after as JsonRecord;
  const beforeText = before.text as JsonRecord;
  const afterText = after.text as JsonRecord;
  const beforeImages = (before.images as JsonRecord).assets as JsonRecord[];
  const afterImages = (after.images as JsonRecord).assets as JsonRecord[];
  const beforeBullets = beforeText.bullets as string[];
  const afterBullets = afterText.bullets as string[];
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${html(preview.sku)} — До / После</title>
<style>
body{font-family:Inter,Arial,sans-serif;margin:0;background:#f4f7fb;color:#172033}
main{max-width:1560px;margin:28px auto;padding:0 24px}
h1{margin:0 0 8px}.sub{color:#526078;margin-bottom:20px}.ok{background:#e8f8ee;border:1px solid #8ed1a4;padding:15px 18px;border-radius:12px}
.compare,.text-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:20px}
.panel{background:#fff;border:1px solid #d8e1ed;border-radius:16px;overflow:hidden;box-shadow:0 4px 18px #20305010}
.head{padding:14px 18px;font-weight:900}.before .head{background:#fff0ef;color:#9f251e}.after .head{background:#e9f8ef;color:#176b36}
.images{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:14px}
figure{margin:0;border:1px solid #e1e7f0;border-radius:12px;overflow:hidden;background:white}
figure:first-child{grid-column:1/-1}figure img{width:100%;height:320px;object-fit:contain;display:block}figure:first-child img{height:560px}
figcaption{padding:9px 11px;background:#f8fafc;font-size:13px}
.body{padding:18px}.text{white-space:pre-wrap;line-height:1.46;font-size:14px}li{margin:7px 0;line-height:1.4}
.bad{color:#a12620}.good{color:#176b36}.unchanged{margin:20px 0;background:#eef4ff;border:1px solid #b8cdf4;border-radius:12px;padding:16px}
code{background:#edf1f7;padding:2px 5px;border-radius:5px}
@media(max-width:900px){.compare,.text-grid{grid-template-columns:1fr}.images{grid-template-columns:1fr}figure:first-child{grid-column:auto}figure img,figure:first-child img{height:390px}}
</style></head><body><main>
<h1>${html(preview.sku)} — Walmart Listing Integrity</h1>
<div class="sub">${html(preview.title)} · item ${html(preview.item_id)}</div>
<div class="ok"><b>Целевой image-set: Qualification PASS.</b> Новый MAIN показывает ровно
 ${html(preview.outer_units)} упаковки точного White Sandwich Bread. В gallery оставлены только
 два изображения с самостоятельным визуальным PASS.</div>
<section class="compare">
<article class="panel before"><div class="head">ДО — LIVE WALMART</div><div class="images">${renderImages(beforeImages)}</div></article>
<article class="panel after"><div class="head">ПОСЛЕ — QUALIFIED PREVIEW</div><div class="images">${renderImages(afterImages)}</div></article>
</section>
<section class="text-grid">
<article class="panel before"><div class="head">ТЕКСТ ДО</div><div class="body">
<h3 class="bad">Description</h3><div class="text">${html(beforeText.description)}</div>
<h3 class="bad">Bullets</h3><ul>${beforeBullets.map((item) => `<li>${html(item)}</li>`).join("")}</ul>
</div></article>
<article class="panel after"><div class="head">ТЕКСТ ПОСЛЕ</div><div class="body">
<h3 class="good">Description</h3><div class="text">${html(afterText.description)}</div>
<h3 class="good">Bullets</h3><ul>${afterBullets.map((item) => `<li>${html(item)}</li>`).join("")}</ul>
</div></article>
</section>
<div class="unchanged"><b>Не меняется:</b> product-first title, attributes, price, inventory,
 identifiers, publication/lifecycle. Изменяются только description, bullets, MAIN и gallery.
 Walmart write ещё не выполнялся.</div>
</main></body></html>`;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  try {
    await lstat(args.outputDir);
    fail("--output-dir must not already exist");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const curatedManifestPath = path.join(args.curatedCandidateDir, "manifest.json");
  const [
    truthArtifact,
    diagnosisArtifact,
    snapshotArtifact,
    buyerPdpArtifact,
    curatedArtifact,
    r2Artifact,
  ] = await Promise.all([
    readJson<ProductTruthSnapshot>(args.productTruth, "Product Truth"),
    readJson<JsonRecord>(args.diagnosis, "diagnosis"),
    readJson<JsonRecord>(args.buyerSnapshot, "buyer snapshot"),
    readJson<JsonRecord>(args.buyerPdp, "buyer PDP"),
    readJson<JsonRecord>(curatedManifestPath, "curated image set"),
    readJson<JsonRecord>(args.r2Staging, "R2 staging"),
  ]);
  const diagnosis = diagnosisArtifact.value;
  const detector = diagnosis.detector_input as JsonRecord;
  const listing = detector.listing as JsonRecord;
  const surface = detector.surface as JsonRecord;
  const truth = truthArtifact.value;
  const component = truth.views.listingImprovement.components[0];
  const content = component?.content;
  const curated = curatedArtifact.value;
  const r2 = r2Artifact.value;
  verifySeal(curated, "curated image set");
  verifySeal(r2, "R2 staging");
  if (!truth.views.listingImprovement.ready || !component || !content
    || truth.snapshot.listingKey !== diagnosis.listing_key
    || listing.listing_key !== truth.snapshot.listingKey
    || (diagnosis.outcome as JsonRecord).status !== "BAD"
    || curated.schema_version !== "walmart-listing-image-set-curated/v1"
    || curated.status !== "PASS" || curated.listing_key !== truth.snapshot.listingKey
    || r2.schema_version !== "walmart-listing-main-r2-staging/v2"
    || r2.status !== "R2_VERIFIED_NOT_WALMART_PUBLISHED"
    || r2.listing_key !== truth.snapshot.listingKey) {
    fail("Product Truth, diagnosis, curated image set, and R2 staging do not bind");
  }
  const targetRows = curated.targets;
  if (!Array.isArray(targetRows) || targetRows.length < 2) {
    fail("curated target set is incomplete");
  }
  const r2Fields = r2.r2 as JsonRecord;
  const r2Candidate = r2.candidate as JsonRecord;
  const targetMain = targetRows[0] as JsonRecord;
  if (r2Candidate.sha256 !== targetMain.sha256
    || typeof r2Fields.public_url !== "string") {
    fail("R2 MAIN differs from curated target");
  }
  const snapshot = snapshotArtifact.value;
  const snapshotAssets = snapshot.assets;
  if (!Array.isArray(snapshotAssets) || snapshotAssets.length < 1) {
    fail("buyer snapshot images are missing");
  }
  const beforeImages = snapshotAssets.map((value, index) => {
    const row = value as JsonRecord;
    return {
      slot: index === 0 ? "MAIN" : `GALLERY ${index}`,
      local_path: path.join(path.dirname(args.buyerSnapshot), String(row.local_path)),
      sha256: row.sha256,
      caption: index === 0
        ? "Hamburger Buns вместо White Sandwich Bread"
        : "Текущая live gallery; содержит изображения другого продукта",
    };
  });
  const afterImages = targetRows.map((value, index) => {
    const row = value as JsonRecord;
    return {
      slot: index === 0 ? "MAIN" : `GALLERY ${index}`,
      local_path: path.join(args.curatedCandidateDir, String(row.file)),
      public_url: index === 0 ? r2Fields.public_url : row.source_url,
      sha256: row.sha256,
      caption: index === 0
        ? `Ровно ${component.qty} упаковки White Sandwich Bread`
        : "Exact Product Truth image; deterministic visual PASS",
    };
  });

  const outer = component.qty;
  const singleSize = component.size;
  const totalOunces = Number.parseFloat(singleSize) * outer;
  const singleTitle = content.facts.title.replace(/,\s*16 oz Loaf$/iu, "").trim();
  const quantitySummary =
    `PACK OF ${outer}: This listing includes ${numberWord(outer)} 16 oz loaves of `
    + `${singleTitle}, for ${totalOunces} oz total.`;
  const sourceDescription = (content.facts.description ?? "")
    .replace(/\s*Shelf-stable product\.?\s*$/iu, "")
    .trim();
  const afterDescription = `${quantitySummary} ${sourceDescription} Shelf-stable product.`
    .replace(/\s+/gu, " ")
    .trim();
  const sourceBullets = (content.facts.bullets ?? [])
    .filter((value) => value.trim().length > 0);
  const afterBullets = [
    `PACK OF ${outer}: Includes ${outer} loaves of ${singleTitle}; each loaf is 16 oz, for ${totalOunces} oz total`,
    ...sourceBullets,
  ].filter((value, index, values) => values.indexOf(value) === index).slice(0, 6);
  const buyerProduct = buyerPdpArtifact.value.product as JsonRecord;
  const body = {
    schema_version: "walmart-listing-integrity-image-set-repair-preview/v1",
    created_at: new Date().toISOString(),
    status: "READY_FOR_OWNER_VISUAL_REVIEW",
    listing_key: truth.snapshot.listingKey,
    store_index: truth.snapshot.storeIndex,
    sku: truth.snapshot.sku,
    item_id: listing.item_id,
    title: surface.title,
    outer_units: outer,
    exact_product_truth: {
      component_evidence_id: component.componentEvidenceId,
      canonical_variant_id: component.targetCanonicalVariantId,
      content_observation_id: content.provenance.contentObservationId,
      content_hash: content.provenance.contentHash,
      product_truth_file_sha256: sha256(truthArtifact.bytes),
    },
    changed_fields: ["description", "bullets", "main", "gallery"],
    before: {
      text: {
        title: surface.title,
        description: surface.description,
        bullets: surface.bullets,
      },
      images: { assets: beforeImages },
    },
    after: {
      text: {
        title: surface.title,
        description: afterDescription,
        bullets: afterBullets,
      },
      images: { assets: afterImages },
    },
    unchanged_fields: [
      "title",
      "attributes",
      "price",
      "inventory",
      "identifiers",
      "published_status",
      "lifecycle_status",
    ],
    source_files: {
      diagnosis_sha256: sha256(diagnosisArtifact.bytes),
      buyer_snapshot_sha256: sha256(snapshotArtifact.bytes),
      buyer_pdp_sha256: sha256(buyerPdpArtifact.bytes),
      curated_candidate_manifest_sha256: sha256(curatedArtifact.bytes),
      r2_staging_sha256: sha256(r2Artifact.bytes),
      live_buyer_product_sha256: bodySha256(buyerProduct),
    },
    safety: {
      marketplace_write_authorized: false,
      walmart_writes: 0,
      database_writes: 0,
      model_calls: 0,
    },
  } as const;
  const preview = { ...body, body_sha256: bodySha256(body) };
  await mkdir(args.outputDir, { recursive: false, mode: 0o700 });
  const previewPath = path.join(args.outputDir, "preview.json");
  const galleryPath = path.join(args.outputDir, "gallery.html");
  await writeExclusive(
    previewPath,
    Buffer.from(`${JSON.stringify(preview, null, 2)}\n`, "utf8"),
  );
  await writeExclusive(
    galleryPath,
    Buffer.from(renderGallery(preview as unknown as JsonRecord), "utf8"),
  );
  await chmod(args.outputDir, 0o500);
  process.stdout.write(`${JSON.stringify({
    status: preview.status,
    listing_key: preview.listing_key,
    changed_fields: preview.changed_fields,
    preview_path: previewPath,
    preview_body_sha256: preview.body_sha256,
    gallery_path: galleryPath,
    safety: preview.safety,
  }, null, 2)}\n`);
}

if (process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
