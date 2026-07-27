import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ListingIntegrityPanel } from "../ListingIntegrityPanel";
import { loadListingIntegrityShadowData } from "@/lib/walmart/listing-integrity-shadow.server";

const ROOT = path.resolve(
  process.cwd(),
  "data/audits/walmart-listing-integrity-fresh-controls",
);

test("renders qualified canaries and the sealed controlled pool without mutation controls", async () => {
  const data = await loadListingIntegrityShadowData(ROOT);
  const html = renderToStaticMarkup(<ListingIntegrityPanel data={data} />);

  assert.match(html, /Постоянный Listing Integrity · контролируемая работа/);
  assert.match(html, /Listing Integrity · производственный контур/);
  assert.match(html, /3 qualified/);
  assert.match(html, /10 repair-ready/);
  assert.match(html, /1376 source-required/);
  assert.match(html, /Замкнутый цикл доказан на 3 live SKU/);
  assert.match(html, /FaisalX-1148/);
  assert.match(html, /FaisalX-1181/);
  assert.match(html, /FaisalX-1183/);
  assert.match(html, /18\/18 PASS/);
  assert.match(html, /20\/20 PASS/);
  assert.match(html, /Публикация \/ индексация/);
  assert.match(html, /Открыть фактическую галерею ДО → ПОСЛЕ/);
  assert.match(
    html,
    /\/api\/walmart\/growth\/listing-integrity\/gallery\/FaisalX-1181/,
  );
  assert.match(html, /Product Truth-ready repair pool/);
  assert.match(html, /FaisalX-2768/);
  assert.match(html, /FaisalX-1633/);
  assert.match(html, /Multipack audit/);
  assert.match(html, /SOURCE_REQUIRED/);
  assert.match(html, /1376 из 1391 кандидатов/);
  assert.match(html, /Write authority: false/);
  assert.match(html, /controlled-pool-010609ed49f99760f5a4/);
  assert.doesNotMatch(html, /Актуальное исправление/);
  assert.match(html, /Весь каталог Walmart/);
  assert.match(html, /4042\/4042 SKU/);
  assert.match(html, /1504/);
  assert.match(html, /1495/);
  assert.match(html, /929/);
  assert.match(html, /58/);
  assert.match(html, /2017/);
  assert.match(
    html,
    /Исторический контроль MAIN 1 → 6 — доказательство детектора, не актуальный payload/,
  );
  assert.match(html, /FaisalX-1183/);
  assert.match(html, /Показана 1 упаковка из 6/);
  assert.match(html, /Показаны все 6 упаковок/);
  assert.match(html, /37\/37/);
  assert.match(html, /38\/38/);
  assert.match(html, /17\/17/);
  assert.match(html, /8\/8/);
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
  assert.match(html, /Exact payload only/);
  assert.match(html, /Mass run locked/);
  assert.doesNotMatch(html, /method="post"/i);
  assert.doesNotMatch(html, /Publish now/i);
});
