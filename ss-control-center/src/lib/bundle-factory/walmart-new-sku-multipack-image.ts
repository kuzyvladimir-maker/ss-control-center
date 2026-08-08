import { createHash } from "node:crypto";

import sharp from "sharp";

export interface WalmartDeterministicMultipackImage {
  bytes: Buffer;
  source_asset_sha256: string;
  output_sha256: string;
  represented_unit_count: number;
  construction_method: "DETERMINISTIC_EXACT_PIXEL_MULTIPACK";
  canvas: {
    width: 2200;
    height: 2200;
    background: "WHITE";
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isConnectedBackgroundCandidate(
  pixels: Buffer,
  offset: number,
  threshold: number,
): boolean {
  const red = pixels[offset]!;
  const green = pixels[offset + 1]!;
  const blue = pixels[offset + 2]!;
  const alpha = pixels[offset + 3]!;
  return (
    alpha > 0 &&
    red >= threshold &&
    green >= threshold &&
    blue >= threshold &&
    Math.max(red, green, blue) - Math.min(red, green, blue) <= 12
  );
}

/**
 * Removes only near-white pixels connected to the outer canvas.
 * Package pixels, including isolated white logos and label text, are preserved.
 */
async function exactPackageCutout(source: Buffer): Promise<Buffer> {
  const decoded = await sharp(source, {
    failOn: "warning",
    limitInputPixels: 40_000_000,
  })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = decoded.info;
  if (channels !== 4 || width < 300 || height < 300) {
    throw new Error("source unit image must decode to a substantial RGBA canvas");
  }
  const pixelCount = width * height;
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let read = 0;
  let write = 0;
  const threshold = 244;

  const enqueue = (index: number) => {
    if (visited[index]) return;
    const offset = index * 4;
    if (!isConnectedBackgroundCandidate(decoded.data, offset, threshold)) {
      return;
    }
    visited[index] = 1;
    queue[write] = index;
    write += 1;
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  while (read < write) {
    const index = queue[read]!;
    read += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) enqueue(index - 1);
    if (x + 1 < width) enqueue(index + 1);
    if (y > 0) enqueue(index - width);
    if (y + 1 < height) enqueue(index + width);
  }
  if (write < pixelCount * 0.01) {
    throw new Error("source unit image has no removable connected white canvas");
  }

  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    if (visited[index]) decoded.data[offset + 3] = 0;
    if (decoded.data[offset + 3]! === 0) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  if (right < left || bottom < top) {
    throw new Error("background removal erased the complete unit image");
  }

  return sharp(decoded.data, {
    raw: { width, height, channels: 4 },
  })
    .extract({
      left,
      top,
      width: right - left + 1,
      height: bottom - top + 1,
    })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
}

/**
 * The per-cell sources, in the order they fill the grid.
 *
 * A single-product pack is expressed as one source with the whole count, so
 * everything below has exactly one shape to handle.
 */
/**
 * Provenance for the composed picture.
 *
 * A single-product pack keeps the plain digest of its one source, so every
 * image made before mixed assortments existed still hashes the same. A mix
 * digests all of its sources with their counts, because "which packages, how
 * many of each" is exactly what the picture claims.
 */
function sourcesDigest(
  sources: ReadonlyArray<{ bytes: Buffer; quantity: number }>,
  primary: Buffer,
): string {
  if (sources.length === 1 && sources[0].bytes.equals(primary)) {
    return sha256(primary);
  }
  return sha256(Buffer.from(
    sources.map((entry) => `${sha256(entry.bytes)}x${entry.quantity}`).join("|"),
    "utf8",
  ));
}

function normalizeUnitSources(input: {
  sourceUnitImageBytes: Buffer;
  packCount: number;
  unitSources?: ReadonlyArray<{ bytes: Buffer; quantity: number }>;
}): Array<{ bytes: Buffer; quantity: number }> {
  if (!input.unitSources || input.unitSources.length === 0) {
    return [{ bytes: input.sourceUnitImageBytes, quantity: input.packCount }];
  }
  const sources = input.unitSources.map((entry, index) => {
    if (!Number.isInteger(entry.quantity) || entry.quantity < 1) {
      throw new Error(`unit source ${index} needs a whole quantity of at least 1`);
    }
    if (entry.bytes.length === 0) {
      throw new Error(`unit source ${index} has no image bytes`);
    }
    return { bytes: entry.bytes, quantity: entry.quantity };
  });
  const total = sources.reduce((sum, entry) => sum + entry.quantity, 0);
  if (total !== input.packCount) {
    throw new Error(
      `mixed unit sources hold ${total} units but packCount is ${input.packCount}`,
    );
  }
  if (!sources[0].bytes.equals(input.sourceUnitImageBytes)) {
    // The layout is measured from sourceUnitImageBytes. If the first cell came
    // from somewhere else, the picture would be laid out for one product and
    // filled with another.
    throw new Error("the first unit source must be sourceUnitImageBytes");
  }
  return sources;
}

export async function buildDeterministicWalmartMultipackImage(input: {
  sourceUnitImageBytes: Buffer;
  packCount: number;
  /**
   * A mixed assortment: several DIFFERENT products in one box, each with its
   * own count. Quantities must sum to packCount, and the first entry must be
   * `sourceUnitImageBytes` — the layout is measured from it, so the primary
   * source stays the one the caller named.
   *
   * Omitted, this composes packCount copies of one product exactly as before,
   * byte for byte. That matters: existing drafts are addressed by the output
   * digest, and a layout change would orphan every one of them.
   */
  unitSources?: ReadonlyArray<{ bytes: Buffer; quantity: number }>;
}): Promise<WalmartDeterministicMultipackImage> {
  if (
    !Number.isInteger(input.packCount) ||
    input.packCount < 1 ||
    input.packCount > 500
  ) {
    throw new Error(
      "Walmart preview packCount must be a whole number from 1 to 500",
    );
  }
  if (input.sourceUnitImageBytes.length === 0) {
    throw new Error("sourceUnitImageBytes cannot be empty");
  }
  const sources = normalizeUnitSources(input);
  if (sources.length > 1 && (input.packCount === 2 || input.packCount === 3)) {
    // Packs of two and three use hand-tuned layouts further down that place
    // each unit individually. Mixing there is not implemented, and composing
    // one flavor while claiming several would be worse than refusing.
    throw new Error(
      "A mixed assortment of 2 or 3 units is not supported yet; "
      + "use a pack of 4 or more, or a single product",
    );
  }
  const cutout = await exactPackageCutout(input.sourceUnitImageBytes);
  const cutoutMetadata = await sharp(cutout).metadata();
  const cutoutWidth = cutoutMetadata.width;
  const cutoutHeight = cutoutMetadata.height;
  if (!cutoutWidth || !cutoutHeight) {
    throw new Error("cutout unit image dimensions are unavailable");
  }
  const cutoutAspectRatio = cutoutWidth / cutoutHeight;

  if (input.packCount !== 2 && input.packCount !== 3) {
    const canvasSize = 2_200;
    const margin = 35;
    const innerSize = canvasSize - margin * 2;
    let best: {
      columns: number;
      rows: number;
      overlapX: number;
      overlapY: number;
      unitWidth: number;
      unitHeight: number;
      score: number;
    } | null = null;

    // Search deterministic grid/overlap layouts. Overlap is safe because the
    // source package has already been cut out to transparency: no white donor
    // canvas can cover another package. The chosen layout maximizes use of the
    // square while keeping every requested unit present as an exact-pixel copy.
    for (let columns = 1; columns <= input.packCount; columns += 1) {
      const rows = Math.ceil(input.packCount / columns);
      const emptyCells = columns * rows - input.packCount;
      for (let overlapXStep = 0; overlapXStep <= 14; overlapXStep += 1) {
        const overlapX = overlapXStep * 0.05;
        for (let overlapYStep = 0; overlapYStep <= 14; overlapYStep += 1) {
          const overlapY = overlapYStep * 0.05;
          const widthFactor =
            cutoutAspectRatio *
            (1 + Math.max(0, columns - 1) * (1 - overlapX));
          const heightFactor =
            1 + Math.max(0, rows - 1) * (1 - overlapY);
          const unitHeight = Math.min(
            innerSize / widthFactor,
            innerSize / heightFactor,
          );
          const unitWidth = unitHeight * cutoutAspectRatio;
          const occupiedWidth =
            unitWidth *
            (1 + Math.max(0, columns - 1) * (1 - overlapX));
          const occupiedHeight =
            unitHeight *
            (1 + Math.max(0, rows - 1) * (1 - overlapY));
          const minimumFill = Math.min(
            occupiedWidth / innerSize,
            occupiedHeight / innerSize,
          );
          const score =
            minimumFill * 100 +
            (unitWidth * unitHeight / (innerSize * innerSize)) -
            emptyCells * 0.02 -
            (overlapX + overlapY) * 0.01;
          if (!best || score > best.score) {
            best = {
              columns,
              rows,
              overlapX,
              overlapY,
              unitWidth,
              unitHeight,
              score,
            };
          }
        }
      }
    }
    if (!best) {
      throw new Error("unable to determine deterministic multipack layout");
    }

    const resizeToCell = async (bytes: Buffer): Promise<Buffer> =>
      sharp(bytes, { failOn: "warning" })
        .resize({
          width: Math.max(1, Math.floor(best.unitWidth)),
          height: Math.max(1, Math.floor(best.unitHeight)),
          fit: "inside",
          withoutEnlargement: false,
        })
        .png({ compressionLevel: 9, adaptiveFiltering: false })
        .toBuffer();

    // Every cell is an exact-pixel copy of one of the sources, cut out and
    // scaled into the same box the layout was measured for. `unit` stays the
    // FIRST source, so a single-product pack composes exactly as it always did.
    const unit = await resizeToCell(cutout);
    const cellUnits: Buffer[] = [];
    for (const source of sources) {
      const scaled = source.bytes.equals(input.sourceUnitImageBytes)
        ? unit
        : await resizeToCell(await exactPackageCutout(source.bytes));
      for (let copy = 0; copy < source.quantity; copy += 1) cellUnits.push(scaled);
    }
    const unitMetadata = await sharp(unit).metadata();
    const unitWidth = unitMetadata.width;
    const unitHeight = unitMetadata.height;
    if (!unitWidth || !unitHeight) {
      throw new Error("generic unit image dimensions are unavailable");
    }
    const horizontalStep = unitWidth * (1 - best.overlapX);
    const verticalStep = unitHeight * (1 - best.overlapY);
    const occupiedHeight =
      unitHeight + Math.max(0, best.rows - 1) * verticalStep;
    const startTop = Math.max(
      0,
      Math.round((canvasSize - occupiedHeight) / 2),
    );
    const composites = Array.from(
      { length: input.packCount },
      (_, index) => {
        const row = Math.floor(index / best.columns);
        const column = index % best.columns;
        const unitsInRow = Math.min(
          best.columns,
          input.packCount - row * best.columns,
        );
        const rowWidth =
          unitWidth + Math.max(0, unitsInRow - 1) * horizontalStep;
        const rowStart = Math.max(
          0,
          Math.round((canvasSize - rowWidth) / 2),
        );
        return {
          input: cellUnits[index]!,
          left: Math.round(rowStart + column * horizontalStep),
          top: Math.round(startTop + row * verticalStep),
        };
      },
    );
    const bytes = await sharp({
      create: {
        width: canvasSize,
        height: canvasSize,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite(composites)
      .png({ compressionLevel: 9, adaptiveFiltering: false })
      .toBuffer();

    return {
      bytes,
      source_asset_sha256: sourcesDigest(sources, input.sourceUnitImageBytes),
      output_sha256: sha256(bytes),
      represented_unit_count: input.packCount,
      construction_method: "DETERMINISTIC_EXACT_PIXEL_MULTIPACK",
      canvas: {
        width: 2_200,
        height: 2_200,
        background: "WHITE",
      },
    };
  }

  if (cutoutAspectRatio >= 1.8) {
    const unitWidth = input.packCount === 2 ? 2_050 : 1_850;
    const unitBase = await sharp(cutout, { failOn: "warning" })
      .resize({
        width: unitWidth,
        height: input.packCount === 2 ? 900 : 660,
        fit: "inside",
        withoutEnlargement: false,
      })
      .png({ compressionLevel: 9, adaptiveFiltering: false })
      .toBuffer();
    const unitMetadata = await sharp(unitBase).metadata();
    if (!unitMetadata.width || !unitMetadata.height) {
      throw new Error("landscape unit image dimensions are unavailable");
    }
    const units = Array.from({ length: input.packCount }, () => ({
      bytes: unitBase,
      width: unitMetadata.width!,
      height: unitMetadata.height!,
    }));
    const verticalGap = input.packCount === 2 ? 70 : 20;
    const totalHeight = input.packCount * unitMetadata.height
      + (input.packCount - 1) * verticalGap;
    const startTop = Math.max(20, Math.round((2_200 - totalHeight) / 2));
    const positions = input.packCount === 2
      ? [
          { left: 20, top: startTop },
          {
            left: 2_200 - units[1]!.width - 20,
            top: startTop + unitMetadata.height + verticalGap,
          },
        ]
      : [
          { left: 25, top: startTop },
          {
            left: Math.round((2_200 - units[1]!.width) / 2),
            top: startTop + unitMetadata.height + verticalGap,
          },
          {
            left: 2_200 - units[2]!.width - 20,
            top: startTop + 2 * (unitMetadata.height + verticalGap),
          },
        ];
    const bytes = await sharp({
      create: {
        width: 2_200,
        height: 2_200,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite(units.map((unit, index) => ({
        input: unit.bytes,
        left: positions[index]!.left,
        top: positions[index]!.top,
      })))
      .png({ compressionLevel: 9, adaptiveFiltering: false })
      .toBuffer();

    return {
      bytes,
      source_asset_sha256: sourcesDigest(sources, input.sourceUnitImageBytes),
      output_sha256: sha256(bytes),
      represented_unit_count: input.packCount,
      construction_method: "DETERMINISTIC_EXACT_PIXEL_MULTIPACK",
      canvas: {
        width: 2_200,
        height: 2_200,
        background: "WHITE",
      },
    };
  }

  const unitBounds = input.packCount === 2
    ? { width: 1_450, height: 1_880 }
    : { width: 1_200, height: 1_540 };
  const unit = await sharp(cutout, { failOn: "warning" })
    .resize({
      width: unitBounds.width,
      height: unitBounds.height,
      fit: "inside",
      withoutEnlargement: false,
    })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
  const metadata = await sharp(unit).metadata();
  const width = metadata.width;
  const resizedHeight = metadata.height;
  if (!width || !resizedHeight) {
    throw new Error("resized unit image dimensions are unavailable");
  }

  const positions = input.packCount === 2
    ? [
        { left: 30, top: 210 },
        { left: 2_170 - width, top: 90 },
      ]
    : [
        { left: 20, top: 80 },
        { left: 2_180 - width, top: 80 },
        { left: Math.round((2_200 - width) / 2), top: 620 },
      ];
  const composites = positions.map((position) => ({
    input: unit,
    left: position.left,
    top: position.top,
  }));
  const bytes = await sharp({
    create: {
      width: 2_200,
      height: 2_200,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite(composites)
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();

  return {
    bytes,
    source_asset_sha256: sha256(input.sourceUnitImageBytes),
    output_sha256: sha256(bytes),
    represented_unit_count: input.packCount,
    construction_method: "DETERMINISTIC_EXACT_PIXEL_MULTIPACK",
    canvas: {
      width: 2_200,
      height: 2_200,
      background: "WHITE",
    },
  };
}
