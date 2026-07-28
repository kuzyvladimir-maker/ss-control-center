// Which bullet trips Amazon's 99300 ("false/promotional claims")? Leave-one-out
// VALIDATION_PREVIEW (non-mutating): drop bullet i, re-preview. If it flips to
// VALID, bullet i is the culprit.
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });

const SKU = process.env.SKU || "HU-ASMI-DN3X";

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { buildAmazonPayload } = await import("@/lib/bundle-factory/distribution/amazon-publish");
  const { productTypeForBundle } = await import("@/lib/bundle-factory/attributes");
  const { spApiPut, MARKETPLACE_ID } = await import("@/lib/amazon-sp-api/client");
  const { getMerchantToken } = await import("@/lib/amazon-sp-api/sellers");
  const { channelTarget } = await import("@/lib/bundle-factory/distribution/account-map");

  const row = await prisma.channelSKU.findFirstOrThrow({ where: { sku: SKU } });
  const mb = row.master_bundle_id
    ? await prisma.masterBundle.findUnique({ where: { id: row.master_bundle_id }, select: { brand: true, category: true } })
    : null;
  const storeIndex = (channelTarget(row.channel) as any).storeIndex;
  const sellerId = await getMerchantToken(storeIndex);
  const url = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(SKU)}`;

  const basePayload: any = buildAmazonPayload(row as any, productTypeForBundle(), mb?.brand, (mb as any)?.category);
  const allBullets: any[] = basePayload.attributes.bullet_point;

  async function preview(bullets: any[]): Promise<{ status: string; codes: string[] }> {
    const p = JSON.parse(JSON.stringify(basePayload));
    p.attributes.bullet_point = bullets;
    const r: any = await spApiPut(url, p, { storeId: `store${storeIndex}`, params: { marketplaceIds: MARKETPLACE_ID, mode: "VALIDATION_PREVIEW" } });
    const codes = (Array.isArray(r?.issues) ? r.issues : []).filter((i: any) => i.severity === "ERROR").map((i: any) => String(i.code));
    return { status: String(r?.status), codes };
  }

  const full = await preview(allBullets);
  console.log(`baseline (all ${allBullets.length} bullets): ${full.status} errors=[${full.codes.join(",")}]`);

  for (let i = 0; i < allBullets.length; i++) {
    const subset = allBullets.filter((_, j) => j !== i);
    const r = await preview(subset);
    const cleared = !r.codes.includes("99300");
    console.log(`drop [${i}] → ${r.status} errors=[${r.codes.join(",")}] ${cleared ? "  ⬅ 99300 CLEARED (culprit)" : ""}`);
    console.log(`      "${String(allBullets[i].value).slice(0, 100)}"`);
    await new Promise((res) => setTimeout(res, 1500)); // be gentle with SP-API
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
