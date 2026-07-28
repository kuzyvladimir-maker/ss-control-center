#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const flags = new Map();
  for (const argument of argv) {
    const match = /^--([a-z0-9-]+)=(.+)$/u.exec(argument);
    if (!match || flags.has(match[1])) fail(`unsupported or duplicate argument: ${argument}`);
    flags.set(match[1], match[2]);
  }
  const required = ["request", "certification", "snapshot", "asset-root", "output-dir"];
  if (flags.size !== required.length || required.some((key) => !flags.has(key))) {
    fail(`required arguments: ${required.map((key) => `--${key}=...`).join(" ")}`);
  }
  return Object.fromEntries(
    required.map((key) => [key.replaceAll("-", "_"), path.resolve(flags.get(key))]),
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(value[key])}`
  )).join(",")}}`;
}

function bodySha(value) {
  return sha256(Buffer.from(canonical(value), "utf8"));
}

async function readJson(file) {
  const bytes = await readFile(file);
  return { bytes, value: JSON.parse(bytes.toString("utf8")), file_sha256: sha256(bytes) };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function exactArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => canonical(value) === canonical(right[index]));
}

function safeAsset(root, relative) {
  if (!relative || path.isAbsolute(relative)
    || relative.split(/[\\/]/u).some((part) => !part || part === "..")) {
    fail(`unsafe snapshot asset path: ${relative}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) fail("snapshot asset escapes root");
  return resolved;
}

function render({ request, imagePaths, verification }) {
  const before = request.repair.baseline_surface;
  const after = request.repair.target_surface;
  const images = imagePaths.map((image) => `
    <figure>
      <img src="${escapeHtml(image.relative)}" alt="${escapeHtml(image.slot)}">
      <figcaption>${escapeHtml(image.slot)} · SHA ${escapeHtml(image.sha256.slice(0, 12))}…</figcaption>
    </figure>`).join("");
  const bullets = before.bullets.map((bullet, index) => `
    <tr>
      <td>${escapeHtml(bullet)}</td>
      <td class="${bullet === after.bullets[index] ? "same" : "changed"}">${escapeHtml(after.bullets[index])}</td>
    </tr>`).join("");
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(request.listing.sku)} — exact owner review</title>
<style>
:root{color-scheme:light;--ink:#17212b;--muted:#637181;--line:#dbe3ea;--red:#9d241a;--redbg:#fff0ee;--green:#116b3c;--greenbg:#eaf8ef;--blue:#0b57d0}
*{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{width:min(1320px,calc(100% - 28px));margin:24px auto 60px}.card{margin:16px 0;padding:22px;border:1px solid var(--line);border-radius:18px;background:#fff}
h1{margin:4px 0 10px;font-size:clamp(28px,4vw,48px);line-height:1.05}.eyebrow{color:var(--blue);font:700 12px ui-monospace,monospace}.muted{color:var(--muted)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.side{padding:18px;border-radius:14px;border:1px solid}.before{border-color:#edb5ae;background:var(--redbg)}.after{border-color:#a9d5ba;background:var(--greenbg)}
.label{font-weight:800;text-transform:uppercase}.before .label{color:var(--red)}.after .label{color:var(--green)}
.gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.gallery figure{margin:0;border:1px solid var(--line);border-radius:12px;overflow:hidden}.gallery img{display:block;width:100%;aspect-ratio:1;object-fit:contain;background:#fff}.gallery figcaption{padding:8px;font:11px ui-monospace,monospace;color:var(--muted)}
table{width:100%;border-collapse:collapse}th,td{width:50%;padding:12px;vertical-align:top;border:1px solid var(--line);text-align:left}.changed{background:var(--greenbg);color:var(--green);font-weight:650}.same{background:#f7f9fb}
.checks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.check{padding:10px;border-radius:10px;background:var(--greenbg);color:var(--green);font-weight:700}
code{word-break:break-all}@media(max-width:800px){.grid,.checks{grid-template-columns:1fr}.gallery{grid-template-columns:1fr}th,td{display:block;width:100%}}
</style></head><body><main>
<section class="card">
  <div class="eyebrow">WALMART LISTING INTEGRITY · EXACT OWNER REVIEW · NO WRITE</div>
  <h1>${escapeHtml(request.listing.sku)} · Pack of ${request.product_truth_candidate.outer_units}</h1>
  <p>${escapeHtml(before.title)}</p>
  <p class="muted">Item ${escapeHtml(request.listing.item_id)} · captured ${escapeHtml(request.listing.captured_at)} · PUBLISHED / ACTIVE</p>
</section>
<section class="card">
  <h2>Изображения не меняются</h2>
  <p class="muted">Свежие MAIN и gallery побайтово совпадают с exact target.</p>
  <div class="gallery">${images}</div>
</section>
<section class="card">
  <h2>Description</h2>
  <div class="grid">
    <div class="side before"><div class="label">До · live</div><p>${escapeHtml(before.description)}</p></div>
    <div class="side after"><div class="label">Предлагаемое</div><p>${escapeHtml(after.description)}</p></div>
  </div>
</section>
<section class="card">
  <h2>Bullet points</h2>
  <table><thead><tr><th>До · live</th><th>Предлагаемое</th></tr></thead><tbody>${bullets}</tbody></table>
</section>
<section class="card">
  <h2>Qualification precheck</h2>
  <div class="checks">
    ${Object.entries(verification.checks).map(([key, value]) => (
      `<div class="check">✓ ${escapeHtml(key)} = ${escapeHtml(value)}</div>`
    )).join("")}
  </div>
  <p class="muted">Review SHA: <code>${escapeHtml(verification.review_file_sha256)}</code></p>
  <p class="muted">Compilation body SHA: <code>${escapeHtml(request.body_sha256)}</code></p>
</section>
</main></body></html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [requestFile, certificationFile, snapshotFile] = await Promise.all([
    readJson(args.request),
    readJson(args.certification),
    readJson(args.snapshot),
  ]);
  const request = requestFile.value;
  const certification = certificationFile.value;
  const snapshot = snapshotFile.value;
  const { body_sha256: requestSeal, ...requestBody } = request;
  const { body_sha256: certificationSeal, ...certificationBody } = certification;
  const snapshotSeal = snapshot.body_sha256;
  const snapshotBody = { ...snapshot };
  delete snapshotBody.body_sha256;
  delete snapshotBody.snapshot_id;
  if (bodySha(requestBody) !== requestSeal) fail("compilation request body seal mismatch");
  if (bodySha(certificationBody) !== certificationSeal) fail("certification body seal mismatch");
  if (bodySha(snapshotBody) !== snapshotSeal) fail("buyer snapshot body seal mismatch");
  if (certification.qualification_precheck !== "PASS"
    || certification.exact_image_bytes_verified !== true
    || certification.proposal_sha256 !== request.frozen_review.proposal_file_sha256
    || certificationFile.file_sha256 !== request.frozen_review.certification_file_sha256
    || snapshotFile.file_sha256 !== request.frozen_review.buyer_snapshot_file_sha256) {
    fail("review/certification/snapshot bindings differ");
  }
  if (!exactArray(request.repair.baseline_images, request.repair.target_images)
    || request.repair.unchanged_image_bytes !== true
    || !exactArray(request.repair.changed_fields, ["description", "bullets"])) {
    fail("owner review must be description/bullets-only with unchanged images");
  }
  if (snapshot.target?.sku !== request.listing.sku
    || snapshot.target?.item_id !== request.listing.item_id
    || snapshot.assets?.length !== request.repair.target_images.length) {
    fail("buyer snapshot listing/images differ from compilation request");
  }
  const outputAssets = path.join(args.output_dir, "assets");
  await mkdir(outputAssets, { recursive: true });
  const imagePaths = [];
  for (const [index, asset] of snapshot.assets.entries()) {
    const bytes = await readFile(safeAsset(args.asset_root, asset.local_path));
    const target = request.repair.target_images[index];
    if (sha256(bytes) !== asset.sha256 || asset.sha256 !== target.sha256
      || asset.source_url !== target.source_url) {
      fail(`snapshot image ${index} differs from exact target`);
    }
    const filename = path.basename(asset.local_path);
    await copyFile(safeAsset(args.asset_root, asset.local_path), path.join(outputAssets, filename));
    imagePaths.push({
      slot: asset.slot,
      sha256: asset.sha256,
      relative: `assets/${filename}`,
    });
  }
  const verificationBody = {
    schema_version: "walmart-listing-integrity-owner-review-gallery/v1",
    created_at: new Date().toISOString(),
    status: "OWNER_REVIEW_READY",
    listing: request.listing,
    review_file_sha256: request.frozen_review.proposal_file_sha256,
    compilation_request_file_sha256: requestFile.file_sha256,
    compilation_request_body_sha256: request.body_sha256,
    certification_file_sha256: certificationFile.file_sha256,
    snapshot_file_sha256: snapshotFile.file_sha256,
    checks: {
      qualification_precheck: "PASS",
      exact_image_bytes: "PASS",
      changed_fields_only: "description, bullets",
      title_unchanged: request.repair.baseline_surface.title === request.repair.target_surface.title
        ? "PASS" : "FAIL",
      images_unchanged: "PASS",
      walmart_writes: 0,
    },
  };
  if (verificationBody.checks.title_unchanged !== "PASS") fail("title changed in owner review");
  const verification = {
    ...verificationBody,
    body_sha256: bodySha(verificationBody),
  };
  await mkdir(args.output_dir, { recursive: true });
  const htmlPath = path.join(args.output_dir, "owner-review-gallery.html");
  const jsonPath = path.join(args.output_dir, "owner-review-verification.json");
  await writeFile(htmlPath, render({ request, imagePaths, verification }), { flag: "wx", mode: 0o400 });
  await writeFile(jsonPath, `${JSON.stringify(verification, null, 2)}\n`, { flag: "wx", mode: 0o400 });
  process.stdout.write(`${JSON.stringify({
    status: verification.status,
    html_path: htmlPath,
    json_path: jsonPath,
    body_sha256: verification.body_sha256,
  }, null, 2)}\n`);
}

await main();
