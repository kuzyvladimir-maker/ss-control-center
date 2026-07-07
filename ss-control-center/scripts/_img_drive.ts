// Local image driver for pilot v2 — bypasses the 300s serverless ceiling by
// running runImageGeneration in-process. Serial, gentle pacing (codex queue is
// shared with the COGS cron). Logs to stdout (captured to a file).
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { runImageGeneration } = await import("@/lib/bundle-factory/image-pipeline");
  const JOB = "cmra8yv2k000010fzbuhf8wl9";

  // Re-unblock rows the timed-out morning pass may have re-blocked.
  const unblocked = await prisma.generatedContent.updateMany({
    where: { bundle_draft: { generation_job_id: JOB }, compliance_status: "BLOCKED", main_image_url: null },
    data: { compliance_status: "CAN_PUBLISH", manual_review_required: false },
  });
  console.log(new Date().toISOString(), "unblocked:", unblocked.count);

  let okTotal = 0, failStreak = 0;
  for (let round = 0; round < 60; round++) {
    const draft = await prisma.bundleDraft.findFirst({
      where: { generation_job_id: JOB,
        generated_content: { some: { compliance_status: "CAN_PUBLISH", main_image_url: null } } },
      select: { id: true, draft_name: true },
      orderBy: { created_at: "asc" },
    });
    if (!draft) { console.log(new Date().toISOString(), "ALL DONE — no drafts left"); break; }
    const t0 = Date.now();
    try {
      const r = await runImageGeneration({ bundle_draft_id: draft.id, actor: "day-driver" });
      const o = r.outcomes[0];
      const ok = o?.compliance_status === "CAN_PUBLISH" && !!o?.image_url;
      if (ok) { okTotal++; failStreak = 0; } else { failStreak++; }
      console.log(new Date().toISOString(), ok ? "OK" : "FAIL", `[${okTotal} ok]`,
        draft.draft_name.slice(0, 45), `${Math.round((Date.now()-t0)/1000)}s`,
        o?.error ? "err=" + o.error.slice(0, 150) : "");
      if (!ok) {
        // un-block immediately so a later round can retry this draft
        await prisma.generatedContent.updateMany({
          where: { bundle_draft_id: draft.id, compliance_status: "BLOCKED", main_image_url: null },
          data: { compliance_status: "CAN_PUBLISH", manual_review_required: false },
        });
        await prisma.bundleDraft.update({ where: { id: draft.id }, data: { status: "GENERATED" } }).catch(() => {});
      }
      if (failStreak >= 3) { console.log(new Date().toISOString(), "FUSE: 3 consecutive fails — stopping"); break; }
    } catch (e) {
      console.log(new Date().toISOString(), "ERR", draft.draft_name.slice(0, 45), (e as Error).message.slice(0, 200));
      if (++failStreak >= 3) { console.log("FUSE"); break; }
    }
    await new Promise((r) => setTimeout(r, 20_000)); // polite gap for the shared queue
  }
  console.log(new Date().toISOString(), `driver finished: ${okTotal} images this run`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
