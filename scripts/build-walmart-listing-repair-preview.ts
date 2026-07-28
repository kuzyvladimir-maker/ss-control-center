#!/usr/bin/env node

/**
 * Compile one owner-readable Walmart Listing Integrity preview from a fresh
 * diagnosis and a blind-qualified deterministic MAIN candidate. Local,
 * immutable and zero-write to Walmart/R2/database.
 */

import { createHash } from "node:crypto";
import {
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
  throw new Error(`Walmart repair preview rejected input: ${message}`);
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
    "candidate-dir",
    "candidate-qualification",
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
    candidateDir: exactPath(flags.get("candidate-dir"), "--candidate-dir"),
    qualification: exactPath(
      flags.get("candidate-qualification"),
      "--candidate-qualification",
    ),
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

function numberWord(value: number): string {
  const words: Record<number, string> = {
    1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six",
    7: "seven", 8: "eight", 9: "nine", 10: "ten", 11: "eleven", 12: "twelve",
  };
  return words[value] ?? String(value);
}

function pluralForm(form: string | null, quantity: number): string {
  const noun = form?.trim().toLowerCase() || "package";
  if (quantity === 1) return noun;
  if (noun.endsWith("s")) return noun;
  if (noun.endsWith("y")) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

function cleanSingleUnitTitle(value: string): string {
  return value
    .replace(/\s*[-,]\s*\d+(?:\.\d+)?\s*(?:fl\s*oz|oz|lb|g|kg|ml|l)\s*\/?\s*\d*\s*(?:ct|count)?\s*$/iu, "")
    .trim();
}

function removeConflictingPackSentences(value: string): string {
  return value
    .split(/(?<=[.!?])\s+/u)
    .filter((sentence) => !/\bour\s+\d+\s*-\s*pack\b/iu.test(sentence))
    .join(" ")
    .trim();
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

function renderGallery(preview: JsonRecord): string {
  const before = preview.before as JsonRecord;
  const after = preview.after as JsonRecord;
  const beforeImages = before.images as JsonRecord;
  const afterImages = after.images as JsonRecord;
  const beforeText = before.text as JsonRecord;
  const afterText = after.text as JsonRecord;
  const bulletsBefore = beforeText.bullets as string[];
  const bulletsAfter = afterText.bullets as string[];
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${html(preview.sku)} — Walmart Listing Integrity</title>
<style>
body{font-family:Inter,Arial,sans-serif;margin:0;background:#f4f7fb;color:#172033}
main{max-width:1420px;margin:28px auto;padding:0 24px}
h1{margin:0 0 8px}.sub{color:#526078;margin-bottom:20px}
.status{background:#e9f8ef;border:1px solid #9bd8af;padding:14px 18px;border-radius:12px;margin:18px 0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:22px}
.card{background:white;border:1px solid #dce3ee;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px #20305010}
.head{display:flex;justify-content:space-between;padding:14px 18px;font-weight:800}
.before .head{background:#fff0ef;color:#9f251e}.after .head{background:#e9f8ef;color:#176b36}
.image{height:600px;display:flex;align-items:center;justify-content:center;padding:18px;background:#fff}
.image img{width:100%;height:100%;object-fit:contain}
.body{padding:18px}.label{font-weight:800;margin:10px 0 6px}.bad{color:#a12620}.good{color:#176b36}
.text-grid{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-top:22px}
.text{white-space:pre-wrap;line-height:1.48;font-size:14px}
li{margin:8px 0;line-height:1.4}
.unchanged{margin-top:22px;background:#eef4ff;border:1px solid #b8cdf4;border-radius:12px;padding:16px}
code{background:#edf1f7;padding:2px 5px;border-radius:5px}
@media(max-width:900px){.grid,.text-grid{grid-template-columns:1fr}.image{height:420px}}
</style></head><body><main>
<h1>${html(preview.sku)} — точное исправление Walmart</h1>
<div class="sub">${html(preview.title)} · item ${html(preview.item_id)}</div>
<div class="status"><b>Qualification MAIN: PASS.</b> Точный товар, ровно ${html(preview.outer_units)}
 упаковки, белый фон, правильный front, без смешения товаров.</div>
<section class="grid">
<article class="card before"><div class="head"><span>ДО</span><span>LIVE SNAPSHOT</span></div>
<div class="image"><img src="${html(beforeImages.main_path)}"></div>
<div class="body"><div class="label bad">Ошибка</div>
MAIN показывает ${html(beforeImages.visible_outer_units)} упаковок, хотя листинг продаёт
 Pack of ${html(preview.outer_units)}.</div></article>
<article class="card after"><div class="head"><span>ПОСЛЕ</span><span>QUALIFIED PREVIEW</span></div>
<div class="image"><img src="${html(afterImages.main_path)}"></div>
<div class="body"><div class="label good">Исправление</div>
MAIN показывает ровно ${html(preview.outer_units)} реальные упаковки точного товара.
 SHA-256: <code>${html(afterImages.main_sha256)}</code></div></article>
</section>
<section class="text-grid">
<article class="card before"><div class="head"><span>ТЕКСТ ДО</span></div><div class="body">
<div class="label bad">Description</div><div class="text">${html(beforeText.description)}</div>
<div class="label bad">Bullets</div><ul>${bulletsBefore.map((item) => `<li>${html(item)}</li>`).join("")}</ul>
</div></article>
<article class="card after"><div class="head"><span>ТЕКСТ ПОСЛЕ</span></div><div class="body">
<div class="label good">Description</div><div class="text">${html(afterText.description)}</div>
<div class="label good">Bullets</div><ul>${bulletsAfter.map((item) => `<li>${html(item)}</li>`).join("")}</ul>
</div></article>
</section>
<div class="unchanged"><b>Без изменений:</b> title, attributes, gallery, price, inventory,
 identifiers, publication и lifecycle. Title остаётся product-first; количество не переносится
 в начало.</div>
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
  const candidateManifestPath = path.join(args.candidateDir, "manifest.json");
  const [
    truthArtifact,
    diagnosisArtifact,
    snapshotArtifact,
    buyerPdpArtifact,
    candidateArtifact,
    qualificationArtifact,
  ] = await Promise.all([
    readJson<ProductTruthSnapshot>(args.productTruth, "Product Truth"),
    readJson(args.diagnosis, "diagnosis"),
    readJson(args.buyerSnapshot, "buyer snapshot"),
    readJson(args.buyerPdp, "buyer PDP"),
    readJson(candidateManifestPath, "candidate manifest"),
    readJson(args.qualification, "candidate qualification"),
  ]);
  const truth = truthArtifact.value;
  const diagnosis = diagnosisArtifact.value;
  const detector = diagnosis.detector_input as JsonRecord;
  const listing = detector.listing as JsonRecord;
  const surface = detector.surface as JsonRecord;
  const expected = detector.expected as JsonRecord;
  const detectorImages = detector.images as JsonRecord;
  const currentMainEvidence = (detectorImages.evidence as JsonRecord[])?.[0];
  const currentMainObservation = currentMainEvidence?.observation as JsonRecord | undefined;
  const currentMainCount = (
    currentMainObservation?.external_package_count as JsonRecord | undefined
  )?.value;
  const component = truth.views.listingImprovement.components[0];
  const content = component?.content;
  const candidate = candidateArtifact.value;
  const candidateImage = candidate.candidate as JsonRecord;
  const qualification = qualificationArtifact.value;
  if (!truth.views.listingImprovement.ready || !component || !content
    || truth.snapshot.listingKey !== diagnosis.listing_key
    || listing.listing_key !== truth.snapshot.listingKey
    || (diagnosis.outcome as JsonRecord).status !== "BAD"
    || qualification.status !== "PASS"
    || qualification.candidate_sha256 !== candidateImage.sha256
    || candidate.listing_key !== truth.snapshot.listingKey
    || candidate.represented_outer_units !== component.qty
    || !Number.isSafeInteger(currentMainCount)) {
    fail("Product Truth, diagnosis, candidate and Qualification do not bind together");
  }
  const snapshot = snapshotArtifact.value;
  const assets = snapshot.assets as JsonRecord[];
  const currentMain = assets?.[0];
  if (!currentMain || currentMain.slot !== "MAIN"
    || typeof currentMain.local_path !== "string"
    || typeof currentMain.sha256 !== "string") {
    fail("buyer snapshot MAIN is missing");
  }
  const expectedFacts = expected.package_facts as JsonRecord[];
  const innerFact = expectedFacts.find((fact) => fact.kind === "inner_item_count");
  const netClaim = (surface.attribute_claims as JsonRecord[]).find(
    (claim) => claim.kind === "net_content",
  );
  if (!innerFact || typeof innerFact.value !== "number"
    || !netClaim || typeof netClaim.value !== "number"
    || typeof netClaim.unit !== "string") {
    fail("exact inner count or net content is missing");
  }
  const outer = component.qty;
  const totalInner = Number(innerFact.value) * outer;
  const packageNoun = pluralForm(content.identity.form, outer);
  const singleTitle = cleanSingleUnitTitle(content.facts.title ?? component.product);
  const quantitySummary =
    `PACK OF ${outer}: This listing includes ${numberWord(outer)} ${netClaim.value} ${netClaim.unit} `
    + `${packageNoun} of ${singleTitle}. Each ${pluralForm(content.identity.form, 1)} contains `
    + `${innerFact.value} buns, for ${totalInner} buns total.`;
  const sourceDescription = removeConflictingPackSentences(content.facts.description ?? "");
  const afterDescription = `${quantitySummary} ${sourceDescription} Shelf-stable product.`
    .replace(/\s+/gu, " ")
    .trim();
  const sourceBullets = Array.isArray(content.facts.bullets)
    ? content.facts.bullets.filter((value): value is string => (
      typeof value === "string"
      && value.trim().length > 0
      && !/\bhamburger buns\b/iu.test(value)
    ))
    : [];
  const packBullet =
    `PACK OF ${outer}: Includes ${outer} ${packageNoun} of ${singleTitle}; `
    + `each ${netClaim.value} ${netClaim.unit} ${pluralForm(content.identity.form, 1)} `
    + `contains ${innerFact.value} buns, for ${totalInner} buns total`;
  const afterBullets = [packBullet, ...sourceBullets]
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 6);
  const candidatePath = path.join(args.candidateDir, String(candidateImage.file));
  const currentMainPath = path.join(path.dirname(args.buyerSnapshot), currentMain.local_path);
  const beforeDescription = String(surface.description ?? "");
  const beforeBullets = surface.bullets as string[];
  const previewBody = {
    schema_version: "walmart-listing-integrity-repair-preview/v2",
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
    changed_fields: ["description", "bullets", "main"],
    before: {
      text: {
        title: surface.title,
        description: beforeDescription,
        bullets: beforeBullets,
      },
      images: {
        main_path: currentMainPath,
        main_sha256: currentMain.sha256,
        visible_outer_units: currentMainCount,
        gallery_unchanged: true,
      },
    },
    after: {
      text: {
        title: surface.title,
        description: afterDescription,
        bullets: afterBullets,
      },
      images: {
        main_path: candidatePath,
        main_sha256: candidateImage.sha256,
        represented_outer_units: outer,
        qualification_body_sha256: qualification.body_sha256,
        gallery_unchanged: true,
      },
    },
    unchanged_fields: [
      "title",
      "attributes",
      "gallery",
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
      candidate_manifest_sha256: sha256(candidateArtifact.bytes),
      qualification_sha256: sha256(qualificationArtifact.bytes),
    },
    safety: {
      marketplace_write_authorized: false,
      walmart_writes: 0,
      database_writes: 0,
      r2_writes: 0,
      model_calls: 0,
    },
  } as const;
  const preview = { ...previewBody, body_sha256: bodySha256(previewBody) };
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
