// Pilot finisher — as MAIN images land, each draft flows promote → validate →
// publish (APPLY) automatically. Owner approved publishing this batch tonight
// (2026-07-07). Robust: skips drafts that fail validation (adds to a skip-set
// so it never loops on a bad one); on an IMAGE-LOGO failure it clears the image
// so the image driver regenerates it (retailer badge from the donor photo);
// fuses only on repeated INFRA errors, not per-draft content failures.
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { promoteDraftToChannelSkus } = await import("@/lib/bundle-factory/validation/promote-draft");
  const { runValidationForDraft } = await import("@/lib/bundle-factory/validation/validation-pipeline");
  const { runDistribution } = await import("@/lib/bundle-factory/distribution/distribution-pipeline");
  const JOB = process.env.BF_JOB || "cmra8yv2k000010fzbuhf8wl9";
  const say = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
  const skip = new Set<string>();      // drafts that failed validation this run
  let infraStreak = 0, published = 0;
  for (let round = 0; round < 400; round++) {
    const candidates = await prisma.bundleDraft.findMany({
      where: {
        generation_job_id: JOB,
        generated_content: { some: { compliance_status: "CAN_PUBLISH", main_image_url: { not: null } } },
        status: { notIn: ["PUBLISHING", "PUBLISHED"] },
      },
      select: { id: true, draft_name: true, master_bundle_id: true },
      orderBy: { created_at: "asc" },
    });
    let work = null as null | { id: string; draft_name: string };
    for (const c of candidates) {
      if (skip.has(c.id)) continue;
      if (c.master_bundle_id) {
        const submitted = await prisma.channelSKU.findFirst({
          where: { master_bundle_id: c.master_bundle_id, listing_status: { in: ["SUBMITTED", "LIVE", "PENDING_REVIEW"] } },
          select: { id: true } });
        if (submitted) continue;
      }
      work = c; break;
    }
    if (!work) {
      const total = await prisma.bundleDraft.count({ where: { generation_job_id: JOB } });
      const mbIds = (await prisma.bundleDraft.findMany({ where: { generation_job_id: JOB, master_bundle_id: { not: null } }, select: { master_bundle_id: true } })).map((d) => d.master_bundle_id!);
      const pub = await prisma.channelSKU.count({ where: { master_bundle_id: { in: mbIds }, listing_status: { in: ["SUBMITTED", "LIVE", "PENDING_REVIEW"] } } });
      say(`idle: ${pub}/${total} on Amazon, ${skip.size} skipped (bad image/validation) — waiting for images (5 min)`);
      if (pub + skip.size >= total) { say("ALL DONE (published or skipped)"); break; }
      await new Promise((r) => setTimeout(r, 300_000));
      continue;
    }
    try {
      say("→", work.draft_name.slice(0, 50));
      await promoteDraftToChannelSkus(work.id);
      const val = await runValidationForDraft({ bundle_draft_id: work.id, actor: "finisher" });
      const failedSku = (val.per_sku ?? []).find((s: any) => s.status === "FAILED");
      if (failedSku) {
        infraStreak = 0; // per-draft content failure, not infra
        const dump = JSON.stringify(failedSku).toLowerCase();
        const imageLogo = /rule-6|vision|foreign_logo|image/.test(dump);
        if (imageLogo) {
          // Retailer badge / bad image → clear it so the image driver regenerates
          // with the fixed no-retailer-logo prompt.
          await prisma.generatedContent.updateMany({
            where: { bundle_draft_id: work.id }, data: { main_image_url: null } });
          await prisma.bundleDraft.update({ where: { id: work.id }, data: { status: "GENERATED" } }).catch(() => {});
          say("  IMAGE REJECTED (retailer logo/vision) → cleared for regeneration");
        } else {
          say("  VALIDATION FAILED (skipping)", JSON.stringify((failedSku as any).failed ?? (failedSku as any).results?.filter((r: any) => !r.passed)?.map((r: any) => r.validator_id)).slice(0, 160));
        }
        skip.add(work.id);
      } else {
        const r = await runDistribution({ bundle_draft_id: work.id, apply: true, actor: "finisher" });
        const s = r.per_sku[0];
        if (s?.status === "SUBMITTED" || s?.status === "LIVE") { published++; infraStreak = 0; say(`  PUBLISHED (${published}) ${s.sku} ${s.marketplace_status}`); }
        else { infraStreak++; skip.add(work.id); say("  PUBLISH FAIL (skipping)", JSON.stringify({ st: s?.status, err: s?.error?.slice(0, 160), issues: s?.issues?.slice(0, 1) })); }
      }
    } catch (e) { infraStreak++; say("  ERR", (e as Error).message.slice(0, 200)); }
    if (infraStreak >= 5) { say("FUSE: 5 consecutive infra errors — stopping"); break; }
    await new Promise((r) => setTimeout(r, 12_000));
  }
  say(`finisher done: ${published} published this run, ${skip.size} skipped`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
