import { readFileSync } from "node:fs";
for (const f of [".env", ".env.local"]) { let t=""; try{t=readFileSync(f,"utf8");}catch{continue;} for (const l of t.split("\n")){const m=l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if(m) process.env[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,"");}}
async function main(){
  const vision = await import("./src/lib/sourcing/vision.ts");
  const { oxylabsWalmartSearch } = await import("./src/lib/sourcing/oxylabs-fetch.ts");
  const { highResImageUrl } = await import("./src/lib/walmart/multipack/composite.ts");
  const norm=(s:string)=>new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(w=>w.length>=3));
  const overlap=(a:string,b:string)=>{const A=norm(a),B=norm(b);if(!A.size)return 0;let n=0;for(const w of A)if(B.has(w))n++;return n/A.size;};
  const titles=["Cheez-It Extra Cheesy Cheese Crackers, Baked Snack Crackers, 12.4 oz (Pack of 4)","Gatorade Thirst Quencher, Lemon Lime Sports Drinks, 28 fl oz, (Pack of 8)"];
  const run=async(url:string,title:string,prov:string,model?:string)=>{process.env.SS_VISION_PROVIDER=prov; if(model)process.env.GEMINI_VISION_MODEL=model; const t0=Date.now(); const v=await vision.qualifyDonorFront(highResImageUrl(url),title,vision.unitSizeFromTitle(title)); return {v,ms:Date.now()-t0};};
  let agreePro=0,agreeFlash=0,total=0;
  for(const title of titles){
    console.log(`\n=== ${title}`);
    const {offers}=await oxylabsWalmartSearch(title.replace(/\(pack of \d+\)/ig,"").replace(/,.*$/,"").trim());
    const cands=offers.filter(o=>o.isMarketplaceItem!==true&&o.imageUrls[0]).map(o=>({u:o.imageUrls[0],s:overlap(title,o.title||"")})).sort((a,b)=>b.s-a.s).slice(0,3);
    for(const c of cands){
      const s=await run(c.u,title,"anthropic");
      const p=await run(c.u,title,"gemini","gemini-2.5-pro");
      const fl=await run(c.u,title,"gemini","gemini-2.5-flash");
      const okP=s.v.pass===p.v.pass, okF=s.v.pass===fl.v.pass; agreePro+=okP?1:0; agreeFlash+=okF?1:0; total++;
      const f=(v:any)=>`${v.pass?"PASS":"rej"}[s${+v.singleUnit}]`;
      console.log(`  Sonnet ${f(s.v)}(${s.ms}ms) | Pro ${f(p.v)}(${p.ms}ms)${okP?"✓":" DIFF"} | Flash ${f(fl.v)}(${fl.ms}ms)${okF?"✓":" DIFF"}`);
      if(!okP||!okF) console.log(`     S:${s.v.reason} | P:${p.v.reason} | F:${fl.v.reason}`);
    }
  }
  console.log(`\nPARITY vs Sonnet: Pro ${agreePro}/${total} · Flash ${agreeFlash}/${total}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
