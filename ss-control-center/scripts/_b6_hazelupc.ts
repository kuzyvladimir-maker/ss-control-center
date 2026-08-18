import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { spApiGet, MARKETPLACE_ID } from "../src/lib/amazon-sp-api/client";
async function main() {
  for (const asin of ["B07WGFCP9M", "B07WGF6VVG", "B0055DGZ5G"]) {
    try {
      const res = (await spApiGet(`/catalog/2022-04-01/items/${asin}`, {
        storeId: "store1",
        params: { marketplaceIds: MARKETPLACE_ID, includedData: "summaries,identifiers,attributes" },
      })) as any;
      const s = res.summaries?.[0];
      const ids = res.identifiers?.[0]?.identifiers ?? [];
      const upc = ids.find((x: any) => /^(UPC|EAN|GTIN)$/i.test(x.identifierType))?.identifier;
      const attrUpc = res.attributes?.externally_assigned_product_identifier
        ?.map((x: any) => `${x.type}:${x.value}`).join(", ");
      console.log(`${asin} | ${upc ?? "—"} | attr ${attrUpc ?? "—"} | ${(s?.itemName ?? "").slice(0, 66)}`);
    } catch (e: any) { console.log(`${asin} ✗ ${String(e?.message).slice(0, 70)}`); }
    await new Promise((r) => setTimeout(r, 1200));
  }
}
main();
