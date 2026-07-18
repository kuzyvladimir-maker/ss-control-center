import { test } from "node:test";
import assert from "node:assert/strict";

import {
  highConfidenceOcrTexts,
  parseLocalOcrOutput,
} from "../local-visual-ocr.ts";

const valid = {
  schema_version: "walmart-local-ocr/v1",
  engine: "apple-vision-accurate-literal",
  images: [{
    path: "/tmp/a.jpg",
    width: 1800,
    height: 1800,
    observations: [
      {
        text: "NET WT 22 OZ (624g)",
        confidence: 1,
        bounding_box: { x: 0.2, y: 0.05, width: 0.2, height: 0.02 },
      },
      {
        text: "uncertain",
        confidence: 0.5,
        bounding_box: { x: 0.2, y: 0.1, width: 0.1, height: 0.02 },
      },
    ],
  }],
};

test("strictly parses local OCR output and exact requested paths", () => {
  const output = parseLocalOcrOutput(valid, ["/tmp/a.jpg"]);
  assert.equal(output.images[0].observations[0].text, "NET WT 22 OZ (624g)");
  assert.throws(() => parseLocalOcrOutput(valid, ["/tmp/b.jpg"]), /do not exactly match/);
});

test("rejects unsupported output fields and invalid normalized bounds", () => {
  assert.throws(() => parseLocalOcrOutput({ ...valid, extra: true }), /unsupported fields/);
  const outside = structuredClone(valid);
  outside.images[0].observations[0].bounding_box.x = 0.95;
  assert.throws(() => parseLocalOcrOutput(outside), /outside normalized image bounds/);
});

test("clamps only Apple Vision subpixel edge overshoot", () => {
  const slight = structuredClone(valid);
  slight.images[0].observations[0].bounding_box = {
    x: -0.005,
    y: 0.995,
    width: 0.105,
    height: 0.01,
  };
  assert.deepEqual(parseLocalOcrOutput(slight).images[0].observations[0].bounding_box, {
    x: 0,
    y: 0.995,
    width: 0.1,
    height: 0.005,
  });

  const excessive = structuredClone(valid);
  excessive.images[0].observations[0].bounding_box = {
    x: -0.021,
    y: 0.2,
    width: 0.2,
    height: 0.2,
  };
  assert.throws(() => parseLocalOcrOutput(excessive), /outside normalized image bounds/);
});

test("passes only high-confidence literal OCR strings to comparison", () => {
  const output = parseLocalOcrOutput(valid);
  assert.deepEqual(highConfidenceOcrTexts(output.images[0]), ["NET WT 22 OZ (624g)"]);
  assert.throws(() => highConfidenceOcrTexts(output.images[0], 2), /within 0..1/);
});
