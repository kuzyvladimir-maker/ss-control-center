// ROLLOUT: regenerate the retail-boxes cooler-hero (owner-approved look, quantity
// logic, no count numbers) for the DEFECTIVE Uncrustables drafts, then republish.
// Run with BF_FORCE_HERO=1 BF_UNCR_MODE=retail_boxes.
//
// Scope:  BF_HARD=1 (all hard-defect drafts from the audit) | BF_DRAFTS=a,b,c
// Excludes any draft in BF_KEEP (e.g. the owner-liked B0H85P9F3R wraps).
// Resilient: per-draft try/catch, one retry on worker timeout, infra fuse.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync } from "node:fs";

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { runImageGeneration } = await import("@/lib/bundle-factory/image-pipeline");
  const { runDistribution } = await import("@/lib/bundle-factory/distribution/distribution-pipeline");
  const say = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  let drafts: string[];
  if (process.env.BF_DRAFTS) drafts = process.env.BF_DRAFTS.split(",").map((s) => s.trim()).filter(Boolean);
  else if (process.env.BF_HARD === "1") {
    const audit = JSON.parse(readFileSync("data/cooler-audit.json", "utf8")) as Array<{ draft_id: string; reasons: string[] }>;
    const HARD = ["FABRICATED packaging", "packaging not real Uncrustables", "garbled brand text"];
    drafts = audit.filter((a) => (a.reasons || []).some((r) => HARD.includes(r) || r.startsWith("missing a flavor"))).map((a) => a.draft_id);
  } else { console.error("set BF_HARD=1 or BF_DRAFTS"); process.exit(1); }
  const keep = new Set((process.env.BF_KEEP || "cmrbhyood006g04ju4cqerjhn").split(",").map((s) => s.trim()).filter(Boolean));
  drafts = drafts.filter((d) => !keep.has(d));
  const APPLY = process.env.BF_DRY !== "1";
  say(`rollout retail-boxes | ${drafts.length} drafts | apply=${APPLY}`);

  let ok = 0, published = 0, blocked = 0, fail = 0, infra = 0;
  for (const id of drafts) {
    try {
      await prisma.generatedContent.updateMany({ where: { bundle_draft_id: id, compliance_status: "BLOCKED" }, data: { compliance_status: "CAN_PUBLISH", manual_review_required: false } });
      let img = await runImageGeneration({ bundle_draft_id: id, force: true, actor: "rollout-boxes" });
      let o = img.outcomes[0];
      // One retry on worker timeout (infra, not QA).
      if (o?.compliance_status !== "CAN_PUBLISH" && /timeout|aborted|504|gateway/i.test(o?.error ?? "")) {
        infra++; await sleep(15_000);
        await prisma.generatedContent.updateMany({ where: { bundle_draft_id: id, compliance_status: "BLOCKED" }, data: { compliance_status: "CAN_PUBLISH", manual_review_required: false } });
        img = await runImageGeneration({ bundle_draft_id: id, force: true, actor: "rollout-boxes" });
        o = img.outcomes[0];
      }
      if (o?.compliance_status !== "CAN_PUBLISH" || !o?.image_url) { blocked++; say("  QA/gen blocked:", id, (o?.error ?? "").slice(0, 90)); continue; }
      ok++;
      if (!APPLY) { say(`  built (${ok}):`, id); continue; }
      const dist = await runDistribution({ bundle_draft_id: id, apply: true, republish: true, actor: "rollout-boxes" });
      const s = dist.per_sku.find((x: any) => x.marketplace_kind === "amazon") ?? dist.per_sku[0];
      if (s && (s.status === "SUBMITTED" || s.status === "LIVE")) { published++; say(`  PUBLISHED (${published}) ${s.sku} → ${s.marketplace_status}`); }
      else { say("  PUT issue:", id, JSON.stringify({ st: s?.status, err: (s?.error ?? "").slice(0, 80) })); }
    } catch (e) {
      fail++; const msg = (e as Error).message.slice(0, 120); say("  ERR", id, msg);
      if (/ETIMEDOUT|ECONN|fetch failed/i.test(msg)) { infra++; await sleep(20_000); }
      if (infra >= 8) { say("FUSE: too many infra errors"); break; }
    }
    await sleep(5_000);
  }
  say(`\nrollout done: ${ok} generated, ${published} published, ${blocked} blocked, ${fail} errored`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
