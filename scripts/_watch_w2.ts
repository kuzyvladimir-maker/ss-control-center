import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
async function main() {
  const { prisma } = await import("@/lib/prisma");
  const JOB = "cmrbdh4dm0000zhfzhtijm97m";
  for (;;) {
    const total = await prisma.bundleDraft.count({ where: { generation_job_id: JOB } });
    const mbIds = (await prisma.bundleDraft.findMany({ where: { generation_job_id: JOB, master_bundle_id: { not: null } }, select: { master_bundle_id: true } })).map((d) => d.master_bundle_id!);
    const sub = await prisma.channelSKU.count({ where: { master_bundle_id: { in: mbIds }, listing_status: { in: ["SUBMITTED", "LIVE", "PENDING_REVIEW"] } } });
    if (sub >= total - 3) { console.log(`WAVE-2 PUBLISHED: ${sub}/${total}`); break; }
    await new Promise((r) => setTimeout(r, 1_800_000));
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
