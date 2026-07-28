import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
import { costOneSku } from "@/lib/sourcing/cogs-engine";
(async () => {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  for (const sku of ["742259724404", "742259726323", "742259729690"]) {
    const t0 = Date.now();
    const r: any = await costOneSku(db, { sku, channel: "amazon" });
    console.log(`${sku}: ${r.status} (${((Date.now()-t0)/1000).toFixed(0)}s) ${r.status === "costed" ? `$${r.total} [${(r.methods||[]).join(",")}]${r.needsReview ? " review" : ""} — ${String(r.note||"").slice(0,45)}` : ""}`);
  }
  process.exit(0);
})();
