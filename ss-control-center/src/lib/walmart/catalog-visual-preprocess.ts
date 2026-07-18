/**
 * Deterministic, truth-blind preprocessing for Walmart catalog visual audits.
 *
 * The source buffer is never modified. The full image is always emitted. Extra
 * views are emitted only when a conservative white-background segmentation
 * finds at least two similarly sized, visually similar product regions.
 *
 * This module deliberately performs no OCR, model call, network request, SKU
 * lookup, or comparison with listing truth.
 */

import { createHash } from "node:crypto";

import sharp from "sharp";

export const VISUAL_PREPROCESS_SCHEMA = "wm_visual_preprocess/v1" as const;
export const VISUAL_PREPROCESS_VERSION = "walmart-visual-preprocess/2026-07-18-v1" as const;

export type VisualPreprocessStatus = "confirmed_repetition" | "full_only";
export type DerivedViewRole = "full" | "tile_front" | "bottom_label" | "top_left_badge";

export interface PixelRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface VisualPreprocessOptions {
  /** Maximum edge of the full normalized view. */
  full_max_edge?: number;
  /** Maximum edge of a detail crop after deterministic resize. */
  crop_max_edge?: number;
  /** Analysis is intentionally bounded; it never replaces source-resolution crops. */
  analysis_max_edge?: number;
  /** Never magnify a crop by more than this factor. */
  max_crop_upscale?: number;
  /** Hard memory/zip-bomb guard passed to sharp. */
  limit_input_pixels?: number;
}

export interface DerivedViewTransform {
  coordinate_space: "auto_oriented_source_pixels";
  source_region: PixelRegion | null;
  flatten_background: "#ffffff";
  colourspace: "srgb";
  resize: {
    kernel: "lanczos3";
    width: number;
    height: number;
    without_enlargement: boolean;
    maximum_upscale: number;
  };
  encoding: {
    format: "jpeg" | "png";
    quality: number | null;
    chroma_subsampling: "4:4:4" | null;
    compression_level: number | null;
  };
}

export interface DerivedVisualView {
  view_id: string;
  role: DerivedViewRole;
  media_type: "image/jpeg" | "image/png";
  width: number;
  height: number;
  byte_length: number;
  sha256: string;
  provenance_sha256: string;
  transform: DerivedViewTransform;
  /** Caller owns persistence. The module never writes derived bytes itself. */
  bytes: Buffer;
}

export interface VisualPreprocessResult {
  schema_version: typeof VISUAL_PREPROCESS_SCHEMA;
  preprocessor_version: typeof VISUAL_PREPROCESS_VERSION;
  source: {
    sha256: string;
    byte_length: number;
    format: string;
    width: number;
    height: number;
    orientation: number | null;
    oriented_width: number;
    oriented_height: number;
  };
  analysis: {
    status: VisualPreprocessStatus;
    reason: string;
    analysis_width: number;
    analysis_height: number;
    background_rgb: [number, number, number];
    border_outlier_fraction: number;
    region_count: number;
    regions: PixelRegion[];
    representative_region_index: number | null;
    dimension_cv: number | null;
    mean_histogram_distance: number | null;
    analysis_sha256: string;
  };
  views: DerivedVisualView[];
}

interface ResolvedOptions {
  full_max_edge: number;
  crop_max_edge: number;
  analysis_max_edge: number;
  max_crop_upscale: number;
  limit_input_pixels: number;
}

interface Component {
  left: number;
  top: number;
  width: number;
  height: number;
  mask_pixels: number;
  histogram: number[];
}

interface RawAnalysisImage {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

const DEFAULTS: ResolvedOptions = {
  full_max_edge: 1800,
  crop_max_edge: 2048,
  analysis_max_edge: 512,
  max_crop_upscale: 3,
  limit_input_pixels: 64_000_000,
};

const WHITE = { r: 255, g: 255, b: 255, alpha: 1 } as const;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableNumber(value: number): number {
  return Number(value.toFixed(6));
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function resolveOptions(options: VisualPreprocessOptions): ResolvedOptions {
  const out = { ...DEFAULTS, ...options };
  for (const key of ["full_max_edge", "crop_max_edge", "analysis_max_edge", "limit_input_pixels"] as const) {
    if (!Number.isInteger(out[key]) || out[key] <= 0) throw new Error(`${key} must be a positive integer`);
  }
  if (!Number.isFinite(out.max_crop_upscale) || out.max_crop_upscale < 1 || out.max_crop_upscale > 8) {
    throw new Error("max_crop_upscale must be between 1 and 8");
  }
  if (out.analysis_max_edge < 192 || out.analysis_max_edge > 1024) {
    throw new Error("analysis_max_edge must be between 192 and 1024");
  }
  return out;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function coefficientOfVariation(values: number[]): number {
  if (!values.length) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (!mean) return 0;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function pixelOffset(image: RawAnalysisImage, x: number, y: number): number {
  return (y * image.width + x) * image.channels;
}

function pixelRgb(image: RawAnalysisImage, x: number, y: number): [number, number, number] {
  const offset = pixelOffset(image, x, y);
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
}

function estimateBackground(image: RawAnalysisImage): {
  rgb: [number, number, number];
  outlierFraction: number;
  acceptable: boolean;
} {
  const ring = Math.max(1, Math.floor(Math.min(image.width, image.height) * 0.015));
  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (x >= ring && x < image.width - ring && y >= ring && y < image.height - ring) continue;
      const [r, g, b] = pixelRgb(image, x, y);
      red.push(r);
      green.push(g);
      blue.push(b);
    }
  }

  const rgb: [number, number, number] = [Math.round(median(red)), Math.round(median(green)), Math.round(median(blue))];
  let outliers = 0;
  for (let index = 0; index < red.length; index += 1) {
    const delta = Math.max(
      Math.abs(red[index] - rgb[0]),
      Math.abs(green[index] - rgb[1]),
      Math.abs(blue[index] - rgb[2]),
    );
    if (delta > 18) outliers += 1;
  }
  const outlierFraction = red.length ? outliers / red.length : 1;
  const channelSpread = Math.max(...rgb) - Math.min(...rgb);
  const acceptable = Math.min(...rgb) >= 238 && channelSpread <= 12 && outlierFraction <= 0.08;
  return { rgb, outlierFraction, acceptable };
}

function buildForegroundMask(image: RawAnalysisImage, background: [number, number, number]): Uint8Array {
  const mask = new Uint8Array(image.width * image.height);
  const backgroundLuma = background[0] * 0.2126 + background[1] * 0.7152 + background[2] * 0.0722;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const [r, g, b] = pixelRgb(image, x, y);
      const maxDelta = Math.max(Math.abs(r - background[0]), Math.abs(g - background[1]), Math.abs(b - background[2]));
      const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (maxDelta >= 20 || backgroundLuma - luma >= 14 || (chroma >= 20 && Math.max(r, g, b) < 253)) {
        mask[y * image.width + x] = 1;
      }
    }
  }
  return mask;
}

function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      const minY = Math.max(0, y - radius);
      const maxY = Math.min(height - 1, y + radius);
      const minX = Math.max(0, x - radius);
      const maxX = Math.min(width - 1, x + radius);
      for (let yy = minY; yy <= maxY; yy += 1) {
        out.fill(1, yy * width + minX, yy * width + maxX + 1);
      }
    }
  }
  return out;
}

function colourHistogram(image: RawAnalysisImage, region: PixelRegion): number[] {
  const bins = new Array<number>(64).fill(0);
  let total = 0;
  const right = Math.min(image.width, region.left + region.width);
  const bottom = Math.min(image.height, region.top + region.height);
  for (let y = Math.max(0, region.top); y < bottom; y += 2) {
    for (let x = Math.max(0, region.left); x < right; x += 2) {
      const [r, g, b] = pixelRgb(image, x, y);
      const bin = (r >> 6) * 16 + (g >> 6) * 4 + (b >> 6);
      bins[bin] += 1;
      total += 1;
    }
  }
  return total ? bins.map((value) => value / total) : bins;
}

function connectedComponents(
  originalMask: Uint8Array,
  connectionMask: Uint8Array,
  image: RawAnalysisImage,
): Component[] {
  const visited = new Uint8Array(connectionMask.length);
  const queueX = new Int32Array(connectionMask.length);
  const queueY = new Int32Array(connectionMask.length);
  const components: Component[] = [];

  for (let startY = 0; startY < image.height; startY += 1) {
    for (let startX = 0; startX < image.width; startX += 1) {
      const startIndex = startY * image.width + startX;
      if (!connectionMask[startIndex] || visited[startIndex]) continue;
      let head = 0;
      let tail = 0;
      queueX[tail] = startX;
      queueY[tail] = startY;
      tail += 1;
      visited[startIndex] = 1;
      let left = startX;
      let right = startX;
      let top = startY;
      let bottom = startY;
      let maskPixels = 0;

      while (head < tail) {
        const x = queueX[head];
        const y = queueY[head];
        head += 1;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        if (originalMask[y * image.width + x]) maskPixels += 1;

        const neighbours: Array<[number, number]> = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
        for (const [nextX, nextY] of neighbours) {
          if (nextX < 0 || nextX >= image.width || nextY < 0 || nextY >= image.height) continue;
          const nextIndex = nextY * image.width + nextX;
          if (!connectionMask[nextIndex] || visited[nextIndex]) continue;
          visited[nextIndex] = 1;
          queueX[tail] = nextX;
          queueY[tail] = nextY;
          tail += 1;
        }
      }

      const region = { left, top, width: right - left + 1, height: bottom - top + 1 };
      components.push({ ...region, mask_pixels: maskPixels, histogram: colourHistogram(image, region) });
    }
  }
  return components;
}

function histogramDistance(a: number[], b: number[]): number {
  let distance = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) distance += Math.abs(a[index] - b[index]);
  return distance / 2;
}

function chooseRepeatedComponents(components: Component[], width: number, height: number): {
  selected: Component[];
  dimensionCv: number | null;
  meanHistogramDistance: number | null;
  reason: string;
} {
  const imageArea = width * height;
  const substantial = components.filter((component) => {
    const boxArea = component.width * component.height;
    return component.width >= width * 0.065
      && component.height >= height * 0.09
      && boxArea >= imageArea * 0.009
      && component.mask_pixels >= imageArea * 0.0015;
  });
  if (substantial.length < 2) {
    return { selected: [], dimensionCv: null, meanHistogramDistance: null, reason: "fewer than two substantial foreground regions" };
  }

  const sorted = [...substantial].sort((a, b) => (b.width * b.height) - (a.width * a.height));
  let best: { selected: Component[]; dimensionCv: number; meanHistogramDistance: number; score: number } | null = null;

  for (const anchor of sorted) {
    const anchorAspect = anchor.width / anchor.height;
    const cluster = substantial.filter((candidate) => {
      const widthRatio = candidate.width / anchor.width;
      const heightRatio = candidate.height / anchor.height;
      const aspectRatio = (candidate.width / candidate.height) / anchorAspect;
      return widthRatio >= 0.72 && widthRatio <= 1.38
        && heightRatio >= 0.72 && heightRatio <= 1.38
        && aspectRatio >= 0.75 && aspectRatio <= 1.33;
    });
    if (cluster.length < 2) continue;

    const widths = cluster.map((component) => component.width);
    const heights = cluster.map((component) => component.height);
    const dimensionCv = Math.max(coefficientOfVariation(widths), coefficientOfVariation(heights));
    if (dimensionCv > 0.16) continue;

    const medoid = cluster.reduce((bestCandidate, candidate) => {
      const candidateDistance = cluster.reduce((sum, other) => sum + histogramDistance(candidate.histogram, other.histogram), 0);
      const bestDistance = cluster.reduce((sum, other) => sum + histogramDistance(bestCandidate.histogram, other.histogram), 0);
      return candidateDistance < bestDistance ? candidate : bestCandidate;
    }, cluster[0]);
    const meanHistogramDistance = cluster.reduce(
      (sum, component) => sum + histogramDistance(medoid.histogram, component.histogram),
      0,
    ) / cluster.length;
    if (meanHistogramDistance > 0.22) continue;

    const boxCoverage = cluster.reduce((sum, component) => sum + component.width * component.height, 0) / imageArea;
    if (boxCoverage < 0.08) continue;
    const score = cluster.length * 10 + boxCoverage * 5 - dimensionCv * 10 - meanHistogramDistance * 4;
    if (!best || score > best.score) best = { selected: cluster, dimensionCv, meanHistogramDistance, score };
  }

  if (!best) {
    return { selected: [], dimensionCv: null, meanHistogramDistance: null, reason: "foreground regions are not sufficiently repeated" };
  }

  const selected = [...best.selected].sort((a, b) => {
    const rowTolerance = Math.max(4, Math.round(median(best.selected.map((component) => component.height)) * 0.25));
    if (Math.abs(a.top - b.top) > rowTolerance) return a.top - b.top;
    return a.left - b.left;
  });
  return {
    selected,
    dimensionCv: best.dimensionCv,
    meanHistogramDistance: best.meanHistogramDistance,
    reason: `confirmed ${selected.length} repeated foreground regions`,
  };
}

function mapRegionToSource(region: PixelRegion, analysis: RawAnalysisImage, sourceWidth: number, sourceHeight: number): PixelRegion {
  const left = Math.floor(region.left * sourceWidth / analysis.width);
  const top = Math.floor(region.top * sourceHeight / analysis.height);
  const right = Math.ceil((region.left + region.width) * sourceWidth / analysis.width);
  const bottom = Math.ceil((region.top + region.height) * sourceHeight / analysis.height);
  return {
    left: clampInteger(left, 0, sourceWidth - 1),
    top: clampInteger(top, 0, sourceHeight - 1),
    width: clampInteger(right - left, 1, sourceWidth - left),
    height: clampInteger(bottom - top, 1, sourceHeight - top),
  };
}

function padRegion(region: PixelRegion, sourceWidth: number, sourceHeight: number, fraction = 0.035): PixelRegion {
  const padding = Math.round(Math.min(region.width, region.height) * fraction);
  const left = Math.max(0, region.left - padding);
  const top = Math.max(0, region.top - padding);
  const right = Math.min(sourceWidth, region.left + region.width + padding);
  const bottom = Math.min(sourceHeight, region.top + region.height + padding);
  return { left, top, width: right - left, height: bottom - top };
}

function regionIntersection(a: PixelRegion, b: PixelRegion): PixelRegion | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

function relativeRegion(parent: PixelRegion, x: number, y: number, width: number, height: number): PixelRegion {
  return {
    left: Math.round(parent.left + parent.width * x),
    top: Math.round(parent.top + parent.height * y),
    width: Math.max(1, Math.round(parent.width * width)),
    height: Math.max(1, Math.round(parent.height * height)),
  };
}

function analysisInformationScore(mask: Uint8Array, image: RawAnalysisImage, sourceRegion: PixelRegion, sourceWidth: number, sourceHeight: number): number {
  const mapped = {
    left: Math.floor(sourceRegion.left * image.width / sourceWidth),
    top: Math.floor(sourceRegion.top * image.height / sourceHeight),
    width: Math.max(1, Math.ceil(sourceRegion.width * image.width / sourceWidth)),
    height: Math.max(1, Math.ceil(sourceRegion.height * image.height / sourceHeight)),
  };
  const clipped = regionIntersection(mapped, { left: 0, top: 0, width: image.width, height: image.height });
  if (!clipped) return 0;
  let foreground = 0;
  let edges = 0;
  let samples = 0;
  for (let y = clipped.top; y < clipped.top + clipped.height; y += 1) {
    for (let x = clipped.left; x < clipped.left + clipped.width; x += 1) {
      const index = y * image.width + x;
      foreground += mask[index];
      samples += 1;
      const [r, g, b] = pixelRgb(image, x, y);
      const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
      if (x + 1 < clipped.left + clipped.width) {
        const [rr, rg, rb] = pixelRgb(image, x + 1, y);
        const nextLuma = rr * 0.2126 + rg * 0.7152 + rb * 0.0722;
        if (Math.abs(luma - nextLuma) >= 22) edges += 1;
      }
      if (y + 1 < clipped.top + clipped.height) {
        const [br, bg, bb] = pixelRgb(image, x, y + 1);
        const nextLuma = br * 0.2126 + bg * 0.7152 + bb * 0.0722;
        if (Math.abs(luma - nextLuma) >= 22) edges += 1;
      }
    }
  }
  if (!samples) return 0;
  return foreground / samples * 0.65 + Math.min(1, edges / samples * 8) * 0.35;
}

function chooseRepresentative(components: Component[], analysisWidth: number, analysisHeight: number): number {
  const medianWidth = median(components.map((component) => component.width));
  const medianHeight = median(components.map((component) => component.height));
  let bestIndex = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    const sizeDeviation = Math.abs(component.width - medianWidth) / medianWidth
      + Math.abs(component.height - medianHeight) / medianHeight;
    const centerX = component.left + component.width / 2;
    const centerY = component.top + component.height / 2;
    const borderPenalty = 1 - Math.min(centerX, analysisWidth - centerX, centerY, analysisHeight - centerY)
      / Math.max(1, Math.min(analysisWidth, analysisHeight) / 2);
    const score = sizeDeviation * 3 + borderPenalty;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function outputDimensions(region: PixelRegion, maxEdge: number, maxUpscale: number): { width: number; height: number; scale: number } {
  const longEdge = Math.max(region.width, region.height);
  const scale = Math.min(maxEdge / longEdge, maxUpscale);
  return {
    width: Math.max(1, Math.round(region.width * scale)),
    height: Math.max(1, Math.round(region.height * scale)),
    scale,
  };
}

async function renderView(
  canonical: sharp.Sharp,
  sourceSha256: string,
  role: DerivedViewRole,
  sourceWidth: number,
  sourceHeight: number,
  region: PixelRegion | null,
  maxEdge: number,
  maxUpscale: number,
): Promise<DerivedVisualView> {
  const effectiveRegion = region ?? { left: 0, top: 0, width: sourceWidth, height: sourceHeight };
  const dimensions = outputDimensions(effectiveRegion, maxEdge, region ? maxUpscale : 1);
  let pipeline = canonical.clone();
  if (region) pipeline = pipeline.extract(region);
  pipeline = pipeline.resize(dimensions.width, dimensions.height, {
    fit: "fill",
    kernel: sharp.kernel.lanczos3,
  });

  const isFull = role === "full";
  const rendered = isFull
    ? await pipeline.jpeg({ quality: 92, chromaSubsampling: "4:4:4", progressive: false, mozjpeg: false }).toBuffer({ resolveWithObject: true })
    : await pipeline.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false, progressive: false }).toBuffer({ resolveWithObject: true });
  const bytes = rendered.data;
  const digest = sha256(bytes);
  const transform: DerivedViewTransform = {
    coordinate_space: "auto_oriented_source_pixels",
    source_region: region,
    flatten_background: "#ffffff",
    colourspace: "srgb",
    resize: {
      kernel: "lanczos3",
      width: rendered.info.width,
      height: rendered.info.height,
      without_enlargement: !region,
      maximum_upscale: region ? maxUpscale : 1,
    },
    encoding: isFull
      ? { format: "jpeg", quality: 92, chroma_subsampling: "4:4:4", compression_level: null }
      : { format: "png", quality: null, chroma_subsampling: null, compression_level: 9 },
  };
  const provenanceSha256 = sha256(JSON.stringify({
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    source_sha256: sourceSha256,
    role,
    output_sha256: digest,
    transform,
  }));
  return {
    view_id: `${role}-${digest.slice(0, 16)}`,
    role,
    media_type: isFull ? "image/jpeg" : "image/png",
    width: rendered.info.width,
    height: rendered.info.height,
    byte_length: bytes.length,
    sha256: digest,
    provenance_sha256: provenanceSha256,
    transform,
    bytes,
  };
}

function orientationAdjustedDimensions(width: number, height: number, orientation: number | undefined): { width: number; height: number } {
  if (orientation && orientation >= 5 && orientation <= 8) return { width: height, height: width };
  return { width, height };
}

/**
 * Create deterministic full/detail views from immutable source bytes.
 *
 * Detail regions are evidence-neutral. A caller must never use a detail crop to
 * infer the outer package count, grid structure, background, or front coverage;
 * those checks belong exclusively to the returned full view.
 */
export async function preprocessCatalogVisual(
  sourceBytes: Buffer,
  options: VisualPreprocessOptions = {},
): Promise<VisualPreprocessResult> {
  if (!Buffer.isBuffer(sourceBytes) || sourceBytes.length === 0) throw new Error("sourceBytes must be a non-empty Buffer");
  const resolved = resolveOptions(options);
  const sourceSha256 = sha256(sourceBytes);
  const sourceByteLength = sourceBytes.length;
  const input = sharp(sourceBytes, { failOn: "error", limitInputPixels: resolved.limit_input_pixels });
  const metadata = await input.metadata();
  if (!metadata.width || !metadata.height || !metadata.format) throw new Error("source image metadata is incomplete");
  const oriented = orientationAdjustedDimensions(metadata.width, metadata.height, metadata.orientation);
  const canonical = sharp(sourceBytes, { failOn: "error", limitInputPixels: resolved.limit_input_pixels })
    .rotate()
    .flatten({ background: WHITE })
    .toColourspace("srgb");

  const analysisRendered = await canonical.clone()
    .resize(resolved.analysis_max_edge, resolved.analysis_max_edge, {
      fit: "inside",
      withoutEnlargement: true,
      kernel: sharp.kernel.lanczos3,
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const analysisImage: RawAnalysisImage = {
    data: analysisRendered.data,
    width: analysisRendered.info.width,
    height: analysisRendered.info.height,
    channels: analysisRendered.info.channels,
  };
  const background = estimateBackground(analysisImage);
  const foregroundMask = buildForegroundMask(analysisImage, background.rgb);
  let selected: Component[] = [];
  let reason = "border background is not confidently near-white";
  let dimensionCv: number | null = null;
  let meanHistogramDistance: number | null = null;
  if (background.acceptable) {
    const connectionMask = dilate(foregroundMask, analysisImage.width, analysisImage.height, 2);
    const components = connectedComponents(foregroundMask, connectionMask, analysisImage);
    const repetition = chooseRepeatedComponents(components, analysisImage.width, analysisImage.height);
    selected = repetition.selected;
    reason = repetition.reason;
    dimensionCv = repetition.dimensionCv;
    meanHistogramDistance = repetition.meanHistogramDistance;
  }

  const sourceRegions = selected.map((component) => mapRegionToSource(component, analysisImage, oriented.width, oriented.height));
  const representativeIndex = selected.length
    ? chooseRepresentative(selected, analysisImage.width, analysisImage.height)
    : null;
  const fullView = await renderView(
    canonical,
    sourceSha256,
    "full",
    oriented.width,
    oriented.height,
    null,
    resolved.full_max_edge,
    1,
  );
  const views: DerivedVisualView[] = [fullView];

  if (representativeIndex !== null) {
    const tile = padRegion(sourceRegions[representativeIndex], oriented.width, oriented.height);
    views.push(await renderView(
      canonical,
      sourceSha256,
      "tile_front",
      oriented.width,
      oriented.height,
      tile,
      resolved.crop_max_edge,
      resolved.max_crop_upscale,
    ));

    const bottomLabel = relativeRegion(tile, 0, 0.60, 1, 0.40);
    if (analysisInformationScore(foregroundMask, analysisImage, bottomLabel, oriented.width, oriented.height) >= 0.10) {
      views.push(await renderView(
        canonical,
        sourceSha256,
        "bottom_label",
        oriented.width,
        oriented.height,
        bottomLabel,
        resolved.crop_max_edge,
        resolved.max_crop_upscale,
      ));
    }

    const topLeftBadge = relativeRegion(tile, 0, 0, 0.58, 0.48);
    const topRight = relativeRegion(tile, 0.42, 0, 0.58, 0.48);
    const topLeftScore = analysisInformationScore(foregroundMask, analysisImage, topLeftBadge, oriented.width, oriented.height);
    const topRightScore = analysisInformationScore(foregroundMask, analysisImage, topRight, oriented.width, oriented.height);
    if (topLeftScore >= 0.105 && topLeftScore >= topRightScore * 0.88) {
      views.push(await renderView(
        canonical,
        sourceSha256,
        "top_left_badge",
        oriented.width,
        oriented.height,
        topLeftBadge,
        resolved.crop_max_edge,
        resolved.max_crop_upscale,
      ));
    }
  }

  // The caller may retain sourceBytes; proving the same digest here documents
  // that no in-place mutation was performed by preprocessing.
  if (sha256(sourceBytes) !== sourceSha256 || sourceBytes.length !== sourceByteLength) {
    throw new Error("source buffer changed during preprocessing");
  }

  const status: VisualPreprocessStatus = selected.length ? "confirmed_repetition" : "full_only";
  const analysisForHash = {
    status,
    reason,
    analysis_width: analysisImage.width,
    analysis_height: analysisImage.height,
    background_rgb: background.rgb,
    border_outlier_fraction: stableNumber(background.outlierFraction),
    regions: sourceRegions,
    representative_region_index: representativeIndex,
    dimension_cv: dimensionCv === null ? null : stableNumber(dimensionCv),
    mean_histogram_distance: meanHistogramDistance === null ? null : stableNumber(meanHistogramDistance),
  };
  const analysisSha256 = sha256(JSON.stringify({
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    source_sha256: sourceSha256,
    options: resolved,
    analysis: analysisForHash,
  }));

  return {
    schema_version: VISUAL_PREPROCESS_SCHEMA,
    preprocessor_version: VISUAL_PREPROCESS_VERSION,
    source: {
      sha256: sourceSha256,
      byte_length: sourceBytes.length,
      format: metadata.format,
      width: metadata.width,
      height: metadata.height,
      orientation: metadata.orientation ?? null,
      oriented_width: oriented.width,
      oriented_height: oriented.height,
    },
    analysis: {
      ...analysisForHash,
      region_count: sourceRegions.length,
      analysis_sha256: analysisSha256,
    },
    views,
  };
}
