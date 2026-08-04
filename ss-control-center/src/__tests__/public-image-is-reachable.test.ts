/**
 * Marketplaces must be able to fetch listing images without a session.
 *
 * Walmart and Amazon download images from whatever URL is in the feed. They
 * carry no cookie and no bearer token, so anything the proxy gates is, to them,
 * simply an image that cannot be downloaded.
 *
 * This cost a submission. The proxy passed `.png`, `.ico` and `.svg` through
 * but not `.jpg`, so the main image and the ingredient panel (both PNG) were
 * served while all six gallery images (JPEG) returned 401. Walmart reported it
 * as `ERR_EXT_DATA_0101311: the image cannot be downloaded from the URL
 * provided because it is missing a valid authentication credential` — which is
 * exactly what a 401 is, and nothing to do with the item.
 *
 * Worth recording how it was misdiagnosed: every failing sample happened to be
 * under the `sec/` prefix and every passing one happened to be `.png`, so the
 * pattern looked like the prefix. It was the extension. Probes that vary two
 * things at once prove nothing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROXY = resolve(dirname(fileURLToPath(import.meta.url)), "../proxy.ts");

test("the public image route is exempt from the session gate", () => {
  const source = readFileSync(PROXY, "utf8");
  const exemption = /pathname\.startsWith\("\/api\/public-image\/"\)/u;
  assert.match(
    source,
    exemption,
    "Marketplaces fetch listing images unauthenticated; the route must be public.",
  );

  // The exemption has to come BEFORE the session gate, or it never runs.
  const exemptionAt = source.search(exemption);
  const sessionGateAt = source.search(/const sessionToken = request\.cookies/u);
  assert.ok(exemptionAt > 0 && sessionGateAt > 0);
  assert.ok(
    exemptionAt < sessionGateAt,
    "The image exemption must precede the session gate.",
  );
});

test("every image extension we actually publish is passed through", () => {
  const source = readFileSync(PROXY, "utf8");
  // .jpg was the one missing, and it was missing silently.
  for (const extension of [".png", ".jpg", ".jpeg", ".webp", ".svg"]) {
    assert.match(
      source,
      new RegExp(`pathname\\.endsWith\\("\\${extension}"\\)`, "u"),
      `${extension} must not be gated — marketplaces cannot authenticate.`,
    );
  }
});

test("the gate itself is still there for everything else", () => {
  const source = readFileSync(PROXY, "utf8");
  assert.match(
    source,
    /\{ error: "Unauthorized" \}, \{ status: 401 \}/u,
    "Opening images must not open the API.",
  );
  assert.match(
    source,
    /NextResponse\.redirect\(new URL\("\/login"/u,
    "Pages must still require a session.",
  );
});
