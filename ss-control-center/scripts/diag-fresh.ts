import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
async function main(){
  const { prisma } = await import("../src/lib/prisma");
  const { generateImagesForJob } = await import("../src/lib/amazon/aplus/images");
  const job = await prisma.amazonAplusJob.findFirst({ where:{ itemName:{ contains:"Short Ribs" } }, select:{ id:true } });
  if(!job){ console.log("no job"); return; }
  console.log("force-regen on gpt-image-2 (unique keys, NO_TEXT)…");
  const res = await generateImagesForJob(prisma, job.id, "gpt-image-2", true);
  console.log("result:", JSON.stringify(res));
  const u = await prisma.amazonAplusJob.findUnique({ where:{ id: job.id }, select:{ imagePlanJson:true } });
  for(const s of JSON.parse(u!.imagePlanJson!).slots) console.log(`  ${s.key}: ${s.url||"—"}`);
}
main().catch(e=>console.error("ERR",e?.message)).then(()=>process.exit(0));
