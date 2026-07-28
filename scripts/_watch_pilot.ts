import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
async function main() {
  const { prisma } = await import("@/lib/prisma");
  const JOB = "cmra8yv2k000010fzbuhf8wl9";
  for (;;) {
    const mbIds = (await prisma.bundleDraft.findMany({ where: { generation_job_id: JOB, master_bundle_id: { not: null } }, select: { master_bundle_id: true } })).map((d) => d.master_bundle_id!);
    const sub = await prisma.channelSKU.count({ where: { master_bundle_id: { in: mbIds }, listing_status: { in: ["SUBMITTED", "LIVE", "PENDING_REVIEW"] } } });
    if (sub >= 48) { console.log(`PILOT PUBLISHED: ${sub}/50`); break; }
    await new Promise((r) => setTimeout(r, 600_000));
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
