import { readFileSync } from "node:fs";
for (const f of [".env",".env.local"]) { let t=""; try{t=readFileSync(f,"utf8");}catch{continue;} for (const l of t.split("\n")){const m=l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if(m) process.env[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,"");} }
throw new Error("LEGACY_METERED_SCRIPT_DISABLED: _gen.ts has unbounded direct Oxylabs calls; migrate it to guarded provider adapters before reuse");
async function main(){
  const { createClient } = await import("@libsql/client");
  const sharp=(await import("sharp")).default;
  const vision = await import("./src/lib/sourcing/vision.ts");
  const { generateImagePngViaCodex } = await import("./src/lib/image-gen/codex-worker.ts");
  const { uploadToR2, multipackImageKey } = await import("./src/lib/walmart/multipack/r2.ts");
  const db=createClient({url:process.env.TURSO_DATABASE_URL!,authToken:process.env.TURSO_AUTH_TOKEN});
  const STAMP="gen1";
  const u=(process.env.OXYLABS_USERNAME||"").replace(/^['"]|['"]$/g,""); const p=(process.env.OXYLABS_PASSWORD||"").replace(/^['"]|['"]$/g,""); const auth=Buffer.from(`${u}:${p}`).toString("base64");
  async function gshopImg(q:string):Promise<{b64:string,title:string}|null>{const c=new AbortController();const t=setTimeout(()=>c.abort(),90000);try{const r=await fetch("https://realtime.oxylabs.io/v1/queries",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Basic ${auth}`},body:JSON.stringify({source:"google_shopping_search",query:q,parse:true}),signal:c.signal});const j:any=await r.json();const raw=j?.results?.[0]?.content?.results?.organic||j?.results?.[0]?.content?.results||[];const arr=(Array.isArray(raw)?raw:Object.values(raw||{})) as any[];const norm=(s:string)=>new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(w=>w.length>=3));const A=norm(q);const sc=(b:string)=>{const B=norm(b);let n=0;for(const w of A)if(B.has(w))n++;return n/(A.size||1);};const best=arr.map(x=>({title:String(x.title||""),b64:String(x.thumbnail||x.image||""),s:sc(String(x.title||""))})).filter(x=>x.b64.startsWith("data:image")&&!/pack of \d+/i.test(x.title)).sort((a,b)=>b.s-a.s)[0];return best?{b64:best.b64,title:best.title}:null;}finally{clearTimeout(t);}}

  const SKUS=["FaisalX-1267","FaisalX-1269"];
  const rows=(await db.execute(`SELECT sku,newTitle,packCount,mainImageUrl FROM WalmartListingRemediation WHERE sku IN (${SKUS.map(()=>"?").join(",")}) AND mainImageUrl LIKE '%-f50%'`,SKUS)).rows as any[];
  const out:any[]=[];
  for(const row of rows){
    const title=String(row.newTitle||"").replace(/\s*—.*$/,"").trim(); const pack=Number(row.packCount)||0;
    const rec:any={sku:row.sku,title,pack,before:row.mainImageUrl,after:null,note:""};
    console.log(`\n=== ${row.sku} ${title} (pack ${pack})`);
    let refUrl:string|undefined;
    try{ const g=await gshopImg(title.replace(/^\s*\d+\s*x-?\s*/i,"")); if(g){ const png=await sharp(Buffer.from(g.b64.slice(g.b64.indexOf(",")+1),"base64")).png().toBuffer(); refUrl=await uploadToR2(png,`walmart-multipack/${row.sku}/ref-${STAMP}.png`); console.log(`  ref: "${g.title.slice(0,40)}" -> ${refUrl.slice(-30)}`);} }catch(e:any){console.log(`  ref err ${String(e?.message||e).slice(0,40)}`);}
    const prompt=`Professional e-commerce product photo on a pure white background (RGB 255,255,255). Show EXACTLY ${pack} identical units of this exact retail product — ${title} — arranged in a clean grid, every unit UPRIGHT and front-facing with its REAL brand label clearly visible and readable. Reproduce the packaging${refUrl?" in the reference image":""} faithfully; do NOT invent, translate, or alter any text or logos. The ${pack} packages together fill about 95% of the square frame, as large as possible. No people, no props, no prepared food, no serving dishes, no nutrition panels, no added text or graphics.`;
    try{
      const gen=await generateImagePngViaCodex({prompt,size:"2200x2200",referenceUrls:refUrl?[refUrl]:undefined,timeoutMs:240000});
      if(!gen.png){ rec.note=`генерация не удалась: ${gen.error||(gen.not_configured?"worker not configured":"no png")}`; }
      else{ const mainUrl=await uploadToR2(gen.png,multipackImageKey(row.sku,"main",STAMP)); const id=await vision.frontMatchesListing(mainUrl,title); const v=await vision.verifyMainImage(mainUrl,pack); rec.after=mainUrl; rec.note=`сгенерено · identity=${id.match?"ok":"?"+id.reason.slice(0,20)} · verify=${v.ok?"ok":v.kind}`; }
    }catch(e:any){ rec.note=`ошибка: ${String(e?.message||e).slice(0,60)}`; }
    console.log(`  → ${rec.after?"GENERATED "+rec.note:rec.note}`);
    out.push(rec);
  }
  const esc=(s:string)=>String(s||"").replace(/[<>&]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]!));
  const html=`<!doctype html><meta charset=utf8><body style="background:#0b0d10;font-family:system-ui;max-width:1000px;margin:0 auto;padding:24px"><h1 style="color:#fff">Tier-4 генерация (Codex) — QC</h1>${out.map(r=>`<div style="border:1px solid #333;border-radius:10px;padding:14px;margin:12px 0;background:#0f1115"><div style="color:#e5e7eb;font-weight:700">${esc(r.sku)} · pack ${r.pack} <span style="color:${r.after?"#22c55e":"#ef4444"}">${esc(r.note)}</span></div><div style="color:#9ca3af;margin:4px 0 8px">${esc(r.title)}</div><div style="display:flex;gap:16px"><div><div style="color:#ef4444;font-size:12px">БЫЛО</div><img src="${esc(r.before)}" style="width:280px;height:280px;object-fit:contain;background:#fff;border-radius:6px"></div><div><div style="color:#22c55e;font-size:12px">СГЕНЕРЕНО</div>${r.after?`<img src="${esc(r.after)}" style="width:280px;height:280px;object-fit:contain;background:#fff;border-radius:6px">`:`<div style="width:280px;height:280px;background:#1f2937;color:#9ca3af;display:flex;align-items:center;justify-content:center;border-radius:6px;text-align:center;padding:8px">${esc(r.note)}</div>`}</div></div></div>`).join("")}</body>`;
  const gu=await uploadToR2(Buffer.from(html),`walmart-review/gen-${STAMP}.html`,"text/html");
  console.log(`\nGEN: ${out.filter(r=>r.after).length}/${out.length}  GALLERY: ${gu}`);
  db.close();
}
main().catch(e=>{console.error(e);process.exit(1);});
