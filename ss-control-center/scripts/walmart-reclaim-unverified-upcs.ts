/**
 * Give back the product IDs we retired without asking.
 *
 * Until 2026-08-05 the poller quarantined a number whenever Walmart said
 * "product ID already exists". Walmart says that about numbers it does not
 * have: `756441906103` was retired that way while the catalog returned zero
 * items for it. Every number retired on the error alone is therefore suspect.
 *
 * This asks Walmart about each of them and returns the free ones to the pool.
 * Numbers a real item owns keep their quarantine, and their note is corrected
 * to name that item. Read-only unless --apply.
 */

import { prisma } from "../src/lib/prisma";
import { checkUpcAvailability } from "../src/lib/bundle-factory/walmart-upc-availability";

const APPLY = process.argv.includes("--apply");

/** The note the old poller wrote. Numbers retired after a live catalog check
 * say UPC_TAKEN_IN_WALMART_CATALOG instead and are left alone. */
const UNVERIFIED_NOTE = "UPC_COLLISION";

async function main(): Promise<void> {
  const suspects = await prisma.uPCPool.findMany({
    where: { status: "QUARANTINED", notes: { contains: UNVERIFIED_NOTE } },
    select: { id: true, upc: true, notes: true },
    orderBy: { acquired_at: "asc" },
  });
  console.log(`${suspects.length} product ID(s) retired without a catalog check\n`);

  let freed = 0;
  let confirmed = 0;
  let unknown = 0;

  for (const row of suspects) {
    const availability = await checkUpcAvailability(row.upc);
    if (!availability.checked) {
      unknown += 1;
      console.log(`  ${row.upc}  could not ask Walmart — left quarantined`);
      continue;
    }
    if (availability.taken) {
      confirmed += 1;
      console.log(`  ${row.upc}  really taken by item ${availability.existingItemId}`);
      if (APPLY) {
        const note = `${new Date().toISOString()} UPC_TAKEN_IN_WALMART_CATALOG: `
          + `re-checked — item ${availability.existingItemId} owns this product ID`;
        await prisma.uPCPool.update({
          where: { id: row.id },
          data: { notes: row.notes ? `${row.notes}\n${note}` : note },
        });
      }
      continue;
    }
    freed += 1;
    console.log(`  ${row.upc}  FREE in Walmart's catalog — returning to the pool`);
    if (APPLY) {
      // A listing may still point at this pool row. Returning it as unassigned
      // would let a second listing take a number the first one still carries,
      // so a held number goes back to ASSIGNED, not AVAILABLE.
      const holder = await prisma.channelSKU.findFirst({
        where: { upc_pool_id: row.id },
        select: { id: true },
      });
      const note = `${new Date().toISOString()} RECLAIMED: Walmart's catalog has no `
        + "item using this product ID; the earlier refusal was not about the number.";
      await prisma.uPCPool.update({
        where: { id: row.id },
        data: {
          status: holder ? "ASSIGNED" : "AVAILABLE",
          assigned_to_id: holder?.id ?? null,
          notes: row.notes ? `${row.notes}\n${note}` : note,
        },
      });
    }
  }

  console.log(
    `\n${freed} free${APPLY ? " and returned to the pool" : " (dry run — pass --apply)"}, `
    + `${confirmed} genuinely taken, ${unknown} unanswerable.`,
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
