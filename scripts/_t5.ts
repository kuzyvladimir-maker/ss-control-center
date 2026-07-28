import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { createClient } from "@libsql/client";
import { costOneSku } from "@/lib/sourcing/cogs-engine";
(async () => {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  for (const sku of ["742259724404", "742259729690", "743269736739"]) {
    const t0 = Date.now();
    try {
      const r: any = await costOneSku(db, { sku, channel: "amazon" });
      const hit = String((r.logs || []).find((l: string) => String(l).includes("hit ")) || "").trim();
      console.log(`${sku}: ${r.status} (${((Date.now()-t0)/1000).toFixed(0)}s) ${r.status === "costed" ? `$${r.total} [${(r.methods||[]).join(",")}]` : ""}`);
      console.log(`   ${hit.slice(hit.indexOf("→") >= 0 ? hit.indexOf("→") : 0).slice(0, 105)}`);
    } catch (e: any) { console.log(`${sku}: ERR ${String(e?.message).slice(0,50)}`); }
  }
  process.exit(0);
})();
