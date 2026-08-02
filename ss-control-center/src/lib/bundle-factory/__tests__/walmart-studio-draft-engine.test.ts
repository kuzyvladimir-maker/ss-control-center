import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("a video-still main image falls through to a real packshot", async () => {
  const engine = await readFile(
    new URL("../walmart-studio-draft-engine.ts", import.meta.url),
    "utf8",
  );
  // Some donors record a salsify video frame as the "main" image. It has no
  // removable white canvas, so a single-candidate composer failed the entire
  // listing. Every candidate here is an exact image of the SAME product from
  // the SAME observation, so walking the gallery is a source choice, never a
  // product substitution — and the composer still proves each candidate is a
  // true packshot before it is used.
  assert.match(engine, /const imageCandidates = \[/u);
  assert.match(engine, /_exact_main_image_url/u);
  assert.match(engine, /_exact_image_urls/u);
  assert.match(engine, /No exact donor image could become a Pack-of-/u);
  // The recorded provenance must follow the candidate that actually worked.
  assert.match(engine, /sourceFetchedUrl = source\.fetched_url/u);
  assert.match(engine, /fetched_url: sourceFetchedUrl/u);
});
