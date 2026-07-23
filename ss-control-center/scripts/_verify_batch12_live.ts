// Post-submit verification: for each of the 9 new SKUs pull the listing from
// Amazon (summaries + issues + offers) and report ASIN / status / problems.
// Persists discovered ASINs onto ChannelSKU rows.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync } from "node:fs";

const SCRATCH = "/private/tmp/claude-501/-Users-vladimirkuznetsov-SS-Command-Center/1dbdc77d-9c20-49be-9e0d-c48b604008f6/scratchpad/";
const SELLER = "A3A7A0RDFUSGBS";

async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const li: any = await import("../src/lib/amazon-sp-api/listings");
  const getListing = li.getListing ?? li.default?.getListing;

  const rows: any[] = JSON.parse(readFileSync(SCRATCH + "publish-batch12-skus.json", "utf8"));
  for (const r of rows) {
    try {
      const res = await getListing(1, SELLER, r.sku, { includedData: ["summaries", "issues", "offers"] });
      const sum = res?.summaries?.[0] ?? {};
      const issues = (res?.issues ?? []).filter((i: any) => i.severity === "ERROR");
      const warn = (res?.issues ?? []).filter((i: any) => i.severity === "WARNING");
      const offer = res?.offers?.[0]?.price;
      console.log(
        `${issues.length ? "✗" : "✓"} ${r.sku} | asin ${sum.asin ?? "—"} | status ${(sum.status ?? []).join(",") || "—"} | ` +
        `offer ${offer ? offer.amount ?? offer.value ?? JSON.stringify(offer) : "—"} | ERR ${issues.length} WARN ${warn.length}` +
        (issues.length ? " | " + issues.map((i: any) => `${i.code}:${String(i.message).slice(0, 90)}`).join(" ; ") : ""),
      );
      if (sum.asin) {
        await prisma.channelSKU.update({ where: { id: r.channel_sku_id }, data: { asin: sum.asin } }).catch(() => {});
      }
    } catch (e: any) {
      console.log(`? ${r.sku} | ${String(e?.message ?? e).slice(0, 140)}`);
    }
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
