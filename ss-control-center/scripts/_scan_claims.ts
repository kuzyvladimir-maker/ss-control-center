// READ-ONLY audit: find listings whose bullets/description contain sale,
// shipping or availability claims. Amazon's PDP policy forbids these (they are
// the "false claims" half of error 99300) — but the classifier is inconsistent,
// so some slip through to LIVE and can be flagged retroactively.
//
//   npx tsx scripts/_scan_claims.ts
//
// Rule 8 now blocks these at generation time (SALE_SHIPPING_CLAIM_BANNED); this
// script surfaces the ones that were published before that guard existed.
// Mutates nothing.
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { SALE_SHIPPING_CLAIM_BANNED_LOWER } = await import("@/lib/bundle-factory/compliance/banned-words");

  const hitsIn = (text: string): string[] => {
    const l = (text || "").toLowerCase();
    return SALE_SHIPPING_CLAIM_BANNED_LOWER.filter((p) => l.includes(p));
  };

  const skus = await prisma.channelSKU.findMany({
    select: { sku: true, title: true, bullets: true, description: true, listing_status: true },
  });

  let flagged = 0;
  for (const s of skus) {
    let bullets: string[] = [];
    try { bullets = JSON.parse(s.bullets || "[]"); } catch { /* ignore */ }
    const bulletHits = bullets.flatMap((b, i) => hitsIn(b).map((p) => ({ where: `bullet[${i}]`, phrase: p, text: b })));
    const descHits = hitsIn(s.description || "").map((p) => ({ where: "description", phrase: p, text: s.description || "" }));
    const all = [...bulletHits, ...descHits];
    if (!all.length) continue;
    flagged++;
    console.log(`\n⚠ ${s.sku} [${s.listing_status}] ${s.title?.slice(0, 50)}`);
    for (const h of all) console.log(`   ${h.where}: "${h.phrase}" → ${h.text.slice(0, 100)}`);
  }
  console.log(`\nscanned ${skus.length} SKUs → ${flagged} contain sale/shipping/availability claims`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
