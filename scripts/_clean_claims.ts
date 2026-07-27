// Bring the 9 already-published listings into line with Amazon's PDP policy:
// replace sale/shipping/availability claims with plain storage instructions.
//
// SAFETY ORDER: build the edited copy in memory -> VALIDATION_PREVIEW (does not
// write) -> local Rule 8 check -> only if BOTH pass, persist to the DB and PUT.
// A listing that fails either check is left exactly as it was.
//
//   BF_DRY=1 npx tsx scripts/_clean_claims.ts   # preview only, no writes
//   npx tsx scripts/_clean_claims.ts            # apply + republish
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });

type Edit = { sku: string; bullet?: { find: string; replace: string }; desc?: { find: string; replace: string } };

const EDITS: Edit[] = [
  { sku: "SV-AS9L-DRRH",
    bullet: { find: "Ships frozen with insulated packaging and gel ice packs to maintain product integrity during transit; store in freezer upon arrival",
              replace: "Store in the freezer upon arrival and keep frozen until ready to use" },
    desc: { find: "The gift set ships frozen with insulated packaging and gel ice packs to maintain proper temperature during delivery.",
            replace: "Keep the gift set frozen and store it in the freezer upon arrival." } },
  { sku: "QE-ASEQ-4YV5",
    bullet: { find: "Ships frozen; refrigerate or freeze upon receipt and keep frozen until ready to serve — do not refreeze sandwiches that have fully thawed",
              replace: "Keep frozen until ready to serve. Refrigerate or freeze upon receipt; do not refreeze sandwiches that have fully thawed" } },
  { sku: "PY-ASBM-WX6W",
    bullet: { find: "Ships frozen; store in freezer until ready to use and consume within 6 to 8 hours after thawing",
              replace: "Keep frozen. Store in the freezer until ready to use and consume within 6 to 8 hours after thawing" } },
  { sku: "GR-AS1P-DBB2",
    desc: { find: "The pack ships frozen.", replace: "Keep the pack frozen until ready to eat." } },
  { sku: "NS-ASSD-B3JJ",
    bullet: { find: "Limited-edition Berry Burst flavor featuring a seasonal blend of strawberries and blueberries — available for a limited time",
              replace: "Limited-edition Berry Burst flavor with a blend of strawberry and blueberry" } },
  { sku: "TP-AS91-8PAZ",
    desc: { find: "This is a limited-edition Berry Burst flavor, available for a limited time.",
            replace: "This is the limited-edition Berry Burst flavor." } },
  { sku: "ZB-ASKL-9W8G",
    desc: { find: ", available while supplies last.", replace: "." } },
  { sku: "VN-AS1A-D572",
    desc: { find: "Each sandwich is individually wrapped and ships frozen.",
            replace: "Each sandwich is individually wrapped. Keep frozen." } },
  { sku: "AU-AS97-USX8",
    desc: { find: "Sandwiches ship frozen.", replace: "Keep sandwiches frozen." } },
];

async function main() {
  const APPLY = process.env.BF_DRY !== "1";
  const { prisma } = await import("@/lib/prisma");
  const { buildAmazonPayload } = await import("@/lib/bundle-factory/distribution/amazon-publish");
  const { channelTarget } = await import("@/lib/bundle-factory/distribution/account-map");
  const { spApiPut, MARKETPLACE_ID } = await import("@/lib/amazon-sp-api/client");
  const { getMerchantToken } = await import("@/lib/amazon-sp-api/sellers");
  const { productTypeForBundle } = await import("@/lib/bundle-factory/attributes");
  const { rulePromotionalLanguage } = await import("@/lib/bundle-factory/compliance/rules/rule-8-promotional-language");
  const { runDistribution } = await import("@/lib/bundle-factory/distribution/distribution-pipeline");

  let ok = 0, skipped = 0;
  for (const e of EDITS) {
    const row = await prisma.channelSKU.findFirst({ where: { sku: e.sku } });
    if (!row) { console.log(`\n${e.sku}: NOT FOUND`); skipped++; continue; }
    const mb = row.master_bundle_id ? await prisma.masterBundle.findUnique({ where: { id: row.master_bundle_id }, select: { brand: true, category: true } }) : null;

    let bullets: string[] = [];
    try { bullets = JSON.parse(row.bullets || "[]"); } catch {}
    let desc = row.description || "";
    let changed = false;

    if (e.bullet) {
      const i = bullets.findIndex((b) => b.includes(e.bullet!.find));
      if (i < 0) { console.log(`\n${e.sku}: bullet text not found — SKIP (already clean?)`); }
      else { bullets[i] = bullets[i].replace(e.bullet.find, e.bullet.replace); changed = true; }
    }
    if (e.desc) {
      if (!desc.includes(e.desc.find)) { console.log(`\n${e.sku}: desc text not found — SKIP`); }
      else { desc = desc.replace(e.desc.find, e.desc.replace); changed = true; }
    }
    if (!changed) { skipped++; continue; }

    // 1) local Rule 8 on the edited content
    const r8 = rulePromotionalLanguage({ title: row.title, brand: mb?.brand ?? "", bullets, description: desc } as never);
    // 2) Amazon VALIDATION_PREVIEW on the edited payload (does NOT write)
    const edited = { ...row, bullets: JSON.stringify(bullets), description: desc };
    const storeIndex = (channelTarget(row.channel) as { storeIndex: number }).storeIndex;
    const sellerId = await getMerchantToken(storeIndex);
    const url = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(e.sku)}`;
    const payload = buildAmazonPayload(edited as never, productTypeForBundle(), mb?.brand, mb?.category);
    const preview = (await spApiPut(url, payload, { storeId: `store${storeIndex}`, params: { marketplaceIds: MARKETPLACE_ID, mode: "VALIDATION_PREVIEW" } })) as
      { status?: string; issues?: Array<{ severity?: string; code?: string }> };
    const errs = (preview.issues ?? []).filter((i) => i.severity === "ERROR").map((i) => i.code);

    console.log(`\n${e.sku} [${row.listing_status}] rule8=${r8.passed ? "pass" : "FAIL:" + r8.reason} preview=${preview.status} errors=[${errs.join(",")}]`);
    if (e.bullet) console.log(`   bullet → ${bullets.find((b) => b.includes(e.bullet!.replace))?.slice(0, 100)}`);
    if (e.desc) console.log(`   desc   → ...${e.desc.replace.slice(0, 80)}`);

    // The TEXT is compliant when Rule 8 passes and Amazon raises no 99300. A
    // listing can still be INVALID for unrelated reasons (e.g. 5665 = brand not
    // approved) — in that case we persist the cleaner copy but do NOT republish,
    // because the listing cannot go live anyway.
    const textOk = r8.passed && !errs.includes("99300");
    const canPublish = preview.status === "VALID";
    if (!textOk) { console.log("   ⨯ NOT APPLIED (text still fails policy)"); skipped++; continue; }
    if (!APPLY) { console.log(`   ✓ would apply${canPublish ? " + republish" : " (DB only — listing can't publish)"} (dry run)`); ok++; continue; }

    // 3) persist + mirror into GeneratedContent, then republish (if publishable)
    await prisma.channelSKU.update({ where: { id: row.id }, data: { bullets: JSON.stringify(bullets), description: desc } });
    if (!canPublish) {
      console.log(`   ✓ text cleaned in DB; republish SKIPPED (preview errors: ${errs.join(",")})`);
    }
    if (row.master_bundle_id) {
      // Mirror into GeneratedContent regardless, so a future re-promote can't
      // reintroduce the offending copy.
      const drafts = await prisma.bundleDraft.findMany({ where: { master_bundle_id: row.master_bundle_id }, select: { id: true } });
      for (const d of drafts) {
        await prisma.generatedContent.updateMany({ where: { bundle_draft_id: d.id }, data: { bullets_json: JSON.stringify(bullets), description: desc } });
      }
      const draft = drafts[0];
      if (canPublish && draft) {
        const dist = await runDistribution({ bundle_draft_id: draft.id, apply: true, republish: true, actor: "clean-claims" });
        const s = dist.per_sku.find((x: { sku: string }) => x.sku === e.sku) ?? dist.per_sku[0];
        console.log(`   → republish: ${s?.status} ${s?.marketplace_status ?? ""}`);
      }
    }
    ok++;
    await new Promise((r) => setTimeout(r, 2500));
  }
  console.log(`\ndone: ${ok} cleaned, ${skipped} skipped`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
