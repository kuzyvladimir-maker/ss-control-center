// Поиск ЧИСТОГО фото десяток клубники и малины по сетям вне нашего каталога.
// Каждый кандидат проходит тот же машинный отсев, что и остальная художка.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { writeFileSync } from "node:fs";
import { screenPackageArt } from "../src/lib/bundle-factory/audit/package-art-screen";

const CANDIDATES: { flavor: string; titleName: string; size: number; source: string; urls: string[] }[] = [
  {
    flavor: "Peanut Butter & Strawberry Jam", titleName: "Strawberry Jam", size: 10,
    source: "shoppersfood",
    urls: [
      "https://www.instacart.com/assets/domains/product-image/file/large_08388c9b-9cbb-4bab-abdf-ab55ce4514be.jpg",
      "https://www.instacart.com/assets/domains/product-image/file/large_a042bc6c-f0ee-4ebe-8bc1-7fdabae400e1.jpg",
      "https://www.instacart.com/assets/domains/product-image/file/large_caa8b2c1-a118-45bc-86d9-b47db6f5a93c.jpg",
      "https://www.instacart.com/assets/domains/product-image/file/large_e5397efe-c0ea-468b-8a8f-23f5b3fdb9f7.jpg",
    ],
  },
  {
    flavor: "Peanut Butter & Raspberry Spread", titleName: "Raspberry", size: 10,
    source: "wegmans",
    urls: [
      "https://images.wegmans.com/is/image/wegmanscsprod/958278_PrimaryImage?v=471b063d324b61894e7e330eaad90a760758dc51",
    ],
  },
];

async function main() {
  const winners: any[] = [];
  for (const c of CANDIDATES) {
    console.log(`\n${c.titleName} ${c.size}шт — ${c.urls.length} кандидатов (${c.source})`);
    for (const url of c.urls) {
      const v = await screenPackageArt({ image_url: url, expectedFlavor: c.titleName, expectedCount: c.size });
      if (v.clean) {
        console.log(`  ✓ ЧИСТОЕ: ${url.slice(0, 80)}`);
        console.log(`    ${String(v.observed?.notes ?? "").slice(0, 120)}`);
        winners.push({ ...c, url });
        break;
      }
      console.log(`  ✗ ${v.reasons.join("; ").slice(0, 110)}`);
    }
  }
  writeFileSync("data/batch300/found10.json", JSON.stringify(winners, null, 1));
  console.log(`\nнайдено чистых: ${winners.length} из ${CANDIDATES.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
