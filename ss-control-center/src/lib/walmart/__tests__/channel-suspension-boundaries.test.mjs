import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

test("deployed cron manifest contains no Walmart automation", () => {
  const manifest = JSON.parse(read("vercel.json"));
  const prohibited = manifest.crons.filter(({ path }) =>
    /walmart|bundle-factory-publish/iu.test(path),
  );
  assert.deepEqual(prohibited, []);
});

test("shared scheduled jobs explicitly exclude Walmart", () => {
  const finance = read("src/app/api/cron/finance-funds/route.ts");
  assert.match(finance, /ingestAmazonPayouts/u);
  assert.doesNotMatch(finance, /ingestAllPayouts/u);

  const poll = read("src/app/api/cron/bundle-factory-poll-pending/route.ts");
  assert.match(poll, /excludeChannels:\s*\["WALMART"\]/u);

  const tick = read("src/app/api/cron/bundle-factory-tick/route.ts");
  assert.match(tick, /generationJobTargetsWalmart/u);
});

test("operator surfaces cannot start a Walmart build", () => {
  const generate = read("src/app/api/bundle-factory/studio/generate/route.ts");
  assert.match(generate, /WALMART_CHANNEL_SUSPENDED/u);
  assert.match(generate, /status:\s*423/u);

  const page = read("src/app/bundle-factory/new/page.tsx");
  assert.match(page, /Walmart · suspended \(account blocked\)/u);
  assert.match(page, /label: "Walmart · suspended \(account blocked\)",\s*disabled: true/u);
});
