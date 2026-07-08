// Pilot finisher — as MAIN images land, each draft flows promote → validate →
// publish (APPLY) automatically. Owner approved publishing this batch tonight
// (2026-07-07). Fuse: 3 consecutive publish failures → stop.
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { promoteDraftToChannelSkus } = await import("@/lib/bundle-factory/validation/promote-draft");
  const { runValidationForDraft } = await import("@/lib/bundle-factory/validation/validation-pipeline");
  const { runDistribution } = await import("@/lib/bundle-factory/distribution/distribution-pipeline");
  const JOB = "cmra8yv2k000010fzbuhf8wl9";
  const say = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
  let failStreak = 0, published = 0;
  for (let round = 0; round < 200; round++) {
    // Draft ready for publish: has image + CAN_PUBLISH content + its SKU (if
    // any) not yet submitted/live.
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
      if (c.master_bundle_id) {
        const submitted = await prisma.channelSKU.findFirst({
          where: { master_bundle_id: c.master_bundle_id, listing_status: { in: ["SUBMITTED", "LIVE"] } },
          select: { id: true } });
        if (submitted) continue;
      }
      work = c; break;
    }
    if (!work) {
      // done? all drafts published or awaiting images
      const total = await prisma.bundleDraft.count({ where: { generation_job_id: JOB } });
      const pubOrSub = await prisma.channelSKU.count({
        where: { master_bundle: { generation_job_id: JOB }, listing_status: { in: ["SUBMITTED", "LIVE"] } } });
      say(`idle: ${pubOrSub}/${total} submitted/live — waiting for images (5 min)`);
      if (pubOrSub >= total) { say("ALL PUBLISHED"); break; }
      await new Promise((r) => setTimeout(r, 300_000));
      continue;
    }
    try {
      say("→", work.draft_name.slice(0, 50));
      await promoteDraftToChannelSkus(work.id);
      const val = await runValidationForDraft({ bundle_draft_id: work.id, actor: "finisher" });
      const bad = (val.per_sku ?? []).some((s: any) => s.status === "FAILED");
      if (bad) { failStreak++; say("  VALIDATION FAILED", JSON.stringify(val.per_sku?.map((s: any) => s.failed)).slice(0, 200)); }
      else {
        const r = await runDistribution({ bundle_draft_id: work.id, apply: true, actor: "finisher" });
        const s = r.per_sku[0];
        if (s?.status === "SUBMITTED" || s?.status === "LIVE") { published++; failStreak = 0; say(`  PUBLISHED (${published}) ${s.sku} ${s.marketplace_status}`); }
        else { failStreak++; say("  PUBLISH FAIL", JSON.stringify({ st: s?.status, err: s?.error?.slice(0, 200), issues: s?.issues?.slice(0, 1) })); }
      }
    } catch (e) { failStreak++; say("  ERR", (e as Error).message.slice(0, 200)); }
    if (failStreak >= 3) { say("FUSE: 3 consecutive failures — stopping"); break; }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  say(`finisher done: ${published} published this run`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
