// Composite image REPLACEMENT + FINISH driver (Vladimir 2026-07-08).
//
// Runs the "гонка на замену": for every own-brand Uncrustables cold draft in a
// job, rebuild the MAIN image as a real-photo composite (IP-safe) vetted by the
// QA officer, then get it onto Amazon:
//   • REPLACE mode  — draft already has a live/submitted SKU → update the SKU's
//     main_image_url and re-PUT with republish=true (PUT is create-or-replace,
//     so the new real-photo main image overwrites the old AI one).
//   • FINISH mode   — draft not yet published → promote → validate → distribute.
//
// The QA officer gates every image: a draft whose composite fails QA after the
// photo-offset retries is SKIPPED (never publishes a rejected image) and logged.
//
// Resilient like _finisher.ts: per-draft try/catch, skip-set (never loops on a
// bad draft), transient DB/box-queue blips tolerated, fuse on repeated infra.
//
// Env: BF_JOBS=comma,separated,jobIds  (default: pilot + wave-2)
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });

const PILOT = "cmra8yv2k000010fzbuhf8wl9";
const WAVE2 = "cmrbdh4dm0000zhfzhtijm97m";

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { runImageGeneration } = await import("@/lib/bundle-factory/image-pipeline");
  const { compositeEligible } = await import("@/lib/bundle-factory/composite-image");
  const { isColdCategory } = await import("@/lib/bundle-factory/image-pipeline");
  const { promoteDraftToChannelSkus } = await import("@/lib/bundle-factory/validation/promote-draft");
  const { runValidationForDraft } = await import("@/lib/bundle-factory/validation/validation-pipeline");
  const { runDistribution } = await import("@/lib/bundle-factory/distribution/distribution-pipeline");

  const jobs = (process.env.BF_JOBS || `${PILOT},${WAVE2}`).split(",").map((s) => s.trim()).filter(Boolean);
  const LIMIT = process.env.BF_LIMIT ? parseInt(process.env.BF_LIMIT, 10) : Infinity;
  const ONLY = process.env.BF_ONLY_DRAFT || ""; // process exactly one draft id
  const APPLY = process.env.BF_DRY !== "1"; // BF_DRY=1 → dry run (no Amazon PUT), inspect payload only
  const ONLY_BLOCKED = process.env.BF_ONLY_BLOCKED === "1"; // re-run: skip drafts already on a good composite
  const say = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
  const skip = new Set<string>();
  let infraStreak = 0, replaced = 0, finished = 0, blocked = 0, done = 0;

  say("img-replace start | jobs:", jobs.join(", "));

  for (const JOB of jobs) {
    const drafts = await prisma.bundleDraft.findMany({
      where: { generation_job_id: JOB },
      select: {
        id: true, draft_name: true, brand: true, category: true, master_bundle_id: true, status: true,
        variation_matrix: { select: { selected_variant_idx: true, variants_json: true } },
        generated_content: { select: { compliance_status: true, main_image_url: true } },
      },
      orderBy: { created_at: "asc" },
    });
    say(`\n=== JOB ${JOB} — ${drafts.length} drafts ===`);

    for (const d of drafts) {
      if (skip.has(d.id)) continue;
      if (ONLY && d.id !== ONLY) continue;
      if (done >= LIMIT) { say("LIMIT reached"); break; }
      // Eligibility: own-brand cold + composite-eligible variant.
      const m = d.variation_matrix;
      if (!m || m.selected_variant_idx == null) { skip.add(d.id); continue; }
      let variant: any;
      try { variant = JSON.parse(m.variants_json)[m.selected_variant_idx]; } catch { skip.add(d.id); continue; }
      if (!variant || !isColdCategory(d.category)) { skip.add(d.id); continue; }
      const elig = compositeEligible({ brand: d.brand, variant });
      if (!elig.eligible) { say("  SKIP (not composite-eligible):", d.draft_name.slice(0, 45), "—", elig.reason); skip.add(d.id); continue; }
      // Re-run mode: skip drafts already on a good composite (only retry blocked).
      if (ONLY_BLOCKED) {
        const gc = (d as any).generated_content?.[0];
        const alreadyGood = (gc?.main_image_url ?? "").includes("bf-composite") && gc?.compliance_status === "CAN_PUBLISH";
        if (alreadyGood) { skip.add(d.id); continue; }
      }
      done++;

      try {
        say("→", d.draft_name.slice(0, 55));
        // Make sure the rows are eligible for (re)imaging.
        await prisma.generatedContent.updateMany({
          where: { bundle_draft_id: d.id, compliance_status: "BLOCKED" },
          data: { compliance_status: "CAN_PUBLISH", manual_review_required: false },
        });

        // 1) Rebuild the MAIN image as a QA-gated composite (force = regenerate).
        const img = await runImageGeneration({ bundle_draft_id: d.id, force: true, actor: "img-replace" });
        const o = img.outcomes[0];
        const ok = o?.compliance_status === "CAN_PUBLISH" && !!o?.image_url;
        if (!ok) {
          blocked++;
          say("  QA-BLOCKED (kept old image):", (o?.error ?? "no image").slice(0, 120));
          // A transient box-queue/vision blip must not fuse; a genuine QA reject
          // is per-draft (skip it, don't burn the run).
          const transient = /504|gateway|timeout|aborted|unavailable/i.test(o?.error ?? "");
          if (!transient) skip.add(d.id);
          if (transient) { infraStreak++; await new Promise((r) => setTimeout(r, 30_000)); }
          if (infraStreak >= 5) { say("FUSE: infra"); break; }
          continue;
        }
        infraStreak = 0;
        const newUrl = o.image_url!;

        // 2) Is there already a published SKU for this bundle?
        const mbId = d.master_bundle_id
          ?? (await prisma.bundleDraft.findUnique({ where: { id: d.id }, select: { master_bundle_id: true } }))?.master_bundle_id
          ?? null;
        const published = mbId
          ? await prisma.channelSKU.count({
              where: { master_bundle_id: mbId, listing_status: { in: ["SUBMITTED", "LIVE", "PENDING_REVIEW"] } } })
          : 0;

        if (published > 0 && mbId) {
          // REPLACE: point the live SKU(s) at the new real-photo image and re-PUT.
          await prisma.channelSKU.updateMany({ where: { master_bundle_id: mbId }, data: { main_image_url: newUrl } });
          const dist = await runDistribution({ bundle_draft_id: d.id, apply: APPLY, republish: true, actor: "img-replace" });
          const s = dist.per_sku.find((x: any) => x.marketplace_kind === "amazon") ?? dist.per_sku[0];
          if (s && (s.status === "SUBMITTED" || s.status === "LIVE")) { replaced++; say(`  REPLACED (${replaced}) ${s.sku} → ${s.marketplace_status}`); }
          else { say("  REPLACE PUT issue:", JSON.stringify({ st: s?.status, err: s?.error?.slice(0, 120), iss: s?.issues?.slice(0, 1) })); skip.add(d.id); }
        } else {
          // FINISH: promote (copies the new composite URL into the SKU) → validate → publish.
          await promoteDraftToChannelSkus(d.id);
          const mb2 = (await prisma.bundleDraft.findUnique({ where: { id: d.id }, select: { master_bundle_id: true } }))?.master_bundle_id;
          if (mb2) await prisma.channelSKU.updateMany({ where: { master_bundle_id: mb2 }, data: { main_image_url: newUrl } });
          const val = await runValidationForDraft({ bundle_draft_id: d.id, actor: "img-replace" });
          const failedSku = (val.per_sku ?? []).find((s: any) => s.status === "FAILED");
          if (failedSku) { say("  VALIDATION FAILED:", JSON.stringify((failedSku as any).failed ?? "").slice(0, 140)); skip.add(d.id); continue; }
          const dist = await runDistribution({ bundle_draft_id: d.id, apply: APPLY, actor: "img-replace" });
          const s = dist.per_sku.find((x: any) => x.marketplace_kind === "amazon") ?? dist.per_sku[0];
          if (s && (s.status === "SUBMITTED" || s.status === "LIVE")) { finished++; say(`  PUBLISHED (${finished}) ${s.sku} → ${s.marketplace_status}`); }
          else { say("  PUBLISH issue:", JSON.stringify({ st: s?.status, err: s?.error?.slice(0, 120), iss: s?.issues?.slice(0, 1) })); skip.add(d.id); }
        }
      } catch (e) {
        infraStreak++;
        const msg = (e as Error).message.slice(0, 180);
        say("  ERR", msg);
        const transient = /ETIMEDOUT|ECONN|504|gateway|timeout|aborted|fetch failed/i.test(msg);
        if (transient) { await new Promise((r) => setTimeout(r, 30_000)); }
        else skip.add(d.id);
        if (infraStreak >= 5) { say("FUSE: 5 consecutive infra errors — stopping"); break; }
      }
      await new Promise((r) => setTimeout(r, 8_000)); // polite pacing (shared box queue)
    }
    if (infraStreak >= 5) break;
  }

  say(`\nimg-replace done: ${replaced} replaced, ${finished} finished, ${blocked} QA-blocked, ${skip.size} skipped`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
