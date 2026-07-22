import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { ListingIntegrityPanel } from "../ListingIntegrityPanel";
import { loadListingIntegrityShadowData } from "@/lib/walmart/listing-integrity-shadow.server";

const ROOT = path.resolve(
  process.cwd(),
  "data/audits/walmart-listing-integrity-fresh-controls",
);

test("renders the fresh before/proposed-after shadow case without live controls", async () => {
  const data = await loadListingIntegrityShadowData(ROOT);
  const html = renderToStaticMarkup(<ListingIntegrityPanel data={data} />);

  assert.match(html, /Shadow mode/);
  assert.match(html, /FaisalX-1183/);
  assert.match(html, /Показана 1 упаковка из 6/);
  assert.match(html, /Показаны все 6 упаковок/);
  assert.match(html, /37\/37/);
  assert.match(html, /4\/4/);
  assert.match(html, /exact-byte custody verified/);
  assert.match(html, /Source-aware visual attestation/);
  assert.match(html, /ещё не live/);
  assert.match(html, /Canary locked/);
  assert.match(html, /Mass run locked/);
  assert.doesNotMatch(html, /method="post"/i);
  assert.doesNotMatch(html, /Publish now/i);
});
