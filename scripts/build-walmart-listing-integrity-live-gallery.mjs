#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  const required = [
    "before-dir",
    "after-dir",
    "execution-package",
    "feed-receipt",
    "terminal-report",
    "qualification-receipt",
    "output-dir",
  ];
  if (flags.size !== required.length || required.some((key) => !flags.has(key))) {
    fail(`required arguments: ${required.map((key) => `--${key}=...`).join(" ")}`);
  }
  return Object.fromEntries(required.map((key) => [key.replaceAll("-", "_"), path.resolve(flags.get(key))]));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function bodySha(value) {
  return sha256(Buffer.from(canonical(value), "utf8"));
}

async function readJson(file) {
  const bytes = await readFile(file);
  return { bytes, value: JSON.parse(bytes.toString("utf8")), file_sha256: sha256(bytes) };
}

function safeChild(root, relative) {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/u).some((part) => !part || part === "..")) {
    fail(`unsafe evidence path: ${relative}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) fail(`evidence path escapes root: ${relative}`);
  return resolved;
}

async function verifyIntake(root) {
  const index = await readJson(path.join(root, "intake-index.json"));
  const { body_sha256, ...body } = index.value;
  if (bodySha(body) !== body_sha256) fail(`${root}: intake index body seal mismatch`);
  for (const file of index.value.files ?? []) {
    const bytes = await readFile(safeChild(root, file.path));
    if (bytes.length !== file.bytes || sha256(bytes) !== file.file_sha256) {
      fail(`${root}: ${file.role} bytes differ from intake index`);
    }
  }
  return index;
}

function exactArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sellerRow(payload) {
  const rows = payload?.ItemResponse;
  if (!Array.isArray(rows) || rows.length !== 1) fail("seller-item must contain exactly one ItemResponse");
  return rows[0];
}

function imageRows(index) {
  return (index.files ?? [])
    .filter((row) => row.role === "buyer_image_main" || row.role.startsWith("buyer_image_gallery_"))
    .sort((left, right) => {
      if (left.role === "buyer_image_main") return -1;
      if (right.role === "buyer_image_main") return 1;
      return left.role.localeCompare(right.role);
    });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderBullets(values) {
  return `<ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`;
}

function renderHtml(verification, before, after, plan) {
  const beforeProduct = before.product;
  const afterProduct = after.product;
  const targetImages = plan.target.images;
  const mainChanged = plan.changed_fields.includes("main");
  const statusCopy = mainChanged
    ? "Walmart опубликовал точный approved text target и прошедшую независимую визуальную Qualification новую MAIN. Title и дополнительные изображения не менялись."
    : "Walmart опубликовал точный approved target. Title и изображения не менялись; изменены только description и bullets.";
  const cards = targetImages.map((image, index) => `
    <div class="image-pair">
      <div class="image-card before">
        <div class="label">ДО · ${escapeHtml(image.slot)}</div>
        <img src="${escapeHtml(beforeProduct.images[index])}" alt="До ${escapeHtml(image.slot)}">
        <code>${escapeHtml(verification.before.image_sha256[index])}</code>
      </div>
      <div class="arrow">→</div>
      <div class="image-card after">
        <div class="label">ПОСЛЕ · ${escapeHtml(image.slot)}</div>
        <img src="${escapeHtml(afterProduct.images[index])}" alt="После ${escapeHtml(image.slot)}">
        <code>${escapeHtml(verification.after.image_sha256[index])}</code>
      </div>
    </div>`).join("");
  const checks = Object.entries(verification.checks)
    .map(([name, value]) => `<li class="${value ? "pass" : "fail"}">${value ? "✓" : "✗"} ${escapeHtml(name)}</li>`)
    .join("");
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Walmart Listing Integrity · ${escapeHtml(verification.listing.sku)} · Фактическое До → После</title>
  <style>
    :root{color-scheme:light;font-family:Inter,Arial,sans-serif;color:#172033;background:#f4f7fb}
    body{margin:0}.page{max-width:1320px;margin:0 auto;padding:32px}
    h1{font-size:30px;margin:0 0 8px}.meta{color:#596579;margin-bottom:24px}
    .status{padding:18px 22px;border-radius:16px;background:#e8f7ee;border:1px solid #93d2aa;margin:18px 0}
    .status strong{font-size:20px;color:#116630}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
    .panel,.image-card{background:#fff;border:1px solid #dce3ee;border-radius:16px;padding:20px}
    .before{border-color:#f2b4ad}.after{border-color:#9fd6b2}.label{font-weight:800;margin-bottom:14px}
    .before .label{color:#a52a22}.after .label{color:#176b37}
    .image-pair{display:grid;grid-template-columns:1fr 40px 1fr;align-items:center;gap:10px;margin:20px 0}
    img{width:100%;height:330px;object-fit:contain;background:#fff;border-radius:12px}
    .arrow{text-align:center;font-size:30px;color:#0b67d0}.section{margin-top:28px}
    p,li{line-height:1.55}.text{white-space:pre-wrap}.changed{background:#fff3c4;padding:2px 4px;border-radius:4px}
    code{display:block;overflow-wrap:anywhere;font-size:11px;color:#607086;margin-top:10px}
    .checks{columns:2;list-style:none;padding:0}.checks li{break-inside:avoid;margin:7px 0}
    .pass{color:#176b37}.fail{color:#a52a22}
    details{background:#fff;border:1px solid #dce3ee;border-radius:12px;padding:14px;margin-top:12px}
    @media(max-width:850px){.grid,.image-pair{grid-template-columns:1fr}.arrow{transform:rotate(90deg)}.checks{columns:1}}
  </style>
</head>
<body><main class="page">
  <h1>${escapeHtml(verification.listing.sku)} · фактическое ДО → ПОСЛЕ</h1>
  <div class="meta">Walmart item ${escapeHtml(verification.listing.item_id)} · feed ${escapeHtml(verification.feed_id)} · live reread ${escapeHtml(verification.after.captured_at)}</div>
  <div class="status"><strong>LIVE SURFACE PASS</strong><br>${escapeHtml(statusCopy)}</div>

  <section class="section">
    <h2>Изображения</h2>
    ${cards}
  </section>

  <section class="section">
    <h2>Title</h2>
    <div class="grid">
      <div class="panel before"><div class="label">ДО</div><div class="text">${escapeHtml(beforeProduct.title)}</div></div>
      <div class="panel after"><div class="label">ПОСЛЕ · без изменений</div><div class="text">${escapeHtml(afterProduct.title)}</div></div>
    </div>
  </section>

  <section class="section">
    <h2>Description</h2>
    <div class="grid">
      <div class="panel before"><div class="label">ДО</div><div class="text">${escapeHtml(beforeProduct.description)}</div></div>
      <div class="panel after"><div class="label">ПОСЛЕ</div><div class="text">${escapeHtml(afterProduct.description)}</div></div>
    </div>
  </section>

  <section class="section">
    <h2>Bullet points</h2>
    <div class="grid">
      <div class="panel before"><div class="label">ДО</div>${renderBullets(beforeProduct.feature_bullets)}</div>
      <div class="panel after"><div class="label">ПОСЛЕ</div>${renderBullets(afterProduct.feature_bullets)}</div>
    </div>
  </section>

  <section class="section">
    <h2>Проверки</h2>
    <div class="panel"><ul class="checks">${checks}</ul></div>
    <details><summary>Техническая оговорка</summary>
      Этот артефакт доказывает фактическую buyer-facing поверхность, exact target, неизменность image bytes,
      terminal feed и PUBLISHED/ACTIVE. Он не подменяет отдельный frozen sequence-gate Qualification receipt.
    </details>
  </section>
</main></body></html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [
    beforeIndex,
    afterIndex,
    beforePdp,
    afterPdp,
    beforeSeller,
    afterSeller,
    execution,
    feed,
    terminal,
    qualification,
  ] = await Promise.all([
    verifyIntake(args.before_dir),
    verifyIntake(args.after_dir),
    readJson(path.join(args.before_dir, "buyer-pdp.json")),
    readJson(path.join(args.after_dir, "buyer-pdp.json")),
    readJson(path.join(args.before_dir, "seller-item.json")),
    readJson(path.join(args.after_dir, "seller-item.json")),
    readJson(args.execution_package),
    readJson(args.feed_receipt),
    readJson(args.terminal_report),
    readJson(args.qualification_receipt),
  ]);
  const plan = execution.value?.execution?.writer_input?.plan;
  if (!plan || plan.schema_version !== "walmart-listing-integrity-repair-plan/v2") {
    fail("execution package has no exact repair plan");
  }
  const before = beforePdp.value.product;
  const after = afterPdp.value.product;
  if (!before || !after) fail("buyer PDP product payload is missing");
  const target = plan.target.surface;
  const beforeSellerRow = sellerRow(beforeSeller.value);
  const afterSellerRow = sellerRow(afterSeller.value);
  const beforeImages = imageRows(beforeIndex.value);
  const afterImages = imageRows(afterIndex.value);
  const targetImages = plan.target.images;
  const outerUnitsClaim = target.attribute_claims?.find(
    (claim) => claim.kind === "outer_units" && claim.unit === "count",
  );
  const outerUnits = outerUnitsClaim?.value;
  if (!Number.isSafeInteger(outerUnits) || outerUnits < 1) {
    fail("repair plan has no exact positive outer-unit count");
  }
  const packPrefix = new RegExp(`^PACK OF ${outerUnits}:`, "u");
  const qualificationResult = qualification.value?.qualification;
  const textOnly = exactArray(plan.changed_fields, ["description", "bullets"]);
  const reviewedMain = exactArray(plan.changed_fields, ["description", "bullets", "main"]);
  if (!textOnly && !reviewedMain) {
    fail(`unsupported approved diff for live gallery: ${JSON.stringify(plan.changed_fields)}`);
  }
  const mainUrlChangedAsApproved = reviewedMain
    ? before.main_image !== after.main_image
    : before.main_image === after.main_image;
  const galleryUrlsUnchanged = exactArray(before.images.slice(1), after.images.slice(1));
  const galleryBytesUnchanged =
    beforeImages.length === afterImages.length
    && beforeImages.slice(1).every(
      (row, index) => row.file_sha256 === afterImages[index + 1].file_sha256,
    );
  const mainBytesChangedAsApproved = reviewedMain
    ? beforeImages[0]?.file_sha256 !== afterImages[0]?.file_sha256
    : beforeImages[0]?.file_sha256 === afterImages[0]?.file_sha256;
  const targetGalleryUrls = targetImages.slice(1).map((row) => row.source_url);
  const targetGalleryBytes = targetImages.slice(1).map((row) => row.sha256);
  const checks = {
    feed_terminal_succeeded: feed.value.status === "SUCCEEDED" && terminal.value.status === "SUCCEEDED",
    frozen_qualification_pass:
      qualification.value.status === "PASS"
      && qualificationResult?.verdict === "PASS"
      && qualificationResult?.next_sku_unblocked === true
      && qualificationResult?.listing?.listing_key === plan.listing.listing_key
      && qualificationResult?.feed_id === feed.value.feed_id,
    exact_listing_identity:
      afterSellerRow.sku === plan.listing.sku
      && after.product_url?.endsWith(`/${plan.listing.item_id}`)
      && beforeSellerRow.sku === plan.listing.sku,
    published_and_active:
      afterSellerRow.publishedStatus === "PUBLISHED"
      && afterSellerRow.lifecycleStatus === "ACTIVE",
    title_exact_target: after.title === target.title,
    description_exact_target: after.description === target.description,
    bullets_exact_target: exactArray(after.feature_bullets, target.bullets),
    title_unchanged: before.title === after.title,
    main_url_changed_only_if_approved: mainUrlChangedAsApproved,
    main_bytes_changed_only_if_approved: mainBytesChangedAsApproved,
    main_semantic_qualification_pass: qualificationResult?.facets?.main === "PASS",
    gallery_urls_unchanged: galleryUrlsUnchanged,
    gallery_bytes_unchanged: galleryBytesUnchanged,
    gallery_urls_exact_target:
      exactArray(after.images.slice(1), targetGalleryUrls),
    gallery_bytes_exact_target:
      exactArray(afterImages.slice(1).map((row) => row.file_sha256), targetGalleryBytes),
    description_changed: before.description !== after.description,
    bullets_changed: !exactArray(before.feature_bullets, after.feature_bullets),
    only_approved_fields_changed:
      (textOnly || reviewedMain)
      && before.title === after.title
      && galleryUrlsUnchanged
      && galleryBytesUnchanged
      && mainUrlChangedAsApproved
      && mainBytesChangedAsApproved,
    quantity_explicit_in_description: packPrefix.test(after.description),
    quantity_explicit_in_bullets:
      after.feature_bullets.some((row) => packPrefix.test(row)),
  };
  const passed = Object.values(checks).every(Boolean);
  if (!passed) fail(`live canary verification failed: ${JSON.stringify(checks)}`);
  const verificationBody = {
    schema_version: "walmart-listing-integrity-live-canary-verification/v1",
    status: "LIVE_SURFACE_PASS",
    listing: {
      listing_key: plan.listing.listing_key,
      sku: plan.listing.sku,
      item_id: plan.listing.item_id,
      store_index: plan.listing.store_index,
    },
    feed_id: feed.value.feed_id,
    exact_payload_sha256: feed.value.execution_package_body_sha256
      ? execution.value.execution.writer_input.one_sku_permit.signed_body.request_payload_sha256
      : null,
    execution_package_file_sha256: execution.file_sha256,
    terminal_feed_receipt_file_sha256: feed.file_sha256,
    terminal_report_file_sha256: terminal.file_sha256,
    qualification_receipt_file_sha256: qualification.file_sha256,
    before: {
      captured_at: beforeIndex.value.created_at,
      intake_index_file_sha256: beforeIndex.file_sha256,
      intake_index_body_sha256: beforeIndex.value.body_sha256,
      buyer_pdp_file_sha256: beforePdp.file_sha256,
      image_sha256: beforeImages.map((row) => row.file_sha256),
    },
    after: {
      captured_at: afterIndex.value.created_at,
      intake_index_file_sha256: afterIndex.file_sha256,
      intake_index_body_sha256: afterIndex.value.body_sha256,
      buyer_pdp_file_sha256: afterPdp.file_sha256,
      image_sha256: afterImages.map((row) => row.file_sha256),
    },
    plan: {
      plan_id: plan.plan_id,
      plan_body_sha256: plan.body_sha256,
      target_sha256: plan.target.target_sha256,
      changed_fields: plan.changed_fields,
    },
    checks,
    qualification_boundary: {
      buyer_facing_live_surface_verified: true,
      frozen_sequence_gate_receipt_emitted: true,
      next_sku_unblocked: true,
    },
  };
  const verification = { ...verificationBody, body_sha256: bodySha(verificationBody) };
  await mkdir(args.output_dir, { recursive: false, mode: 0o700 });
  const jsonPath = path.join(args.output_dir, "live-canary-verification.json");
  const htmlPath = path.join(args.output_dir, "before-after-gallery.html");
  await writeFile(jsonPath, `${JSON.stringify(verification, null, 2)}\n`, { flag: "wx", mode: 0o400 });
  await writeFile(htmlPath, renderHtml(verification, beforePdp.value, afterPdp.value, plan), { flag: "wx", mode: 0o400 });
  process.stdout.write(`${JSON.stringify({
    status: verification.status,
    verdict: "PASS",
    json_path: jsonPath,
    html_path: htmlPath,
    body_sha256: verification.body_sha256,
    checks: Object.keys(checks).length,
    next_sku_unblocked: true,
  }, null, 2)}\n`);
}

await main();
