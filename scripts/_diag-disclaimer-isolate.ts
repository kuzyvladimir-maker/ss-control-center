// Probe: does Amazon's 99300 classifier fire on Claude content alone,
// disclaimer alone, or only the combination? Uses VALIDATION_PREVIEW
// (no real PATCH, no listing mutation) on one failed-AMZCOM row.
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { getListing, patchListing, type ListingPatch } from "@/lib/amazon-sp-api/listings";
import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import { storeIndexFor, type AccountKey } from "@/lib/bundle-factory/audit/account-map";
import { DISCLAIMER_BULLET, DISCLAIMER_DESCRIPTION } from "@/lib/bundle-factory/remediation/disclaimer-text";

async function main() {
  const r = await prisma.listingRemediation.findFirst({
    where: { status: "failed", audit_result: { scan_id: "cmpaisoq80000wlfz4llxuo5k" } },
    include: { audit_result: { select: { asin: true, sku: true, account: true, title: true } } },
  });
  if (!r) throw new Error("no failed row");
  const sku = r.audit_result.sku!;
  const acct = r.audit_result.account as AccountKey;
  const storeIdx = storeIndexFor(acct);
  const sellerId = await getMerchantToken(storeIdx);
  const live = await getListing(storeIdx, sellerId, sku);
  const productType = live.summaries?.find(s => s.marketplaceId === MARKETPLACE_ID)?.productType || "PRODUCT";

  const claudeBullets = JSON.parse(r.new_bullets!);
  const claudeOnlyBullets = claudeBullets.slice(0, -1); // drop disclaimer bullet
  const fullDesc = r.new_description!;
  const claudeOnlyDesc = fullDesc.replace(/\n\nAbout this gift basket:[\s\S]*$/, "").trim();

  console.log(`Probing ${r.audit_result.asin} (productType=${productType})`);
  console.log(`Claude-only bullets: ${claudeOnlyBullets.length}, desc ${claudeOnlyDesc.length} chars\n`);

  async function probe(label: string, bullets: string[], desc: string) {
    const patches: ListingPatch[] = [
      { op: "replace", path: "/attributes/bullet_point",
        value: bullets.map(v => ({ value: v, language_tag: "en_US", marketplace_id: MARKETPLACE_ID })) },
      { op: "replace", path: "/attributes/product_description",
        value: [{ value: desc, language_tag: "en_US", marketplace_id: MARKETPLACE_ID }] },
    ];
    try {
      const res = await patchListing(storeIdx, sellerId, sku, productType, patches, { validationPreview: true });
      const invalid = res?.status === "INVALID";
      const issues = invalid ? (res.issues ?? []).map((i:any)=>`${i.attributeNames?.join(",")}: ${i.code}`).join(" | ") : "";
      console.log(`[${label}] status=${res?.status} ${issues}`);
    } catch (e) { console.log(`[${label}] ERROR ${e instanceof Error ? e.message : String(e)}`); }
  }

  await probe("A. Claude bullets ONLY (no disclaimer anywhere)", claudeOnlyBullets, claudeOnlyDesc);
  await probe("B. Claude bullets + disclaimer paragraph in desc", claudeOnlyBullets, `${claudeOnlyDesc}\n\n${DISCLAIMER_DESCRIPTION}`);
  await probe("C. Claude bullets + disclaimer bullet + Claude desc (no desc disclaimer)", [...claudeOnlyBullets, DISCLAIMER_BULLET], claudeOnlyDesc);
  await probe("D. Full (Claude + disclaimer bullet + disclaimer paragraph) [matches failed PATCH]", claudeBullets, fullDesc);

  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
