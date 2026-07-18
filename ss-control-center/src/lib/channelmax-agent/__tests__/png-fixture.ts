import { deflateSync } from "node:zlib";

export const TEST_PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value =
        (value & 1) === 1
          ? (0xedb88320 ^ (value >>> 1)) >>> 0
          : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function testPngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.from(data);
  const chunk = Buffer.alloc(12 + body.byteLength);
  chunk.writeUInt32BE(body.byteLength, 0);
  typeBytes.copy(chunk, 4);
  body.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(Buffer.concat([typeBytes, body])),
    8 + body.byteLength,
  );
  return chunk;
}

export interface TestPngOptions {
  width?: number;
  height?: number;
  bitDepth?: number;
  colorType?: number;
  compressionMethod?: number;
  filterMethod?: number;
  interlaceMethod?: number;
  scanlines?: Uint8Array;
  compressed?: Uint8Array;
  idatParts?: number;
  chunksBeforeIdat?: Buffer[];
  chunksBetweenIdat?: Buffer[];
  chunksAfterIdat?: Buffer[];
  includeIend?: boolean;
  trailing?: Uint8Array;
  fill?: readonly number[];
}

function channelsForFixture(colorType: number): number {
  switch (colorType) {
    case 0:
    case 3:
      return 1;
    case 2:
      return 3;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      return 1;
  }
}

export function testPng(options: TestPngOptions = {}): Buffer {
  const width = options.width ?? 320;
  const height = options.height ?? 200;
  const bitDepth = options.bitDepth ?? 8;
  const colorType = options.colorType ?? 6;
  const compressionMethod = options.compressionMethod ?? 0;
  const filterMethod = options.filterMethod ?? 0;
  const interlaceMethod = options.interlaceMethod ?? 0;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = compressionMethod;
  ihdr[11] = filterMethod;
  ihdr[12] = interlaceMethod;

  const channels = channelsForFixture(colorType);
  const rowBytes = width * channels;
  const scanlines = options.scanlines
    ? Buffer.from(options.scanlines)
    : Buffer.alloc((rowBytes + 1) * height);
  if (!options.scanlines) {
    const fill = options.fill ?? [24, 91, 53, 255];
    for (let row = 0; row < height; row += 1) {
      const offset = row * (rowBytes + 1);
      scanlines[offset] = 0;
      for (let pixel = 0; pixel < rowBytes; pixel += channels) {
        for (let channel = 0; channel < channels; channel += 1) {
          scanlines[offset + 1 + pixel + channel] =
            fill[channel] ?? (channel === 3 ? 255 : 0);
        }
      }
    }
  }
  const compressed = options.compressed
    ? Buffer.from(options.compressed)
    : deflateSync(scanlines);
  const partCount = Math.max(1, options.idatParts ?? 1);
  const idatChunks: Buffer[] = [];
  for (let part = 0; part < partCount; part += 1) {
    const start = Math.floor((compressed.byteLength * part) / partCount);
    const end = Math.floor((compressed.byteLength * (part + 1)) / partCount);
    idatChunks.push(testPngChunk("IDAT", compressed.subarray(start, end)));
    if (part === 0 && partCount > 1) {
      idatChunks.push(...(options.chunksBetweenIdat ?? []));
    }
  }

  return Buffer.concat([
    TEST_PNG_SIGNATURE,
    testPngChunk("IHDR", ihdr),
    ...(options.chunksBeforeIdat ?? []),
    ...idatChunks,
    ...(options.chunksAfterIdat ?? []),
    ...(options.includeIend === false ? [] : [testPngChunk("IEND", Buffer.alloc(0))]),
    Buffer.from(options.trailing ?? []),
  ]);
}
