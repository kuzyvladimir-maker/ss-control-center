import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
import { costOneSku } from "@/lib/sourcing/cogs-engine";
(async () => {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  for (const sku of ["742259724404", "743269736739", "742259726323"]) {
    const t0 = Date.now();
    const r: any = await costOneSku(db, { sku, channel: "amazon" });
    const line = String((r.logs || []).find((l: string) => String(l).includes("→")) || "").trim();
    console.log(`${sku}: ${r.status} (${((Date.now()-t0)/1000).toFixed(0)}s) ${r.status === "costed" ? `$${r.total} [${(r.methods||[]).join(",")}]${r.needsReview?" review":""}` : ""}`);
    if (line) console.log(`   ${line.slice(line.indexOf("→")).slice(0, 90)}`);
  }
  process.exit(0);
})();
