import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the draft page offers whatever the row actually needs next", async () => {
  const client = await readFile(
    new URL(
      "../../../app/bundle-factory/drafts/[id]/DraftDetailClient.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  // The promote button used to require rows.length === 0 while being rendered
  // only inside the branch where rows exist, so it could never appear and a
  // finished Walmart listing was a dead end on its own page.
  assert.doesNotMatch(client, /showWalmartPrepareBtn[\s\S]{0,200}rows\.length === 0/u);
  assert.match(client, /showWalmartPrepareBtn = rows\.some\(/u);
  assert.match(client, /r\.channel_sku_id === null/u);

  // Validate and Publish must not depend on the DRAFT's lifecycle string:
  // studio drafts sit at GENERATED, which appeared in none of the allowlists.
  assert.doesNotMatch(client, /showValidateAllBtn =[\s\S]{0,240}props\.draftStatus/u);
  assert.doesNotMatch(client, /showPublishAllBtn =[\s\S]{0,240}props\.draftStatus/u);

  // Publishing still requires a PASSED validation and an unsent listing.
  assert.match(client, /isPublishable = \(status: string\) => status === "PASSED"/u);
});
