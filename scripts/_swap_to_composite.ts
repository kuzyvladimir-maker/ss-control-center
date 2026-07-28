// EMERGENCY SWAP — take fabricated AI cooler heroes DOWN, put the real-pixel
// box composite up as MAIN. No regeneration, no AI: we already have a QA'd
// real-photo composite per draft in data/uncrustables-image-map.json. This just
// repoints the live SKU's main_image_url at that known-good real image and
// re-PUTs (PUT is create-or-replace, so the new real image overwrites the fake).
//
// This is the SAFE interim fix (real Uncrustables boxes on white, Amazon-compliant)
// while the real-box-INSIDE-cooler upgrade is built separately. Nothing here can
// fabricate packaging — it's 100% real donor pixels.
//
// Env:
//   BF_ONLY_DRAFT=<id>     swap exactly one draft (pilot)
//   BF_DRAFTS=id,id,...     swap an explicit list
//   BF_DRY=1                dry run (set URL in DB but do NOT PUT to Amazon)
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync } from "node:fs";

type MapRow = { draft_id: string; name: string; composite: string | null; cooler: string | null };

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { runDistribution } = await import("@/lib/bundle-factory/distribution/distribution-pipeline");
  const say = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

  const map = JSON.parse(readFileSync("data/uncrustables-image-map.json", "utf8")) as MapRow[];
  const APPLY = process.env.BF_DRY !== "1";
  const only = process.env.BF_ONLY_DRAFT || "";
  const list = (process.env.BF_DRAFTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const want = new Set<string>(only ? [only] : list);

  const rows = map.filter((r) => (want.size ? want.has(r.draft_id) : true) && r.composite);
  say(`swap-to-composite | ${rows.length} drafts | apply=${APPLY}`);

  let ok = 0, skip = 0, fail = 0;
  for (const r of rows) {
    try {
      const d = await prisma.bundleDraft.findUnique({
        where: { id: r.draft_id },
        select: { master_bundle_id: true, draft_name: true },
      });
      if (!d?.master_bundle_id) { say("  SKIP (no master_bundle):", r.name.slice(0, 45)); skip++; continue; }

      // Repoint every SKU for this bundle at the real box composite.
      await prisma.channelSKU.updateMany({
        where: { master_bundle_id: d.master_bundle_id },
        data: { main_image_url: r.composite! },
      });
      await prisma.generatedContent.updateMany({
        where: { bundle_draft_id: r.draft_id },
        data: { main_image_url: r.composite! },
      });

      if (!APPLY) { say("  DRY set:", r.name.slice(0, 45)); ok++; continue; }

      const dist = await runDistribution({ bundle_draft_id: r.draft_id, apply: true, republish: true, actor: "swap-composite" });
      const s = dist.per_sku.find((x: any) => x.marketplace_kind === "amazon") ?? dist.per_sku[0];
      if (s && (s.status === "SUBMITTED" || s.status === "LIVE")) {
        ok++; say(`  OK (${ok}) ${s.sku} → ${s.marketplace_status}  [${r.name.slice(0, 40)}]`);
      } else {
        fail++; say("  PUT issue:", JSON.stringify({ st: s?.status, err: (s?.error ?? "").slice(0, 140), iss: s?.issues?.slice(0, 1) }));
      }
    } catch (e) {
      fail++; say("  ERR", (e as Error).message.slice(0, 160));
    }
    await new Promise((res) => setTimeout(res, 6_000)); // polite pacing
  }

  say(`\ndone: ${ok} swapped, ${skip} skipped, ${fail} failed`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
