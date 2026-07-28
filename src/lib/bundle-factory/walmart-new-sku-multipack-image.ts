import { createHash } from "node:crypto";

import sharp from "sharp";

export interface WalmartDeterministicMultipackImage {
  bytes: Buffer;
  source_asset_sha256: string;
  output_sha256: string;
  represented_unit_count: 2 | 3;
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

export async function buildDeterministicWalmartMultipackImage(input: {
  sourceUnitImageBytes: Buffer;
  packCount: 2 | 3;
}): Promise<WalmartDeterministicMultipackImage> {
  if (input.packCount !== 2 && input.packCount !== 3) {
    throw new Error("Walmart preview multipack supports only Pack of 2 or Pack of 3");
  }
  if (input.sourceUnitImageBytes.length === 0) {
    throw new Error("sourceUnitImageBytes cannot be empty");
  }
  const cutout = await exactPackageCutout(input.sourceUnitImageBytes);
  const cutoutMetadata = await sharp(cutout).metadata();
  const cutoutWidth = cutoutMetadata.width;
  const cutoutHeight = cutoutMetadata.height;
  if (!cutoutWidth || !cutoutHeight) {
    throw new Error("cutout unit image dimensions are unavailable");
  }
  const cutoutAspectRatio = cutoutWidth / cutoutHeight;

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
