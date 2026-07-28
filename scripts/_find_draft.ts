import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
async function main() {
  const { prisma } = await import("@/lib/prisma");
  const mb = process.env.MB!;
  const drafts = await prisma.bundleDraft.findMany({ where: { master_bundle_id: mb }, select: { id: true, draft_name: true, category: true } });
  for (const d of drafts) console.log(d.id, "|", d.draft_name, "|", d.category);
  if (!drafts.length) console.log("no drafts for master_bundle", mb);
  await prisma.$disconnect();
}
main().catch(e=>{console.error(e.message);process.exit(1);});
