// One-off cleanup for ProductPackSizeCache after the "N ct (Pack of M)" fix.
//
// The pack-size route checks this cache BEFORE the regex, so stale AI rows
// that multiplied a contents-count into the pack ("10 ct (Pack of 6)" → 60,
// "80 Count (Pack of 4)" → 320) would keep being served. Delete any row that
// the corrected, *confident* regex now disagrees with — the route recomputes
// it correctly on the next request and re-persists as source='regex'.
//
//   npx tsx scripts/fix-packsize-cache.ts            (dry run)
//   npx tsx scripts/fix-packsize-cache.ts --apply    (actually delete)

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { createClient } from "@libsql/client";

import { parsePackSize } from "../src/lib/procurement/pack-size";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await db.execute("SELECT rawTitle, size, source FROM ProductPackSizeCache");
  let stale = 0;

  for (const r of rows.rows as any[]) {
    const regex = parsePackSize(r.rawTitle as string);
    // A confident (non-ambiguous) regex result is authoritative now.
    if (regex && !regex.ambiguous && regex.size !== r.size) {
      stale++;
      console.log(
        `${apply ? "DELETE" : "would delete"}: "${r.rawTitle}" — cached ${r.size} (${r.source}) → regex ${regex.size}`,
      );
      if (apply) {
        await db.execute({
          sql: "DELETE FROM ProductPackSizeCache WHERE rawTitle = ?",
          args: [r.rawTitle],
        });
      }
    }
  }

  console.log(
    `\nscanned ${rows.rows.length} cache rows · ${stale} stale${apply ? " (deleted)" : " (dry run — re-run with --apply)"}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
