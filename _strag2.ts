import { readFileSync } from "node:fs";
for (const f of [".env",".env.local"]) { let t=""; try{t=readFileSync(f,"utf8");}catch{continue;} for (const l of t.split("\n")){const m=l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if(m) process.env[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,"");} }
async function main(){
  const { createClient } = await import("@libsql/client");
  const vision = await import("./src/lib/sourcing/vision.ts");
  const { unwrangleSearch } = await import("./src/lib/sourcing/retail-fetch.ts");
  const { composeTiledMainImage, fetchImageBuffer, highResImageUrl } = await import("./src/lib/walmart/multipack/composite.ts");
  const { uploadToR2, multipackImageKey } = await import("./src/lib/walmart/multipack/r2.ts");
  const db=createClient({url:process.env.TURSO_DATABASE_URL!,authToken:process.env.TURSO_AUTH_TOKEN});
  const STAMP="strag2";
  const productName=(t:string)=>String(t||"").replace(/\s*—.*$/,"").trim();
  const cleanQuery=(t:string)=>productName(t).replace(/^\s*\d+\s*x-?\s*/i,"").replace(/\bloaf\b/ig,"").replace(/,.*$/,"").replace(/\s{2,}/g," ").trim();
  const norm=(s:string)=>s.toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(w=>w.length>=3);
  const overlap=(a:string,b:string)=>{const A=new Set(norm(a)),B=new Set(norm(b));if(!A.size)return 0;let n=0;for(const w of A)if(B.has(w))n++;return n/A.size;};
  const SKUS=["FaisalX-1242","FaisalX-1243","FaisalX-1267","FaisalX-1269"];
  const rows=(await db.execute(`SELECT sku,newTitle,packCount,mainImageUrl FROM WalmartListingRemediation WHERE sku IN (${SKUS.map(()=>"?").join(",")}) AND mainImageUrl LIKE '%-f50%'`,SKUS)).rows as any[];
  const groups=new Map<string,any[]>(); for(const r of rows){const k=cleanQuery(r.newTitle).toLowerCase(); if(!groups.has(k))groups.set(k,[]); groups.get(k)!.push(r);}
  const out:any[]=[];
  for(const members of groups.values()){
    const gTitle=productName(members[0].newTitle); const q=cleanQuery(members[0].newTitle);
    console.log(`\n=== ${gTitle}  (query "${q}")`);
    let donorUrl:string|null=null, src="";
    const cand:{url:string,title:string,s:number}[]=[];
    for(const ret of ["samsclub","target","costco"] as const){
      try{ const r=await unwrangleSearch(ret,q); for(const o of r.offers) if(o.imageUrls[0]) cand.push({url:o.imageUrls[0],title:o.title||"",s:overlap(gTitle,o.title||"")}); console.log(`  ${ret}: ${r.offers.length} offers`);}catch(e:any){console.log(`  ${ret}: ERR ${String(e?.message||e).slice(0,30)}`);}
    }
    cand.sort((a,b)=>b.s-a.s);
    console.log(`  top cands: ${cand.slice(0,3).map(c=>`${c.title.slice(0,30)}(${c.s.toFixed(2)})`).join(" | ")}`);
    for(const c of cand.slice(0,5)){ if(c.s<0.45) break; const id=await vision.frontMatchesListing(highResImageUrl(c.url),gTitle); console.log(`    "${c.title.slice(0,30)}" → ${id.match?"MATCH":"no:"+id.reason.slice(0,26)}`); if(id.match){donorUrl=c.url; src=`unwrangle`; break;} }
    for(const row of members){
      const rec:any={sku:row.sku,title:gTitle,pack:Number(row.packCount)||0,before:row.mainImageUrl,after:null,src,note:""};
      if(donorUrl){ try{ const base=await fetchImageBuffer(highResImageUrl(donorUrl)); const tileUrl=await uploadToR2(await composeTiledMainImage(base,rec.pack),multipackImageKey(row.sku,"main",STAMP)); const v=await vision.verifyMainImage(tileUrl,rec.pack); if(v.ok)rec.after=tileUrl; else rec.note=`verify ${v.kind}`;}catch(e:any){rec.note=String(e?.message||e).slice(0,40);} }
      else rec.note="реального 1P фото нет → Tier4 (генерация)";
      out.push(rec); console.log(`   ${row.sku} → ${rec.after?"REAL ✓ "+src:rec.note}`);
    }
  }
  const esc=(s:string)=>String(s||"").replace(/[<>&]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]!));
  const html=`<!doctype html><meta charset=utf8><body style="background:#0b0d10;font-family:system-ui;max-width:1000px;margin:0 auto;padding:24px"><h1 style="color:#fff">Сироты через Sam's Club/Target</h1>${out.map(r=>`<div style="border:1px solid #333;border-radius:10px;padding:14px;margin:12px 0;background:#0f1115"><div style="color:#e5e7eb;font-weight:700">${esc(r.sku)} · pack ${r.pack} <span style="color:${r.after?"#22c55e":"#f59e0b"}">${r.after?"РЕАЛЬНОЕ ✓ "+esc(r.src):esc(r.note)}</span></div><div style="color:#9ca3af;margin:4px 0 8px">${esc(r.title)}</div><div style="display:flex;gap:16px"><div><div style="color:#ef4444;font-size:12px">БЫЛО</div><img src="${esc(r.before)}" style="width:280px;height:280px;object-fit:contain;background:#fff;border-radius:6px"></div><div><div style="color:#22c55e;font-size:12px">СТАЛО</div>${r.after?`<img src="${esc(r.after)}" style="width:280px;height:280px;object-fit:contain;background:#fff;border-radius:6px">`:`<div style="width:280px;height:280px;background:#1f2937;color:#9ca3af;display:flex;align-items:center;justify-content:center;border-radius:6px;text-align:center;padding:8px">${esc(r.note)}</div>`}</div></div></div>`).join("")}</body>`;
  const gu=await uploadToR2(Buffer.from(html),`walmart-review/strag2-${STAMP}.html`,"text/html");
  console.log(`\nREAL: ${out.filter(r=>r.after).length}/${out.length}  GALLERY: ${gu}`);
  db.close();
}
main().catch(e=>{console.error(e);process.exit(1);});
