/** Strict parser for the local Apple Vision OCR helper.
 *
 * OCR is auxiliary evidence only. This module does not compare it with listing
 * truth and cannot produce PASS/BAD. The deterministic comparator decides how
 * matching and contradictory OCR evidence may be used.
 */

export const LOCAL_VISUAL_OCR_SCHEMA = "walmart-local-ocr/v1" as const;
export const LOCAL_VISUAL_OCR_ENGINE = "apple-vision-accurate-literal" as const;
const APPLE_VISION_BOUNDING_BOX_TOLERANCE = 0.02;

export interface LocalOcrBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LocalOcrTextObservation {
  text: string;
  confidence: number;
  bounding_box: LocalOcrBoundingBox;
}

export interface LocalOcrImageResult {
  path: string;
  width: number;
  height: number;
  observations: LocalOcrTextObservation[];
}

export interface LocalOcrOutput {
  schema_version: typeof LOCAL_VISUAL_OCR_SCHEMA;
  engine: typeof LOCAL_VISUAL_OCR_ENGINE;
  images: LocalOcrImageResult[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allow = new Set(allowed);
  const extras = Object.keys(value).filter((key) => !allow.has(key));
  if (extras.length) throw new Error(`${path} has unsupported fields: ${extras.join(", ")}`);
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be finite`);
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  const number = finiteNumber(value, path);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${path} must be a positive integer`);
  return number;
}

function stableCoordinate(value: number): number {
  return Number(value.toFixed(12));
}

export function parseLocalOcrOutput(raw: unknown, expectedPaths?: readonly string[]): LocalOcrOutput {
  if (!isRecord(raw)) throw new Error("OCR output must be an object");
  assertExactKeys(raw, ["schema_version", "engine", "images"], "OCR output");
  if (raw.schema_version !== LOCAL_VISUAL_OCR_SCHEMA) {
    throw new Error(`OCR schema_version must be ${LOCAL_VISUAL_OCR_SCHEMA}`);
  }
  if (raw.engine !== LOCAL_VISUAL_OCR_ENGINE) {
    throw new Error(`OCR engine must be ${LOCAL_VISUAL_OCR_ENGINE}`);
  }
  if (!Array.isArray(raw.images) || raw.images.length === 0) {
    throw new Error("OCR images must not be empty");
  }

  const images = raw.images.map((value, imageIndex): LocalOcrImageResult => {
    const path = `OCR images[${imageIndex}]`;
    if (!isRecord(value)) throw new Error(`${path} must be an object`);
    assertExactKeys(value, ["path", "width", "height", "observations"], path);
    if (typeof value.path !== "string" || !value.path.trim()) throw new Error(`${path}.path is invalid`);
    if (!Array.isArray(value.observations)) throw new Error(`${path}.observations must be an array`);
    const observations = value.observations.map((row, rowIndex): LocalOcrTextObservation => {
      const rowPath = `${path}.observations[${rowIndex}]`;
      if (!isRecord(row)) throw new Error(`${rowPath} must be an object`);
      assertExactKeys(row, ["text", "confidence", "bounding_box"], rowPath);
      if (typeof row.text !== "string" || !row.text.trim()) throw new Error(`${rowPath}.text is invalid`);
      const confidence = finiteNumber(row.confidence, `${rowPath}.confidence`);
      if (confidence < 0 || confidence > 1) throw new Error(`${rowPath}.confidence must be within 0..1`);
      if (!isRecord(row.bounding_box)) throw new Error(`${rowPath}.bounding_box must be an object`);
      assertExactKeys(row.bounding_box, ["x", "y", "width", "height"], `${rowPath}.bounding_box`);
      const rawBox: LocalOcrBoundingBox = {
        x: finiteNumber(row.bounding_box.x, `${rowPath}.bounding_box.x`),
        y: finiteNumber(row.bounding_box.y, `${rowPath}.bounding_box.y`),
        width: finiteNumber(row.bounding_box.width, `${rowPath}.bounding_box.width`),
        height: finiteNumber(row.bounding_box.height, `${rowPath}.bounding_box.height`),
      };
      if (rawBox.x < -APPLE_VISION_BOUNDING_BOX_TOLERANCE
        || rawBox.y < -APPLE_VISION_BOUNDING_BOX_TOLERANCE
        || rawBox.width <= 0
        || rawBox.height <= 0
        || rawBox.x + rawBox.width > 1 + APPLE_VISION_BOUNDING_BOX_TOLERANCE
        || rawBox.y + rawBox.height > 1 + APPLE_VISION_BOUNDING_BOX_TOLERANCE) {
        throw new Error(`${rowPath}.bounding_box is outside normalized image bounds`);
      }
      // Vision occasionally emits a box a few subpixels beyond an image edge.
      // Bounding boxes are provenance only (never verdict evidence), so clamp
      // a narrowly tolerated overshoot while retaining the sealed raw OCR JSON.
      const left = Math.max(0, rawBox.x);
      const bottom = Math.max(0, rawBox.y);
      const right = Math.min(1, rawBox.x + rawBox.width);
      const top = Math.min(1, rawBox.y + rawBox.height);
      const box: LocalOcrBoundingBox = {
        x: stableCoordinate(left),
        y: stableCoordinate(bottom),
        width: stableCoordinate(right - left),
        height: stableCoordinate(top - bottom),
      };
      if (box.width <= 0 || box.height <= 0) {
        throw new Error(`${rowPath}.bounding_box collapses outside normalized image bounds`);
      }
      return { text: row.text.trim().slice(0, 500), confidence, bounding_box: box };
    });
    return {
      path: value.path,
      width: positiveInteger(value.width, `${path}.width`),
      height: positiveInteger(value.height, `${path}.height`),
      observations,
    };
  });

  if (expectedPaths) {
    const expected = [...expectedPaths].sort();
    const actual = images.map((image) => image.path).sort();
    if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
      throw new Error("OCR output paths do not exactly match requested paths");
    }
  }

  return {
    schema_version: LOCAL_VISUAL_OCR_SCHEMA,
    engine: LOCAL_VISUAL_OCR_ENGINE,
    images,
  };
}

/** Literal OCR strings safe to pass as auxiliary evidence to the comparator. */
export function highConfidenceOcrTexts(
  image: LocalOcrImageResult,
  minimumConfidence = 0.9,
): string[] {
  if (!Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1) {
    throw new Error("minimumConfidence must be within 0..1");
  }
  return image.observations
    .filter((row) => row.confidence >= minimumConfidence)
    .map((row) => row.text);
}
