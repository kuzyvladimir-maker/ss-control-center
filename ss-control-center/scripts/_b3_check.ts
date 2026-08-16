import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { UNCRUSTABLES_FLAVORS, validateRecipe, buildListingCopy } from "../src/lib/bundle-factory/uncrustables-box-planner";
import { resolveMergedUncrustablesPackageArt } from "../src/lib/bundle-factory/audit/uncrustables-authenticity-merged";
let bad = 0;
for (const [name, f] of Object.entries(UNCRUSTABLES_FLAVORS)) {
  const art = resolveMergedUncrustablesPackageArt(name, "retail-carton", f.cartonSize);
  if (!art) { console.log(`✗ РЕГРЕСС: ${name} — дефолт ${f.cartonSize}ct не резолвится`); bad++; }
}
console.log(bad ? `\nсломано вкусов: ${bad}` : "✓ все вкусы резолвятся по своему дефолту — старые рецепты целы");
// новая возможность: одна и та же клубника двумя фасовками
const mix = [
  { flavor: "Peanut Butter & Grape Jelly", qty: 20, cartonSize: 10 },
  { flavor: "Peanut Butter & Grape Jelly", qty: 8, cartonSize: 4 },
];
console.log("\nсмешанная раскладка 10+10+4+4 винограда = 28шт:");
console.log("  валидатор:", validateRecipe(mix).length ? validateRecipe(mix).join("; ") : "OK");
const copy = buildListingCopy(mix);
console.log("  title:", copy.title);
console.log("  коробки:", copy.bullets[1]);
