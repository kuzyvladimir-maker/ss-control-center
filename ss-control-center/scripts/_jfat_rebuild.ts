// Одноразовый ремонт картинок листинга SZ-ASPI-JFAT / B0H776M5B5
// (Uncrustables Blackberry Boom, 6 коробок × 4 = 24). Amazon отклонил июльскую
// MAIN (issue 18320: картинка показывала 4 коробки вместо 6 — нарушение канона
// «коробки × printed count = qty»). Прогон по frozen v2.0:
//   STEP=plan    — сухой план: рецепт, донор, референсы, промпт (без рендера)
//   STEP=render  — GPT Image 2 + якорь кулера → frozen QA (3 голоса), до MAX_ATTEMPTS
//   STEP=gallery — донорские фото → R2 → слоты 2..8 (слот 1 = brand card)
//   STEP=patch   — surgical PATCH только image-locator'ов (VALIDATION_PREVIEW → PATCH)
// Состояние: data/jfat-rebuild/state.json
import "./_env";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const SKU = "SZ-ASPI-JFAT";
const ASIN = "B0H776M5B5";
const SELLER = "A3A7A0RDFUSGBS";
const MP = "ATVPDKIKX0DER";
const STATE = "data/jfat-rebuild/state.json";
const COMPS = [{ flavor: "Peanut Butter & Blackberry Spread", qty: 24, cartonSize: 4 }];
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 3);

type State = { attempts: any[]; approved?: { url: string; sha256: string; verdict: any }; gallery?: string[]; patch?: any };
const load = (): State => existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { attempts: [] };
const save = (s: State) => writeFileSync(STATE, JSON.stringify(s, null, 1));

async function main() {
  const STEP = process.env.STEP ?? "plan";
  const state = load();
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const sr: any = await import("../src/lib/bundle-factory/uncrustables-studio-run");
  const bp: any = await import("../src/lib/bundle-factory/uncrustables-box-planner");

  const donors = await sr.loadUncrustablesDonorPool();
  const { errors, plan } = sr.planStudioRecipe(COMPS, donors);
  if (errors.length || !plan) { console.log("✗ plan:", errors.join("; ")); process.exit(1); }
  const built = sr.buildStudioCandidatePrompt({ title: plan.title, recipe: plan.recipe });
  console.log("план:", plan.pack_count, "шт |", plan.recipe.comps.map((c: any) => `${c.flavor} ×${c.qty} (${c.box_count}×${c.box_size}) донор="${c.donor_title}"`).join("; "));
  console.log("title (планировщик):", plan.title);
  console.log("референсы:", built.referenceUrls.length, built.referenceUrls.map((u: string) => u.slice(-60)).join(" | "));

  if (STEP === "plan") {
    console.log("\n--- PROMPT ---\n" + built.prompt);
    await prisma.$disconnect(); return;
  }

  if (STEP === "render") {
    const rr: any = await import("../src/lib/bundle-factory/uncrustables-render-runner");
    const qa: any = await import("../src/lib/bundle-factory/audit/frozen-main-qa");
    const qaComps = plan.recipe.comps.map((c: any) => ({
      label: bp.UNCRUSTABLES_FLAVORS[c.flavor]?.frontPanelText ?? c.flavor, boxes: c.box_count, boxSize: c.box_size,
    }));
    let quality = state.attempts.filter((a) => a.verified).length;
    while (!state.approved && quality < MAX_ATTEMPTS) {
      const t0 = Date.now();
      const res = await rr.renderUncrustablesMainCandidate(
        { slug: `${SKU.toLowerCase()}-${Date.now()}`, prompt: built.prompt, referenceUrls: built.referenceUrls, r2Prefix: "jfat" }, {});
      if (!res.ok) { console.log(`↻ render ${res.code}: ${res.error.slice(0, 160)}`); state.attempts.push({ ok: false, code: res.code }); save(state); continue; }
      console.log(`✓ render ${Math.round((Date.now() - t0) / 1000)}s ${res.pixelDimensions.width}x${res.pixelDimensions.height} → ${res.imageUrl}`);
      let verdict: any;
      try { verdict = await qa.qaFrozenMainImage({ image_url: res.imageUrl, comps: qaComps }); }
      catch (e: any) { console.log("↻ QA сбой:", String(e?.message ?? e).slice(0, 160)); state.attempts.push({ ok: true, url: res.imageUrl, sha256: res.imageSha256, verified: false }); save(state); continue; }
      state.attempts.push({ ok: true, url: res.imageUrl, sha256: res.imageSha256, verified: verdict.verified, pass: verdict.pass, hard_fails: verdict.hard_fails, warnings: verdict.warnings, observed: verdict.observed });
      if (!verdict.verified) { console.log("↻ QA недоступен:", verdict.hard_fails.join(" | ").slice(0, 200)); save(state); continue; }
      quality++;
      if (verdict.pass) { state.approved = { url: res.imageUrl, sha256: res.imageSha256, verdict }; console.log("✓ QA ПРОЙДЕН", JSON.stringify(verdict.observed)); }
      else console.log(`✗ QA (${quality}/${MAX_ATTEMPTS}):`, verdict.hard_fails.join(" | ").slice(0, 300));
      save(state);
    }
    if (!state.approved) console.log("✗ ни одна картинка не прошла QA");
    await prisma.$disconnect(); return;
  }

  if (STEP === "gallery") {
    const gi: any = await import("../src/lib/bundle-factory/attributes/gallery-images");
    const comp = plan.recipe.comps[0];
    const d = await prisma.donorProduct.findFirst({ where: { title: comp.donor_title }, select: { title: true, mainImageUrl: true, imageUrls: true } });
    let imgs: string[] = []; try { imgs = JSON.parse(String(d?.imageUrls ?? "[]")); } catch {}
    const all = [...new Set([d?.mainImageUrl, ...imgs].filter(Boolean))] as string[];
    console.log(`донор "${d?.title}": ${all.length} фото`); all.forEach((u, i) => console.log(`  [${i}] ${u}`));
    if (process.env.DRY === "1") { await prisma.$disconnect(); return; }
    const pick = process.env.PICK ? process.env.PICK.split(",").map(Number).map((i) => all[i]).filter(Boolean) : all;
    const mirrored: string[] = await gi.mirrorDonorGallery(SKU, pick);
    console.log(`зеркало R2: ${mirrored.length}`); mirrored.forEach((u) => console.log("  " + u));
    state.gallery = mirrored; save(state);
    await prisma.$disconnect(); return;
  }

  if (STEP === "patch") {
    if (!state.approved) { console.log("✗ нет одобренной MAIN"); process.exit(1); }
    const ba: any = await import("../src/lib/bundle-factory/attributes/brand-assets");
    const li: any = await import("../src/lib/amazon-sp-api/listings");
    const loc = (url: string) => [{ media_location: url, language_tag: "en_US", marketplace_id: MP }];
    const attrs: Record<string, any> = { main_product_image_locator: loc(state.approved.url), other_product_image_locator_1: loc(ba.BRAND_CARD_COLD_CHAIN_URL) };
    (state.gallery ?? []).slice(0, 7).forEach((u, i) => { attrs[`other_product_image_locator_${i + 2}`] = loc(u); });
    const patches = Object.entries(attrs).map(([k, v]) => ({ op: "replace", path: `/attributes/${k}`, value: v }));
    console.log("патч:", patches.map((x) => x.path.replace("/attributes/", "")).join(", "));
    const live: any = await li.getListing(1, SELLER, SKU, { includedData: ["summaries"] });
    const pt = live.summaries?.[0]?.productType; const asin = live.summaries?.[0]?.asin;
    if (asin !== ASIN) { console.log(`✗ ASIN на Amazon ${asin} != ${ASIN}`); process.exit(1); }
    const prev = await li.patchListing(1, SELLER, SKU, pt, patches, { validationPreview: true });
    console.log("VALIDATION_PREVIEW:", prev.status, JSON.stringify(prev.issues ?? []).slice(0, 600));
    if (!["ACCEPTED", "VALID"].includes(prev.status) || process.env.DRY === "1") { await prisma.$disconnect(); return; }
    const res = await li.patchListing(1, SELLER, SKU, pt, patches, { retries: 1 });
    console.log("PATCH:", res.status, res.submissionId, JSON.stringify(res.issues ?? []).slice(0, 600));
    state.patch = { at: new Date().toISOString(), status: res.status, submissionId: res.submissionId, attrs }; save(state);
    if (res.status === "ACCEPTED") {
      const row = await prisma.channelSKU.findUnique({ where: { id: "cmr1ob5pw000104ldkx6d0335" }, select: { attributes: true, master_bundle_id: true } });
      const merged = { ...JSON.parse(row?.attributes || "{}"), ...attrs };
      await prisma.channelSKU.update({ where: { id: "cmr1ob5pw000104ldkx6d0335" }, data: { main_image_url: state.approved.url, attributes: JSON.stringify(merged) } });
      await prisma.masterBundle.update({ where: { id: row!.master_bundle_id }, data: { main_image_url: state.approved.url, secondary_images: JSON.stringify([ba.BRAND_CARD_COLD_CHAIN_URL, ...(state.gallery ?? [])]) } }).catch(() => {});
      console.log("✓ БД обновлена");
    }
    await prisma.$disconnect(); return;
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
