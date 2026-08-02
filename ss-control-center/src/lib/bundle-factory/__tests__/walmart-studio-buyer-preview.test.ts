import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PAGE = new URL(
  "../../../app/bundle-factory/new/[id]/review/[draftId]/page.tsx",
  import.meta.url,
);
const CLIENT = new URL(
  "../../../app/bundle-factory/new/[id]/review/[draftId]/WalmartBuyerPreview.tsx",
  import.meta.url,
);
const BATCH_REVIEW = new URL(
  "../../../app/bundle-factory/new/[id]/review/page.tsx",
  import.meta.url,
);

test("batch review opens the dedicated Walmart buyer preview", async () => {
  const source = await readFile(BATCH_REVIEW, "utf8");
  assert.match(source, /review\/\$\{draft\.id\}/u);
  assert.match(source, /Open Walmart buyer preview/u);
  assert.doesNotMatch(source, /href=\{`\/bundle-factory\/drafts\/\$\{draft\.id\}`\}/u);
});

test("buyer preview is evidence-bound and has no mutation controls", async () => {
  const [page, client] = await Promise.all([
    readFile(PAGE, "utf8"),
    readFile(CLIENT, "utf8"),
  ]);
  assert.match(page, /generation_job_id: id/u);
  assert.match(page, /bundle_draft_id: draftId/u);
  assert.match(page, /content_observation_id/u);
  assert.match(client, /not live · no listing UPC reserved · nothing published/u);
  assert.match(client, /Product artwork is not redrawn/u);
  assert.match(client, /Buyer-page preview/u);
  assert.doesNotMatch(client, /publishDraft|generateImage|regenerateImage|reserveUpc|WalmartClient/u);
});
