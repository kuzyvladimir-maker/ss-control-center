import { readFileSync } from "node:fs";
for (const f of [".env",".env.local"]) { let t=""; try{t=readFileSync(f,"utf8")}catch{continue} for(const l of t.split("\n")){const m=l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if(m) process.env[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,"")} }
process.env.SS_VISION_PROVIDER="auto";
async function main(){
  const vision = await import("./src/lib/sourcing/vision.ts");
  const url = "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/walmart-multipack/FaisalX-1858/main-jarritosfix.png";
  let v:any=null; for(let a=0;a<4;a++){ v=await vision.qualifyTiledMain(url,"Jarritos Mineragua Sparkling Water 1.5 Liter Bottle",6); if(!/error/i.test(v.reason)) break; await new Promise(z=>setTimeout(z,2500*(a+1))); }
  console.log(`x6 -> pass=${v.pass} identity=${v.identity} eachCellSingle=${v.eachCellSingle} countOk=${v.countOk} front=${v.front} whiteBg=${v.whiteBg}`);
  console.log("reason:", v.reason);
}
main().catch(e=>{console.error(String(e?.message||e));process.exit(1);});
