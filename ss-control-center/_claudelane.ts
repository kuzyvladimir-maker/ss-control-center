import { readFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t=""; try{t=readFileSync(f,"utf8");}catch{continue;} for (const l of t.split("\n")){const m=l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if(m) process.env[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,"");}}
process.env.SS_VISION_PROVIDER = "claude"; // force the Claude CLI lane
async function main(){
  const vision = await import("./src/lib/sourcing/vision.ts");
  const url = "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/walmart-multipack/smoke-4/main-smoke.png";
  const t0=Date.now();
  const v = await vision.qualifyTiledMain(url, "Cheez-It Extra Cheesy Cheese Crackers, Baked Snack Crackers, 12.4 oz (Pack of 4)", 4);
  console.log(`claude-lane qualifyTiledMain (${Date.now()-t0}ms):`, JSON.stringify(v));
}
main().catch(e=>{console.error(e);process.exit(1);});
