// Probe 3 minimal disclaimer variants on the same failed ASIN to find
// wording that passes Amazon PDP classifier (code 99300) WITHOUT the
// legalese that Option C Defensive used. Uses VALIDATION_PREVIEW only.

import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { getListing, patchListing, type ListingPatch } from "@/lib/amazon-sp-api/listings";
import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import { storeIndexFor, type AccountKey } from "@/lib/bundle-factory/audit/account-map";

interface Variant {
  label: string;
  bullet: string;
  paragraph: string;
}

const VARIANTS: Variant[] = [
  {
    label: "A (minimal)",
    bullet: "Curated and assembled by Salutem Solutions LLC as a gift basket.",
    paragraph:
      "This gift basket is curated and assembled by Salutem Solutions LLC. The included items are packaged by their original manufacturers.",
  },
  {
    label: "B (shorter)",
    bullet: "Assembled by Salutem Solutions LLC as a gift basket.",
    paragraph:
      "Assembled by Salutem Solutions LLC. Each item is packaged by its original manufacturer.",
  },
  {
    label: "C (no LLC)",
    bullet: "Gift basket curated by Salutem Solutions.",
    paragraph:
      "This is a curated gift basket. Each included item is packaged by its original manufacturer.",
  },
];

async function main() {
  // Pick a known-failed AMZCOM row to probe against.
  const r = await prisma.listingRemediation.findFirst({
    where: { audit_result: { scan_id: "cmpaisoq80000wlfz4llxuo5k", account: "AMZCOM" } },
    include: { audit_result: { select: { asin: true, sku: true, account: true, title: true } } },
    orderBy: { audit_result_id: "asc" },
  });
  if (!r || !r.new_bullets || !r.new_description) {
    throw new Error("no plan row with Claude content found");
  }
  const sku = r.audit_result.sku!;
  const acct = r.audit_result.account as AccountKey;
  const storeIdx = storeIndexFor(acct);
  const sellerId = await getMerchantToken(storeIdx);
  const live = await getListing(storeIdx, sellerId, sku);
  const productType = live.summaries?.find(s => s.marketplaceId === MARKETPLACE_ID)?.productType || "PRODUCT";

  // Strip the prior Option-C disclaimer to get clean Claude content.
  const allBullets = JSON.parse(r.new_bullets) as string[];
  const claudeBullets = allBullets.slice(0, -1);
  const claudeDesc = (r.new_description ?? "")
    .replace(/\n\nAbout this gift basket:[\s\S]*$/, "")
    .trim();

  console.log(`Probing ${r.audit_result.asin} (${r.audit_result.account}, productType=${productType})`);
  console.log(`Claude content: ${claudeBullets.length} bullets, desc ${claudeDesc.length} chars\n`);

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
      const issues = invalid
        ? (res.issues ?? []).map((i: { attributeNames?: string[]; code?: string }) => `${i.attributeNames?.join(",")}: ${i.code}`).join(" | ")
        : "";
      console.log(`[${label}] status=${res?.status} ${issues}`);
    } catch (e) {
      console.log(`[${label}] ERROR ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Baseline — Claude only, should pass cleanly.
  await probe("0. Claude ONLY (baseline)", claudeBullets, claudeDesc);

  for (const v of VARIANTS) {
    await probe(
      `${v.label} bullet only`,
      [...claudeBullets, v.bullet],
      claudeDesc,
    );
    await probe(
      `${v.label} desc only`,
      claudeBullets,
      `${claudeDesc}\n\n${v.paragraph}`,
    );
    await probe(
      `${v.label} BOTH`,
      [...claudeBullets, v.bullet],
      `${claudeDesc}\n\n${v.paragraph}`,
    );
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
