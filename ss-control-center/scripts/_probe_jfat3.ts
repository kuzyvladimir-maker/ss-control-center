import "./_env";
import { getListing } from "@/lib/amazon-sp-api/listings";
async function main(){
  const it: any = await getListing(1, "A3A7A0RDFUSGBS", "SZ-ASPI-JFAT", { includedData: ["summaries","attributes","issues","offers"] });
  const s = it.summaries?.[0] ?? {};
  console.log("status:", JSON.stringify(s.status), "| mainImage(summary):", JSON.stringify(s.mainImage));
  const a = it.attributes ?? {};
  console.log("main =>", a.main_product_image_locator?.[0]?.media_location);
  for (let i=1;i<=8;i++) console.log(`other_${i} =>`, a[`other_product_image_locator_${i}`]?.[0]?.media_location ?? "(none)");
  console.log("purchasable_offer:", JSON.stringify(a.purchasable_offer?.[0]?.our_price?.[0]?.schedule?.[0]?.value_with_tax), "| discounted:", JSON.stringify(a.purchasable_offer?.[0]?.discounted_price ?? null));
  console.log("offers:", JSON.stringify(it.offers ?? []).slice(0,300));
  console.log("issues:", JSON.stringify((it.issues??[]).map((i:any)=>({code:i.code,sev:i.severity,msg:i.message?.slice(0,120)}))));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
