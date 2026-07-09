import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { runImageGeneration } = await import("@/lib/bundle-factory/image-pipeline");
  const JOB = "cmrbdh4dm0000zhfzhtijm97m";
  // pick 1 valid 2-flavor mix (both donors exist) + 1 single, that already have images
  const drafts = await prisma.bundleDraft.findMany({ where: { generation_job_id: JOB, generated_content: { some: { main_image_url: { not: null } } } }, select: { id: true, draft_name: true, composition_type: true, variation_matrix: { select: { variants_json: true } } } });
  const mix = drafts.find((d) => { const c = JSON.parse(d.variation_matrix?.variants_json ?? "[]")[0]?.composition ?? []; return c.length === 2; });
  const single = drafts.find((d) => d.composition_type === "SINGLE_FLAVOR");
  for (const [tag, d] of [["MIX", mix], ["SINGLE", single]] as const) {
    if (!d) { console.log(tag, "none found"); continue; }
    await prisma.generatedContent.updateMany({ where: { bundle_draft_id: d.id }, data: { main_image_url: null } });
    await prisma.bundleDraft.update({ where: { id: d.id }, data: { status: "GENERATED" } }).catch(()=>{});
    console.log(`\n[${tag}] ${d.draft_name} — regenerating...`);
    const t0 = Date.now();
    const r = await runImageGeneration({ bundle_draft_id: d.id, force: true, actor: "test-regen" });
    const o = r.outcomes[0];
    console.log(`  ${Math.round((Date.now()-t0)/1000)}s | ${o?.compliance_status} | ${o?.image_url ?? "no url"} | err=${(o?.error??"").slice(0,150)}`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
