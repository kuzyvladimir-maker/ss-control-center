// BATCH-200 АВТОНОМНЫЙ КОНВЕЙЕР (owner 2026-08-11: «чтобы мне уже в этот чат
// не обращаться … добил бы все 200»).
//
// Один проход = один слаг из очереди:
//   рендер (GPT Image 2 + якорь) → QA-офицер (3 голоса, $0 на подписке)
//   → провал: ре-ролл до MAX_ATTEMPTS
//   → успех: main в базу → галерея 8 слотов → пруф → submit на Amazon.
//
// Скрипт держит состояние в data/batch200/auto-state.json, поэтому его можно
// убивать и перезапускать — он продолжит с того же места. Именно это и делает
// крон-сторож.
//
// Env: LIMIT=n (сколько слагов обработать за запуск, по умолчанию все)
//      MAX_ATTEMPTS=3
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { nextUncrustablesQualityAttempt } from "../src/lib/bundle-factory/uncrustables-auto-attempt-policy";

const STATE = "data/batch200/auto-state.json";
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 3);

type State = {
  done: string[];        // опубликованы
  failed: string[];      // исчерпали попытки
  attempts: Record<string, number>;
};

type BatchRecipeComponent = {
  flavor: string;
  qty: number;
  box_size: number;
  box_count: number;
  donor_title: string;
};

type BatchRecipe = {
  slug: string;
  comps: BatchRecipeComponent[];
};

type StagedSku = {
  slug: string;
  sku: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadState(): State {
  if (!existsSync(STATE)) return { done: [], failed: [], attempts: {} };
  try { return JSON.parse(readFileSync(STATE, "utf8")); }
  catch { return { done: [], failed: [], attempts: {} }; }
}
function saveState(s: State) { writeFileSync(STATE, JSON.stringify(s, null, 1)); }

function sh(cmd: string, args: string[], env: Record<string, string>) {
  return execFileSync(cmd, args, {
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 900_000,
  });
}

async function main() {
  const LIMIT = Number(process.env.LIMIT ?? 9999);
  const state = loadState();

  const p = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const sr = await import("../src/lib/bundle-factory/uncrustables-studio-run");
  const rr = await import("../src/lib/bundle-factory/uncrustables-render-runner");
  const qa = await import("../src/lib/bundle-factory/audit/frozen-main-qa");
  const bp = await import("../src/lib/bundle-factory/uncrustables-box-planner");

  const recipes = JSON.parse(readFileSync("data/batch200/recipes.json", "utf8")) as BatchRecipe[];
  const staged = JSON.parse(readFileSync("data/batch200/staged.json", "utf8")) as StagedSku[];
  const stagedBy = new Map(staged.map((r) => [r.slug, r]));

  // уже опубликованные — из базы (источник истины), а не только из state
  const publishedSkus = await prisma.channelSKU.findMany({
    where: { submission_id: { not: null } },
    select: { sku: true },
  });
  const pubSet = new Set(publishedSkus.map((r) => r.sku));
  for (const r of staged) if (pubSet.has(r.sku) && !state.done.includes(r.slug)) state.done.push(r.slug);

  const queue = recipes
    .map((r) => r.slug)
    .filter((s) => !state.done.includes(s) && !state.failed.includes(s))
    .slice(0, LIMIT);
  console.log(`[auto] опубликовано ${state.done.length} | в очереди ${queue.length} | брак ${state.failed.length}`);
  if (!queue.length) { console.log("ALL-DONE"); await prisma.$disconnect(); process.exit(0); }

  const donors = await sr.loadUncrustablesDonorPool();

  for (const slug of queue) {
    const recipe = recipes.find((r) => r.slug === slug);
    // attempts = QA-evaluated image candidates, not infrastructure calls.
    // WORKER_*, postcheck failures and unavailable vision did not produce a
    // quality verdict and therefore must not consume the finite reroll budget.
    const attempt = (state.attempts[slug] ?? 0) + 1;
    console.log(`\n[auto] ${slug} — попытка ${attempt}/${MAX_ATTEMPTS}`);

    // ---- 1. рендер
    const { errors, plan } = sr.planStudioRecipe(recipe.comps, donors);
    if (errors.length || !plan) { console.log(`  ✗ plan: ${errors.join("; ")}`); state.failed.push(slug); saveState(state); continue; }
    let prompt: string, referenceUrls: string[];
    try {
      const built = sr.buildStudioCandidatePrompt({ title: plan.title, recipe: plan.recipe });
      prompt = built.prompt; referenceUrls = built.referenceUrls;
    } catch (error: unknown) { console.log(`  ✗ prompt: ${errorMessage(error).slice(0, 120)}`); state.failed.push(slug); saveState(state); continue; }

    const res = await rr.renderUncrustablesMainCandidate({ slug, prompt, referenceUrls, r2Prefix: "b2" }, {});
    if (!res.ok) {
      console.log(`  ↻ технический сбой render ${res.code}; попытка не списана`);
      continue;
    }
    console.log(`  ✓ render ${res.imageSha256.slice(0, 12)}…`);

    // ---- 2. QA-офицер
    const comps = plan.recipe.comps.map((c) => ({
      label: bp.UNCRUSTABLES_FLAVORS[c.flavor]?.frontPanelText ?? c.flavor,
      boxes: c.box_count,
      boxSize: c.box_size,
    }));
    let verdict: Awaited<ReturnType<typeof qa.qaFrozenMainImage>>;
    try {
      verdict = await qa.qaFrozenMainImage({ image_url: res.imageUrl, comps });
    } catch (error: unknown) {
      console.log(`  ↻ технический сбой QA: ${errorMessage(error).slice(0, 160)}; попытка не списана`);
      continue;
    }
    if (!verdict.verified) {
      console.log(`  ↻ QA недоступен: ${verdict.hard_fails.slice(0, 2).join(" | ").slice(0, 160)}; попытка не списана`);
      continue;
    }
    state.attempts[slug] = nextUncrustablesQualityAttempt(
      state.attempts[slug] ?? 0,
      { stage: "QA", verified: true, passed: Boolean(verdict.pass) },
    );
    saveState(state);
    if (!verdict.pass) {
      console.log(`  ✗ QA: ${verdict.hard_fails.slice(0, 3).join(" | ").slice(0, 200)}`);
      if (attempt >= MAX_ATTEMPTS) { state.failed.push(slug); console.log("  → исчерпаны попытки"); }
      saveState(state); continue;
    }
    console.log(`  ✓ QA пройден`);

    // ---- 3. волна для последующих шагов
    const waveFile = `data/batch200/waves/auto-${slug.slice(0, 40)}.json`;
    writeFileSync(waveFile, JSON.stringify([{
      slug, total: plan.pack_count, title: plan.title, bullets: plan.bullets,
      description: plan.description,
      comps: plan.recipe.comps.map((c) => ({
        flavor: c.flavor, qty: c.qty, box_size: c.box_size,
        box_count: c.box_count, donor_title: c.donor_title,
      })),
      price: plan.price_cents / 100, cost_cents: plan.cost_cents,
      cooler: plan.recipe.cooler, prompt, referenceUrls,
      main_image_url: res.imageUrl, image_sha256: res.imageSha256,
    }], null, 1));
    const waveName = waveFile.split("/").pop() as string;

    // ---- 4. main в базу → галерея → публикация
    if (!stagedBy.has(slug)) { console.log("  ✗ нет застейдженного SKU"); state.failed.push(slug); saveState(state); continue; }
    try {
      sh("npx", ["tsx", "scripts/_b2_setmain.ts"], { WAVES: waveName, SLUGS: slug });
      sh("npx", ["tsx", "scripts/_b2_gallery.ts"], { SLUGS: slug });
      const out = sh("npx", ["tsx", "scripts/_b2_publish.ts"], { WAVES: waveName, SLUGS: slug });
      if (/→ OK \| amazon ACCEPTED/.test(out)) {
        state.done.push(slug);
        console.log(`  ✓ ОПУБЛИКОВАН (всего ${state.done.length})`);
      } else {
        const err = out.split("\n").find((l) => /✗|FAIL/.test(l)) ?? "unknown";
        console.log(`  ✗ publish: ${err.slice(0, 180)}`);
      }
    } catch (error: unknown) {
      console.log(`  ✗ pipeline: ${errorMessage(error).slice(0, 200)}`);
    }
    saveState(state);
  }

  console.log(`\n[auto] итог: опубликовано ${state.done.length} | брак ${state.failed.length}`);
  await prisma.$disconnect();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
