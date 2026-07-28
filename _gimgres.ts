import { readFileSync } from "node:fs";
for (const f of [".env",".env.local"]) { let t=""; try{t=readFileSync(f,"utf8");}catch{continue;} for (const l of t.split("\n")){const m=l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if(m) process.env[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,"");} }
throw new Error("LEGACY_METERED_SCRIPT_DISABLED: _gimgres.ts has unbounded direct Oxylabs calls; migrate it to guarded provider adapters before reuse");
async function main(){
  const { createClient } = await import("@libsql/client");
  const vision = await import("./src/lib/sourcing/vision.ts");
  const { composeTiledMainImage, fetchImageBuffer, highResImageUrl } = await import("./src/lib/walmart/multipack/composite.ts");
  const { uploadToR2, multipackImageKey } = await import("./src/lib/walmart/multipack/r2.ts");
  const db=createClient({url:process.env.TURSO_DATABASE_URL!,authToken:process.env.TURSO_AUTH_TOKEN});
  const STAMP="gimg";
  const u=(process.env.OXYLABS_USERNAME||"").replace(/^['"]|['"]$/g,""); const p=(process.env.OXYLABS_PASSWORD||"").replace(/^['"]|['"]$/g,""); const auth=Buffer.from(`${u}:${p}`).toString("base64");
  async function googleImages(q:string):Promise<string[]>{const c=new AbortController();const t=setTimeout(()=>c.abort(),90000);try{const r=await fetch("https://realtime.oxylabs.io/v1/queries",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Basic ${auth}`},body:JSON.stringify({source:"google_search",query:q,parse:true,context:[{key:"tbm",value:"isch"}]}),signal:c.signal});const j:any=await r.json();const str=JSON.stringify(j?.results?.[0]?.content||{});const imgs=[...str.matchAll(/"(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/g)].map(m=>m[1]).filter(x=>!/gstatic|googleusercontent|\.gif|logo|sprite/.test(x));return [...new Set(imgs.map(x=>x.split("?")[0]))];}finally{clearTimeout(t);}}
  const SKUS=["FaisalX-1267","FaisalX-1269"];
  const rows=(await db.execute(`SELECT sku,newTitle,packCount,mainImageUrl FROM WalmartListingRemediation WHERE sku IN (${SKUS.map(()=>"?").join(",")}) AND mainImageUrl LIKE '%-f50%'`,SKUS)).rows as any[];
  const out:any[]=[];
  for(const row of rows){
    const title=String(row.newTitle||"").replace(/\s*—.*$/,"").trim(); const pack=Number(row.packCount)||0;
    const rec:any={sku:row.sku,title,pack,before:row.mainImageUrl,after:null,note:""};
    console.log(`\n=== ${row.sku} ${title}`);
    try{
      const imgs=await googleImages(title.replace(/^\s*\d+\s*x-?\s*/i,"")+" bread loaf package");
      console.log(`  google-images: ${imgs.length} real urls`);
      const pool=imgs.slice(0,16);
      const best=(await vision.pickBestFront(pool,{listingTitle:title}))?.url || await vision.pickBestFrontFromPool(pool,title);
      if(best){ const id=await vision.frontMatchesListing(highResImageUrl(best),title); console.log(`  pick ${best.slice(-40)} identity=${id.match?"MATCH":"no:"+id.reason.slice(0,24)}`);
        if(id.match){ const base=await fetchImageBuffer(highResImageUrl(best)); const tileUrl=await uploadToR2(await composeTiledMainImage(base,pack),multipackImageKey(row.sku,"main",STAMP)); const v=await vision.verifyMainImage(tileUrl,pack); if(v.ok){rec.after=tileUrl; rec.note="google-images (реальное)";} else rec.note=`verify ${v.kind}`; }
        else rec.note="best pick не прошёл identity";
      } else rec.note="google-images: чистый фронт не найден";
    }catch(e:any){ rec.note=`err ${String(e?.message||e).slice(0,50)}`; }
    console.log(`  → ${rec.after?"REAL ✓":rec.note}`);
    out.push(rec);
  }
  const esc=(s:string)=>String(s||"").replace(/[<>&]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]!));
  const html=`<!doctype html><meta charset=utf8><body style="background:#0b0d10;font-family:system-ui;max-width:1000px;margin:0 auto;padding:24px"><h1 style="color:#fff">Tier-4 Google Images — реальные фото</h1>${out.map(r=>`<div style="border:1px solid #333;border-radius:10px;padding:14px;margin:12px 0;background:#0f1115"><div style="color:#e5e7eb;font-weight:700">${esc(r.sku)} · pack ${r.pack} <span style="color:${r.after?"#22c55e":"#f59e0b"}">${esc(r.note)}</span></div><div style="color:#9ca3af;margin:4px 0 8px">${esc(r.title)}</div><div style="display:flex;gap:16px"><div><div style="color:#ef4444;font-size:12px">БЫЛО</div><img src="${esc(r.before)}" style="width:280px;height:280px;object-fit:contain;background:#fff;border-radius:6px"></div><div><div style="color:#22c55e;font-size:12px">СТАЛО</div>${r.after?`<img src="${esc(r.after)}" style="width:280px;height:280px;object-fit:contain;background:#fff;border-radius:6px">`:`<div style="width:280px;height:280px;background:#1f2937;color:#9ca3af;display:flex;align-items:center;justify-content:center;border-radius:6px;text-align:center;padding:8px">${esc(r.note)}</div>`}</div></div></div>`).join("")}</body>`;
  const gu=await uploadToR2(Buffer.from(html),`walmart-review/gimg-${STAMP}.html`,"text/html");
  console.log(`\nREAL via Google Images: ${out.filter(r=>r.after).length}/${out.length}  GALLERY: ${gu}`);
  db.close();
}
main().catch(e=>{console.error(e);process.exit(1);});
