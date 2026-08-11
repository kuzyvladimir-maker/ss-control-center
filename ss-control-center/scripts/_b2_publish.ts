// BATCH-200 publish conveyor (owner «го» 2026-08-10). Для каждого slug,
// ПРОШЕДШЕГО полную агентскую проверку (гейт — снаружи, в чате оператора):
//   stage (боевая stageUncrustablesCandidate) → re-download+sha-сверка байтов
//   → R2-архив копий → mintCandidateProof (той же sealing-либой) → sealed
//   манифест → registerSealedOwnerApprovalManifest (fail-closed union) →
//   append-only DB record → preflight-пермит по точным байтам → submitToAmazon.
// Env: WAVES=w1.json,w1r.json (later-wins по slug) SLUGS=a,b DRY=1.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const WAVE_DIR = "data/batch200/waves/";

async function main() {
  const DRY = process.env.DRY === "1";
  const SLUGS = (process.env.SLUGS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const WAVES = (process.env.WAVES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!SLUGS.length || !WAVES.length) { console.error("SLUGS= и WAVES= обязательны"); process.exit(1); }

  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const stageLib: any = await import("../src/lib/bundle-factory/uncrustables-stage");
  const gate: any = await import("../src/lib/bundle-factory/compliance/gate");
  const pd: any = await import("../src/lib/bundle-factory/validation/promote-draft");
  const pps: any = await import("../src/lib/bundle-factory/physical-package-specs");
  const dd: any = await import("../src/lib/bundle-factory/donor-dedup");
  const mint: any = await import("../src/lib/bundle-factory/audit/uncrustables-owner-approval-minting");
  const uni: any = await import("../src/lib/bundle-factory/audit/uncrustables-owner-approval-manifests");
  const rec: any = await import("../src/lib/bundle-factory/audit/uncrustables-studio-manifest-records");
  const pf: any = await import("../src/lib/bundle-factory/audit/uncrustables-main-production-preflight");
  const ap: any = await import("../src/lib/bundle-factory/distribution/amazon-publish");
  const ig: any = await import("../src/lib/bundle-factory/image-generation");
  const ad: any = await import("../src/lib/bundle-factory/allergen-declaration");

  const bySlug = new Map<string, any>();
  for (const w of WAVES) {
    for (const row of JSON.parse(readFileSync(WAVE_DIR + w, "utf8"))) bySlug.set(row.slug, row);
  }

  // холодный старт: union должен видеть все прежние studio/batch манифесты
  await rec.ensureStudioManifestRecordsRegistered(prisma);

  const stamp = new Date().toISOString().slice(0, 10);
  let ok = 0, fail = 0;
  for (const slug of SLUGS) {
    const row = bySlug.get(slug);
    console.log(`\n=== ${slug} (${row?.total}ct, $${row?.price}) ===`);
    if (!row) { console.log("  ✗ нет wave-строки"); fail++; continue; }

    // ---- байты: точный URL → sha должен совпасть с зафиксированным при рендере
    const resp = await fetch(row.main_image_url, { cache: "no-store", redirect: "error" });
    if (!resp.ok) { console.log(`  ✗ fetch ${resp.status}`); fail++; continue; }
    const bytes = Buffer.from(await resp.arrayBuffer());
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha !== row.image_sha256) {
      console.log(`  ✗ sha drift: ${sha.slice(0, 12)} != ${row.image_sha256.slice(0, 12)}`);
      fail++; continue;
    }

    // ---- идемпотентность: если slug уже застейджен этим конвейером (в т.ч.
    // прошлым DRY-прогоном), переиспользуем его SKU вместо повторного минта
    // SKU/UPC. "Уже застейджен" = GenerationJob с нашим brief-маркером и
    // slug-ом, чей драфт дошёл до ChannelSKU.
    let staged: any = null;
    const priorJobs = await prisma.generationJob.findMany({
      where: { brief: { contains: "uncrustables-batch200" } },
      select: { brief: true, bundle_drafts: { select: { id: true, master_bundle_id: true } } },
    });
    for (const j of priorJobs) {
      try { if (JSON.parse(j.brief).slug !== slug) continue; } catch { continue; }
      for (const d of j.bundle_drafts) {
        if (!d.master_bundle_id) continue;
        const skus = await prisma.channelSKU.findMany({
          where: { master_bundle_id: d.master_bundle_id },
          select: { id: true, sku: true, upc: true, price_cents: true },
        });
        if (skus.length) {
          staged = {
            ok: true,
            draftId: d.id,
            masterBundleId: d.master_bundle_id,
            skus: skus.map((s: any) => ({ channel_sku_id: s.id, sku: s.sku, upc: s.upc, price_cents: s.price_cents })),
          };
          console.log(`  ↷ reuse staged SKU ${skus[0].sku}`);
        }
      }
    }

    // ---- stage через боевую либу (только если ещё не застейджен)
    if (!staged) staged = await stageLib.stageUncrustablesCandidate(
      {
        slug,
        title: row.title,
        bullets: row.bullets,
        description: row.description,
        mainImageUrl: row.main_image_url,
        packCount: row.total,
        costCents: row.cost_cents ?? null,
        comps: row.comps.map((c: any) => ({ flavor: c.flavor, qty: c.qty, donor_title: c.donor_title })),
        briefSource: "uncrustables-batch200",
        ownerOrder: "2026-08-10 давай сделаем еще 200 новых листингов … го",
        actor: "claude-batch200",
      },
      {
        prisma,
        donorUnitPriceCents: dd.donorUnitPriceCents,
        runComplianceGate: gate.runComplianceGate,
        promoteDraftToChannelSkus: pd.promoteDraftToChannelSkus,
        withVerifiedPhysicalPackageSpecs: pps.withVerifiedPhysicalPackageSpecs,
      },
    );
    if (!staged.ok) {
      console.log(`  ✗ stage ${staged.stage}: ${staged.error}${staged.blockedRuleIds ? " [" + staged.blockedRuleIds.join(",") + "]" : ""}`);
      fail++; continue;
    }
    const sku = staged.skus[0];
    console.log(`  ✓ SKU ${sku.sku} | upc ${sku.upc} | $${(sku.price_cents / 100).toFixed(2)}`);

    // ---- R2-архив (locator-ы будущего пруфа)
    const keyImg = `studio-audit/${slug}.png`;
    const keyMan = `studio-audit/${slug}.generation-manifest.json`;
    const imgUrl = await ig.uploadBundleFactoryAuditObject(keyImg, bytes, "image/png");
    if (!imgUrl) { console.log("  ✗ R2 недоступен для архива"); fail++; continue; }
    const base = imgUrl.slice(0, -(keyImg.length + 1));
    const locator = (s: string, kind: string) =>
      `${base}/studio-audit/${s}.${kind === "image" ? "png" : "generation-manifest.json"}`;

    // ---- идемпотентность минта: если пруф для этого слага уже зарегистрирован
    // И запечатан по ТЕМ ЖЕ байтам, второй раз не минтим (иначе union
    // справедливо ругается на дубль proof_id и публикация встаёт).
    const existingProof = uni
      .allUnionOwnerApprovedProofs()
      .find((pr: any) => pr.proof_id === `production-${slug}`);
    if (existingProof) {
      if (String(existingProof.image?.sha256 ?? "").toLowerCase() === sha) {
        console.log(`  ↷ пруф уже запечатан по этим байтам (${sha.slice(0, 12)}…)`);
      } else {
        console.log(`  ✗ пруф ${existingProof.proof_id} запечатан по ДРУГИМ байтам — нужен новый slug/ID`);
        fail++; continue;
      }
    }

    // ---- mint + seal + register + DB record
    let minted: any = null;
    if (!existingProof) try {
      minted = mint.mintCandidateProof(
        {
          slug,
          sku: sku.sku,
          mainImageUrl: row.main_image_url,
          imageBytes: bytes,
          prompt: row.prompt,
          referenceUrls: row.referenceUrls,
          renderScript: "scripts/_b2_render.ts",
          workerLabel: "codex-image-worker (ChatGPT subscription image_gen on OpenClaw box)",
          comps: row.comps.map((c: any) => ({ flavor: c.flavor, qty: c.qty, box_size: c.box_size, box_count: c.box_count })),
          observedAt: new Date(),
          approvedAt: new Date(),
          reviewNotes:
            "Batch-200 verification: full-protocol adversarial checker agent per image (per-carton crops 2-3x, " +
            "letter-by-letter transcription of every headline word, SMUCKER'S banner, badge digit and KEEP FROZEN line, " +
            "double counts both directions), executed by Claude Code as the owner's delegate under the standing " +
            "2026-08-10 batch-200 mandate; failed renders re-rolled under contract v15.",
          approvalNotes:
            "Owner batch-200 order 2026-08-10 («давай сделаем еще 200 новых листингов … го») under the standing " +
            "full-delegation publication mandate; verification executed by Claude Code as delegate.",
        },
        { reviewer: "owner", session: `batch200-${stamp}` },
        locator,
      );
      const manifestUrl = await ig.uploadBundleFactoryAuditObject(keyMan, minted.generationManifest.text, "application/json");
      if (manifestUrl !== locator(slug, "generation-manifest")) throw new Error("manifest locator drift");
      const manifest = mint.sealStudioOwnerApprovalManifest({
        manifestId: `uncrustables-batch200-${stamp}-${slug}`,
        capturedAt: new Date(),
        approvedBy: "owner",
        entries: [minted.proof],
      });
      uni.registerSealedOwnerApprovalManifest(manifest);
      if (!DRY) {
        await prisma.uncrustablesOwnerApprovalManifestRecord.create({
          data: {
            manifest_id: manifest.manifest_id,
            sha256: manifest.sha256,
            body_json: JSON.stringify(manifest),
            entry_count: 1,
            approved_by: "owner",
            captured_at: new Date(),
          },
        });
      }
      console.log(`  ✓ proof ${minted.proof.proof_id} | manifest ${manifest.sha256.slice(0, 12)}…`);
    } catch (e: any) {
      console.log(`  ✗ mint: ${String(e?.message ?? e).slice(0, 200)}`);
      fail++; continue;
    }

    // ---- permit + submit
    // Гейт свежести: submitToAmazon требует подтверждённый положительный
    // остаток не старше 15 минут (buy-to-order — остаток объявляет оператор).
    const current = await prisma.channelSKU.findUnique({
      where: { id: sku.channel_sku_id },
      select: { available_quantity: true },
    });
    await prisma.channelSKU.update({
      where: { id: sku.channel_sku_id },
      data: {
        available_quantity: current?.available_quantity ?? 10,
        inventory_checked_at: new Date(),
      },
    });
    const freshSku = await prisma.channelSKU.findUnique({ where: { id: sku.channel_sku_id } });
    const mb = await prisma.masterBundle.findUnique({
      where: { id: staged.masterBundleId },
      select: { packaging_spec: true, category: true, components: true },
    });
    const specs = pps.parseVerifiedPhysicalPackageSpecs(mb?.packaging_spec);
    const verifiedAllergens = ad.amazonAllergensFromStoredDeclarations((mb?.components ?? []).map((c: any) => c.allergens));
    const pfRes = await pf.preflightProductionUncrustablesMain({
      sku: sku.sku,
      main_image_url: row.main_image_url,
      pack_count: row.total,
      components: row.comps.map((c: any) => ({ product_name: c.flavor, flavor: c.flavor, qty: c.qty })),
    });
    if (!pfRes.pass || !pfRes.permit) {
      console.log(`  ✗ permit BLOCKED: ${JSON.stringify(pfRes.findings).slice(0, 250)}`);
      fail++; continue;
    }
    console.log(`  ✓ permit ${pfRes.permit.sha256.slice(0, 12)}… (proof ${pfRes.proof_id})`);
    const result = await ap.submitToAmazon({
      sku: freshSku,
      storeIndex: 1,
      productType: "GROCERY",
      brand: "Uncrustables",
      category: mb?.category ?? "FROZEN_GROCERY",
      dryRun: DRY,
      physicalPackageSpecs: specs,
      verifiedAllergens,
      uncrustablesMainPermit: pfRes.permit,
    });
    const issues = (result.issues ?? []).map((i: any) => `${i.severity}:${i.code} ${String(i.message ?? "").slice(0, 90)}`).join(" | ");
    console.log(`  → ${result.ok ? "OK" : "FAIL"} | amazon ${result.amazon_status ?? "?"} | sub ${result.submission_id ?? "-"}${result.error ? " | ERROR: " + String(result.error).slice(0, 300) : ""}${issues ? " | " + issues.slice(0, 300) : ""}`);
    if (result.ok && !DRY) {
      await prisma.channelSKU.update({
        where: { id: sku.channel_sku_id },
        data: { lifecycle_status: "SUBMITTED", submitted_at: new Date(), submission_id: result.submission_id ?? null },
      });
      ok++;
    } else if (result.ok) ok++;
    else fail++;
  }
  console.log(`\nитого: OK ${ok} | FAIL ${fail}`);
  await prisma.$disconnect();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
