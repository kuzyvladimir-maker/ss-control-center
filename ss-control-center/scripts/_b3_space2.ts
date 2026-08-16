import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { UNCRUSTABLES_FLAVORS, rationalBandFor, RENDER_LIMITS, validateRecipe } from "../src/lib/bundle-factory/uncrustables-box-planner";
import { resolveMergedUncrustablesPackageArt } from "../src/lib/bundle-factory/audit/uncrustables-authenticity-merged";
const SIZES = [4, 8, 10, 15, 18, 24];
let total = 0;
console.log("вкус                          утверждённые фасовки   раскладок");
for (const [flavor, meta] of Object.entries(UNCRUSTABLES_FLAVORS)) {
  const ok = SIZES.filter((s) => resolveMergedUncrustablesPackageArt(flavor, "retail-carton", s));
  if (!ok.length) { console.log(`${meta.titleName.padEnd(28)} —`); continue; }
  const out: number[][] = [];
  const s = [...ok].sort((a, b) => b - a);
  const rec = (i: number, acc: number[], sum: number) => {
    if (acc.length) {
      const rows = Math.ceil(acc.length / RENDER_LIMITS.maxCartonsPerRow);
      if (sum >= 24 && sum <= 135 && rationalBandFor(sum) && rows <= RENDER_LIMITS.maxRows) out.push([...acc]);
    }
    if (sum > 135 || acc.length >= RENDER_LIMITS.maxCartons) return;
    for (let j = i; j < s.length; j++) rec(j, [...acc, s[j]], sum + s[j]);
  };
  rec(0, [], 0);
  total += out.length;
  console.log(`${meta.titleName.padEnd(28)} ${ok.join("/").padEnd(22)} ${String(out.length).padStart(5)}`);
}
console.log(`\nИТОГО ОДНОВКУСОВЫХ ЛИСТИНГОВ: ${total}`);
// проверка боем: 27 = 15+4+4+4 винограда
const r = [{ flavor: "Peanut Butter & Grape Jelly", qty: 15, cartonSize: 15 }, { flavor: "Peanut Butter & Grape Jelly", qty: 12, cartonSize: 4 }];
console.log(`\nваш пример 27 = 15 + 4+4+4 винограда: ${validateRecipe(r).length ? validateRecipe(r).join("; ") : "валидно"}`);
