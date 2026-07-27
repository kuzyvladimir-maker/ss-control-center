/**
 * Render runner for the Uncrustables studio conveyor
 * (uncrustables-studio-integration-plan.md, Lib-экстракции).
 *
 * Оборачивает существующий generateMainImage (Codex worker, $0/image) и СРАЗУ
 * после рендера скачивает точные R2-байты, считает sha256 и размеры PNG —
 * кандидат в машине состояний хранит хэш с момента RENDERED, а approve-гейт
 * позже пере-скачивает и сверяет тот же хэш (никакого доверия кэшу клиента).
 *
 * Никакой записи в БД и никаких Amazon-вызовов: чистая функция рендера.
 */

import { createHash } from "node:crypto";

import { generateMainImage } from "./image-generation";

export interface UncrustablesRenderRequest {
  /** Слаг кандидата; R2-путь = `${r2Prefix}-${slug}` (у trial: `trial1-`). */
  slug: string;
  /** Полный промпт: base prompt + contractText из uncrustables-render-contract. */
  prompt: string;
  referenceUrls: string[];
  /** Префикс R2-пути; студия использует свой, чтобы не задевать trial-объекты. */
  r2Prefix: string;
}

export interface UncrustablesRenderSuccess {
  ok: true;
  imageUrl: string;
  imageSha256: string;
  pixelDimensions: { width: number; height: number };
  byteLength: number;
  durationMs: number;
  model: string | null;
}

export interface UncrustablesRenderFailure {
  ok: false;
  /** WORKER_* — рендер не состоялся; POSTCHECK_* — рендер есть, но байты негодные. */
  code:
    | "WORKER_ERROR"
    | "WORKER_NO_IMAGE"
    | "POSTCHECK_FETCH_FAILED"
    | "POSTCHECK_NOT_PNG"
    | "POSTCHECK_TOO_SMALL";
  error: string;
  imageUrl?: string;
  durationMs: number;
}

export type UncrustablesRenderResult =
  | UncrustablesRenderSuccess
  | UncrustablesRenderFailure;

/** Минимум стороны для production-main (см. preflight: 2000px+). */
export const MIN_MAIN_DIMENSION_PX = 2000;

function pngDimensions(
  bytes: Buffer,
): { width: number; height: number } | null {
  const pngSignature = "89504e470d0a1a0a";
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).toString("hex") === pngSignature &&
    bytes.subarray(12, 16).toString("ascii") === "IHDR"
  ) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  return null;
}

export interface UncrustablesRenderRunnerDeps {
  /** Подменяется в тестах; по умолчанию — боевой generateMainImage. */
  render?: typeof generateMainImage;
  /** Подменяется в тестах; по умолчанию — fetch точных байтов по URL. */
  fetchBytes?: (url: string) => Promise<Buffer>;
  now?: () => number;
}

async function defaultFetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, { cache: "no-store", redirect: "error" });
  if (!response.ok) throw new Error(`R2 returned HTTP ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}

/** Один рендер → немедленный postcheck байтов. Не бросает: всегда Result. */
export async function renderUncrustablesMainCandidate(
  request: UncrustablesRenderRequest,
  deps: UncrustablesRenderRunnerDeps = {},
): Promise<UncrustablesRenderResult> {
  const render = deps.render ?? generateMainImage;
  const fetchBytes = deps.fetchBytes ?? defaultFetchBytes;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const durationMs = () => now() - startedAt;

  let imageUrl: string | null = null;
  let model: string | null = null;
  try {
    const out = await render({
      prompt: request.prompt,
      r2_path_slug: `${request.r2Prefix}-${request.slug}`,
      reference_urls: request.referenceUrls,
    });
    imageUrl = out.image_url ?? null;
    model = out.model ?? null;
    if (!imageUrl) {
      return {
        ok: false,
        code: "WORKER_NO_IMAGE",
        error: out.error ?? "worker returned no image and no error",
        durationMs: durationMs(),
      };
    }
    if (out.error) {
      return {
        ok: false,
        code: "WORKER_ERROR",
        error: out.error,
        imageUrl,
        durationMs: durationMs(),
      };
    }
  } catch (error) {
    return {
      ok: false,
      code: "WORKER_ERROR",
      error: error instanceof Error ? error.message : String(error),
      durationMs: durationMs(),
    };
  }

  let bytes: Buffer;
  try {
    bytes = await fetchBytes(imageUrl);
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new Error("empty response body");
    }
  } catch (error) {
    return {
      ok: false,
      code: "POSTCHECK_FETCH_FAILED",
      error: error instanceof Error ? error.message : String(error),
      imageUrl,
      durationMs: durationMs(),
    };
  }
  const dims = pngDimensions(bytes);
  if (!dims) {
    return {
      ok: false,
      code: "POSTCHECK_NOT_PNG",
      error: "rendered bytes are not a PNG",
      imageUrl,
      durationMs: durationMs(),
    };
  }
  if (dims.width < MIN_MAIN_DIMENSION_PX || dims.height < MIN_MAIN_DIMENSION_PX) {
    return {
      ok: false,
      code: "POSTCHECK_TOO_SMALL",
      error: `rendered ${dims.width}x${dims.height}, production-main requires ${MIN_MAIN_DIMENSION_PX}px+`,
      imageUrl,
      durationMs: durationMs(),
    };
  }
  return {
    ok: true,
    imageUrl,
    imageSha256: createHash("sha256").update(bytes).digest("hex"),
    pixelDimensions: dims,
    byteLength: bytes.length,
    durationMs: durationMs(),
    model,
  };
}
