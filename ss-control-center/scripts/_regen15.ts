import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
const IDS = ["cmra96glo000004l7s8ii18af","cmra9asnc00mw04lbwuw9596b","cmra9ijk4000604jvzp4ku6br","cmra9m7aj000804lesekwb1sd","cmra9sn4q000j04le01fi5f79","cmra9t818000l04le95quyqq1","cmra9u928000r04le630q8mzj","cmra9z294008904leaum5i40r","cmraa6yax000i04jvt5a0d8wp","cmraab326000o04jv3cjiammi","cmraaidy8000804lemp5yq1vd","cmraaos9v003404jvbd5vghq8","cmrab6uln001704lecuyi6ao8","cmrab82rd000004l2f5zaondw","cmrabgasb001r04lefspxv19j"];
async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { runContentGeneration } = await import("@/lib/bundle-factory/content-pipeline");
  let ok = 0;
  for (const id of IDS) {
    const t0 = Date.now();
    try {
      const r = await runContentGeneration({ bundle_draft_id: id, channels: ["AMAZON_SALUTEM"], actor: "count-fix-regen" });
      const pass = r.outcomes.some((o) => o.compliance_status === "CAN_PUBLISH");
      if (pass) ok++;
      console.log(new Date().toISOString(), pass ? "OK" : "BLOCKED", id, `${Math.round((Date.now()-t0)/1000)}s`);
    } catch (e) { console.log(new Date().toISOString(), "ERR", id, (e as Error).message.slice(0, 120)); }
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log(`regen done: ${ok}/${IDS.length}`);
  // re-audit the regenerated rows
  const drafts = await prisma.bundleDraft.findMany({
    where: { id: { in: IDS } },
    select: { id: true, pack_count: true, generated_content: { select: { title: true, bullets_json: true, description: true } } },
  });
  let clean = 0;
  for (const d of drafts) {
    const g = d.generated_content[0]; if (!g) continue;
    const all = [g.title, g.description, ...(JSON.parse(g.bullets_json ?? "[]"))].join("\n");
    const boxy = /\b(boxes|bulk case|per box|case of)\b/i.test(all);
    const tm = g.title.match(/(\d{1,3})\s*Count/i);
    const mismatch = tm && parseInt(tm[1]) !== d.pack_count;
    if (!boxy && !mismatch) clean++; else console.log("STILL BAD:", d.id, boxy ? "boxy" : "", mismatch ? `count ${tm![1]}!=${d.pack_count}` : "");
  }
  console.log(`re-audit clean: ${clean}/${IDS.length}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
