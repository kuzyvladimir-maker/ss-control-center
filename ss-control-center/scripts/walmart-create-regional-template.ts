// Create "Regional Fast" template (UNASSIGNED): FL+GA+AL+SC @ 3-day, rest of
// 48 states @ 4-day (both valid on STANDARD). Clones Default's real region
// codes + partitions. Safe/deletable; assigns no items. Idempotent.
//   npx tsx scripts/walmart-create-regional-template.ts
import "dotenv/config";
import { getWalmartClient } from "@/lib/walmart/client";
/* eslint-disable @typescript-eslint/no-explicit-any */
const FAST = new Set(["FL","GA","AL","SC"]);
function partition(regions:any[], set:Set<string>, mode:"keep"|"remove"):any[]{
  return (regions??[]).map((r)=>{
    const subRegions=(r.subRegions??[]).map((sr:any)=>({...sr, states:(sr.states??[]).filter((s:any)=> mode==="keep"?set.has(s.stateCode):!set.has(s.stateCode))})).filter((sr:any)=>(sr.states??[]).length>0);
    return {...r, states:(r.states??[]).filter((s:any)=> mode==="keep"?set.has(s.stateCode):!set.has(s.stateCode)), subRegions};
  }).filter((r)=>(r.subRegions??[]).length>0||(r.states??[]).length>0);
}
(async()=>{
  const c = getWalmartClient(1);
  const list:any=(await c.requestRaw("GET","/settings/shipping/templates")).body;
  if((list.shippingTemplates??[]).find((t:any)=>t.name==="Regional Fast")){ console.log("already exists"); return; }
  const def=(list.shippingTemplates??[]).find((t:any)=>t.type==="DEFAULT");
  const d:any=(await c.requestRaw("GET",`/settings/shipping/templates/${def.id}`)).body;
  const std=(d.shippingMethods??[]).find((m:any)=>m.shipMethod==="STANDARD");
  const base=std.configurations[0];
  const body={ name:"Regional Fast", type:"CUSTOM", rateModelType:"PER_SHIPMENT_PRICING", status:"ACTIVE",
    shippingMethods:[{ shipMethod:"STANDARD", status:"ACTIVE", configurations:[
      { regions:partition(base.regions,FAST,"keep"), addressTypes:base.addressTypes??["STREET"], transitTime:3, perShippingCharge:base.perShippingCharge, tieredShippingCharges:[] },
      { regions:partition(base.regions,FAST,"remove"), addressTypes:base.addressTypes??["STREET"], transitTime:4, perShippingCharge:base.perShippingCharge, tieredShippingCharges:[] },
    ]}]};
  const res=await c.requestRaw("POST","/settings/shipping/templates",{body, headers:{"Content-Type":"application/json"}});
  console.log(`→ POST ${res.status}`); if(!res.ok){ console.log(JSON.stringify(res.body)?.slice(0,500)); return; }
  const l2:any=(await c.requestRaw("GET","/settings/shipping/templates")).body;
  const mine=(l2.shippingTemplates??[]).find((t:any)=>t.name==="Regional Fast");
  const det:any=(await c.requestRaw("GET",`/settings/shipping/templates/${mine.id}`)).body;
  for(const cf of det.shippingMethods?.[0]?.configurations??[]){
    const states=(cf.regions??[]).flatMap((r:any)=>(r.subRegions??[]).flatMap((sr:any)=>(sr.states??[]).map((s:any)=>s.stateCode)));
    console.log(`  transit=${cf.transitTime}d — ${states.length} states${cf.transitTime===3?" ["+states.join(",")+"]":""}`);
  }
  console.log(`✅ Created "Regional Fast" id=${mine.id} (UNASSIGNED)`);
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR:",e.message);process.exit(1)});
