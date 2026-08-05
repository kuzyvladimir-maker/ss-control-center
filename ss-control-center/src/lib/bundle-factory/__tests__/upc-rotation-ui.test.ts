import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

test("a dead product ID is repairable from the row, exactly once", async () => {
  const route = await read(
    "../../../app/api/bundle-factory/skus/[id]/rotate-upc/route.ts",
  );
  // One replacement is a repair. On 2026-08-05 the same SKU collided twice with
  // two different fresh numbers, so a button that keeps rotating would feed the
  // pool into a hole.
  assert.match(route, /MAX_UPC_ROTATIONS_PER_LISTING = 1/u);
  assert.match(route, /ROTATION_LIMIT_REACHED/u);
  assert.match(route, /countBurnedUpcsForSku/u);
  // Never a silent success: a refusal explains itself.
  assert.match(route, /needs a look at its payload/u);

  const table = await read("../../../components/bundle-factory/DraftsTable.tsx");
  // Publish must disappear for a listing whose number is dead — pressing it
  // would repeat the identical rejection.
  assert.match(table, /!row\.walmart\.upc_quarantined/u);
  assert.match(table, /function needsUpcRotation/u);
  assert.match(table, /burned_upcs <= 1/u);
  // And past the limit the row says what is actually wrong.
  assert.match(table, /needs a look at the\s*\n?\s*payload, not another number/u);
});
