import { readFileSync } from "node:fs";
for (const f of [".env",".env.local"]) { let t=""; try{t=readFileSync(f,"utf8")}catch{continue} for(const l of t.split("\n")){const m=l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if(m) process.env[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,"")} }
process.env.SS_VISION_PROVIDER="auto";
async function main(){
  const vision = await import("./src/lib/sourcing/vision.ts");
  const b = JSON.parse(readFileSync("_bannercheck_state.json","utf8"));
  const nv = Object.values(b).filter((x:any)=>x.clean===false && x.what==="no verdict").slice(0,2);
  const prompt = `This is a marketplace MAIN image: one product package tiled several times on white.
Answer STRICT JSON: {"clean": true|false, "what": "<=10 words>"}.
"clean" = the image shows ONLY the physical product package(s). Answer FALSE if there are promotional/marketing graphics that are NOT part of the physical package itself.`;
  for (const x of nv as any[]){
    const j = await vision.askVisionJson([x.url], prompt);
    console.log(x.sku, "raw:", JSON.stringify(j)?.slice(0,300));
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
