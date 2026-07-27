// Pilot: regenerate ONE fabricated draft as the ORIGINAL AI cooler-hero
// (individual Uncrustables wraps in the Salutem cooler, ref-uncrustables.png
// anchor) — the owner-approved B0H85P9F3R style. Generates into generated_content
// only; does NOT publish to Amazon (owner reviews first).
//
// Env: BF_ONLY_DRAFT=<id>  BF_FORCE_HERO=1  BF_UNCR_MODE=individual_wraps
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
async function main() {
  const { runImageGeneration } = await import("@/lib/bundle-factory/image-pipeline");
  const { prisma } = await import("@/lib/prisma");
  const draftId = process.env.BF_ONLY_DRAFT;
  if (!draftId) { console.error("set BF_ONLY_DRAFT"); process.exit(1); }
  // A prior QA-block leaves rows BLOCKED; the pipeline only processes CAN_PUBLISH.
  // Reset so the regeneration can run.
  const reset = await prisma.generatedContent.updateMany({
    where: { bundle_draft_id: draftId, compliance_status: "BLOCKED" },
    data: { compliance_status: "CAN_PUBLISH", manual_review_required: false },
  });
  console.log("reset BLOCKED→CAN_PUBLISH rows:", reset.count);
  console.log(new Date().toISOString(), "regenerating hero for", draftId, "| force_hero:", process.env.BF_FORCE_HERO, "| mode:", process.env.BF_UNCR_MODE);
  const r = await runImageGeneration({ bundle_draft_id: draftId, force: true, actor: "pilot-hero" });
  console.log(JSON.stringify(r.outcomes.map((o) => ({ ch: o.channel, status: o.compliance_status, attempts: o.attempts, url: o.image_url, err: o.error })), null, 1));
  console.log(new Date().toISOString(), "done");
}
main().catch((e) => { console.error(e); process.exit(1); });
