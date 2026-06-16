/** Diagnose which stores actually have Uncrustable listings + why a report was empty. */
import "dotenv/config";
import { requestAndWaitForReport } from "@/lib/amazon-sp-api/reports";

const stores = (process.argv[2]?.split(",") ?? ["store2", "store3"]).map((s) => s.trim());

async function main() {
  for (const store of stores) {
    try {
      console.log(`\n=== ${store} ===`);
      const tsv = await requestAndWaitForReport(store, "GET_MERCHANT_LISTINGS_ALL_DATA", 1, 8 * 60 * 1000);
      const lines = tsv.split(/\r?\n/).filter(Boolean);
      console.log(`rows (incl header): ${lines.length}`);
      const header = (lines[0] ?? "").split("\t").map((h) => h.trim().toLowerCase());
      const iName = header.indexOf("item-name");
      const iPrice = header.indexOf("price");
      const iStatus = header.indexOf("status");
      console.log(`item-name col idx: ${iName}, price idx: ${iPrice}, status idx: ${iStatus}`);
      console.log(`header: ${header.slice(0, 8).join(" | ")} ...`);
      let unc = 0;
      const samples: string[] = [];
      for (const l of lines.slice(1)) {
        const c = l.split("\t");
        const name = c[iName] ?? "";
        if (/uncrustable/i.test(name)) {
          unc++;
          if (samples.length < 5) samples.push(`${name.slice(0, 50)} | $${c[iPrice]} | ${c[iStatus] ?? ""}`);
        }
      }
      console.log(`Uncrustable listings: ${unc}`);
      samples.forEach((s) => console.log("  " + s));
      // also show 3 generic sample names to confirm report is populated
      console.log("first 3 item-names:");
      lines.slice(1, 4).forEach((l) => console.log("  " + (l.split("\t")[iName] ?? "").slice(0, 60)));
    } catch (e: any) {
      console.log(`${store} FAILED: ${e?.message}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
