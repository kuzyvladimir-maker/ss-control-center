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

  assert.match(html, /Полный каталог/);
  assert.match(html, /3936\/3936 SKU/);
  assert.match(html, /1464/);
  assert.match(html, /1431/);
  assert.match(html, /1964/);
  assert.match(html, /1\/57/);
  assert.match(html, /32 images/);
  assert.match(html, /Контрольный canary — пример работы цикла, не граница каталога/);
  assert.match(html, /FaisalX-1183/);
  assert.match(html, /Показана 1 упаковка из 6/);
  assert.match(html, /Показаны все 6 упаковок/);
  assert.match(html, /37\/37/);
  assert.match(html, /38\/38/);
  assert.match(html, /17\/17/);
  assert.match(html, /8\/8/);
  assert.match(html, /Product Truth readiness/);
  assert.match(html, /Schema активирована и подтверждена 8\/8/);
  assert.match(html, /LISTING_SCOPE_NOT_REGISTERED/);
  assert.match(html, /Canonical shared Product Truth read-contract/);
  assert.match(html, /Execution package: NO-GO/);
  assert.match(html, /Walmart write: LOCKED/);
  assert.match(html, /Mass run: LOCKED/);
  assert.match(html, /exact-byte custody verified/);
  assert.match(html, /Source-aware visual attestation/);
  assert.match(html, /Подписанная визуальная проверка завершена/);
  assert.match(html, /предлагаемая MAIN = PASS/);
  assert.match(html, /ошибочных gallery = 0/);
  assert.match(html, /Ручная проверка target MAIN и gallery подтверждена владельцем/);
  assert.match(html, /Владелец подтвердил новую MAIN и дополнительные изображения/);
  assert.match(html, /Owner visual review of target MAIN and gallery/);
  assert.match(html, /Owner approved/);
  assert.match(html, /ещё не live/);
  assert.match(html, /Repairs locked/);
  assert.match(html, /Mass run locked/);
  assert.doesNotMatch(html, /method="post"/i);
  assert.doesNotMatch(html, /Publish now/i);
});
