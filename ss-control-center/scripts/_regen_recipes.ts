// Regenerate images (retail-boxes cooler-hero) for the 6 recipe-fixed drafts.
// The recipe now has BOTH flavors, so the image should show both. Generates into
// generated_content only (no publish) — we view them before republishing.
// Run with BF_FORCE_HERO=1 BF_UNCR_MODE=retail_boxes.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
const DRAFTS = [
  "cmrbhrmu1002s04jutzzxgtdx", "cmrbh7yra001504l7xfclfn12", "cmrbhl6u9001e04jug3r1qet2",
  "cmrbhth8n004004ju7r8tgchz", "cmrbhwwn4005404ju6wq4lc5w", "cmrbhy9sv006404ju35bjwlok",
];
async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { runImageGeneration } = await import("@/lib/bundle-factory/image-pipeline");
  const say = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
  for (const id of DRAFTS) {
    try {
      await prisma.generatedContent.updateMany({ where: { bundle_draft_id: id, compliance_status: "BLOCKED" }, data: { compliance_status: "CAN_PUBLISH", manual_review_required: false } });
      const r = await runImageGeneration({ bundle_draft_id: id, force: true, actor: "regen-recipes" });
      const o = r.outcomes[0];
      say(id, "→", o?.compliance_status, "attempts", o?.attempts, o?.image_url ?? o?.error);
    } catch (e) { say(id, "ERR", (e as Error).message.slice(0, 120)); }
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
