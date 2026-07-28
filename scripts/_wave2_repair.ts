// Re-run content generation for wave-2 drafts whose text died with
// content-generation-error (gateway 504s under queue load). Runs через the
// SSH tunnel (env CODEX_IMAGE_WORKER_URL → /text-claude derived), so no nginx
// ceiling. Serial on the box's Claude queue; fuse on 5 consecutive errors.
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { runContentGeneration } = await import("@/lib/bundle-factory/content-pipeline");
  const JOB = "cmrbdh4dm0000zhfzhtijm97m";
  const say = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
  let ok = 0, streak = 0;
  for (let round = 0; round < 200; round++) {
    const d = await prisma.bundleDraft.findFirst({
      where: { generation_job_id: JOB, generated_content: { some: { compliance_status: "BLOCKED" } } },
      select: { id: true, draft_name: true }, orderBy: { created_at: "asc" } });
    if (!d) { say("no more BLOCKED — done"); break; }
    const t0 = Date.now();
    try {
      const r = await runContentGeneration({ bundle_draft_id: d.id, channels: ["AMAZON_SALUTEM"], actor: "wave2-repair" });
      const pass = r.outcomes.some((o) => o.compliance_status === "CAN_PUBLISH");
      if (pass) { ok++; streak = 0; } else streak++;
      say(pass ? `OK (${ok})` : "STILL BLOCKED", d.draft_name.slice(0, 55), `${Math.round((Date.now()-t0)/1000)}s`);
    } catch (e) { streak++; say("ERR", (e as Error).message.slice(0, 120)); }
    if (streak >= 5) { say("FUSE"); break; }
    await new Promise((r) => setTimeout(r, 3000));
  }
  say(`repair done: ${ok} fixed`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
