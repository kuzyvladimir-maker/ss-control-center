/**
 * ОТСЕВ ДОНОРСКОГО ФОТО УПАКОВКИ перед owner-ревью.
 *
 * Фото коробки идёт в prompt как pinned reference: модель копирует с него
 * лицевую панель. Значит всё лишнее на этом фото она нарисует на упаковке.
 *
 * Владелец, разбор галереи 2026-08-15:
 *   - «на некоторых картинках есть что-то еще, кроме самой коробочки. Это вот
 *     надписи левые, где написано new fridge am or freeze am» — это НАКЛАДКА
 *     ритейлера поверх снимка, а не печать на коробке;
 *   - «на honey вот здесь вот коробка указана вместе с единичкой» — рядом с
 *     коробкой лежит отдельный сэндвич, кадр композитный.
 *
 * Такое фото нельзя показывать владельцу как кандидата и тем более отдавать
 * генератору. Отсев машинный, на подписке ($0); зрение недоступно — кандидат
 * не проходит (fail-closed), потому что непроверенная художка хуже, чем её
 * отсутствие.
 */

import { identifyImageViaClaudeCli } from "@/lib/image-gen/codex-worker";
import { fetchImageBuffer } from "@/lib/walmart/multipack/composite";

export interface PackageArtScreenInput {
  image_url: string;
  /** Вкус, который ожидаем увидеть на лицевой панели. */
  expectedFlavor: string;
  /** Счёт, напечатанный на коробке. */
  expectedCount: number;
}

export interface PackageArtScreenResult {
  clean: boolean;
  verified: boolean;
  reasons: string[];
  observed?: Record<string, unknown>;
}

function screenPrompt(input: PackageArtScreenInput): string {
  return (
    `You are screening a retailer product photo for use as PACKAGE ART REFERENCE.\n` +
    `It will be handed to an image model that copies the carton front exactly, so ` +
    `anything present in this photo will end up printed on the drawn carton.\n\n` +
    `The photo is USABLE only when it shows ONE Smucker's Uncrustables retail ` +
    `carton, alone, with nothing else in the frame.\n\n` +
    `Expected flavor: "${input.expectedFlavor}". Expected printed count: ${input.expectedCount}.\n\n` +
    `Reject for ANY of these:\n` +
    `- a marketing banner or sticker ADDED ON TOP of the photo by the retailer ` +
    `(for example a coloured bar reading "NEW: Fridge 'Em or Freeze 'Em", ` +
    `"New Look", a rollback/price flag). Printing that is part of the carton ` +
    `artwork itself is fine — the test is whether it sits on the photo as an ` +
    `overlay rather than on the box surface;\n` +
    `- a loose individual sandwich, wrapper, or a second product beside the carton;\n` +
    `- more than one carton, a lifestyle scene, hands, table, props;\n` +
    `- the carton is angled/cropped so the front panel is not fully readable.\n\n` +
    `Answer ONLY with JSON:\n` +
    `{\n` +
    `  "single_carton_alone_on_plain_background": <true|false>,\n` +
    `  "overlay_banner_or_sticker_added_on_photo": <true|false>,\n` +
    `  "overlay_text": "<the overlay wording, or empty>",\n` +
    `  "loose_sandwich_or_second_product_visible": <true|false>,\n` +
    `  "front_panel_fully_visible": <true|false>,\n` +
    `  "printed_count_on_carton": "<the number printed on the box, or empty>",\n` +
    `  "flavor_on_carton": "<flavor as printed>",\n` +
    `  "notes": "<one sentence>"\n` +
    `}`
  );
}

function asBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (/^(true|yes)$/i.test(v)) return true;
    if (/^(false|no)$/i.test(v)) return false;
  }
  return null;
}

/** Один проход зрения по кандидату. */
export async function screenPackageArt(
  input: PackageArtScreenInput,
): Promise<PackageArtScreenResult> {
  let b64: string;
  try {
    b64 = (await fetchImageBuffer(input.image_url)).toString("base64");
  } catch (e) {
    return { clean: false, verified: false, reasons: [`image fetch failed: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const raw = await identifyImageViaClaudeCli([b64], screenPrompt(input));
  if (!raw) return { clean: false, verified: false, reasons: ["vision unavailable"] };

  const reasons: string[] = [];
  if (asBool(raw.overlay_banner_or_sticker_added_on_photo) === true) {
    const t = String(raw.overlay_text ?? "").trim();
    reasons.push(`накладка ритейлера поверх фото${t ? `: «${t}»` : ""}`);
  }
  if (asBool(raw.loose_sandwich_or_second_product_visible) === true) {
    reasons.push("в кадре отдельный сэндвич или второй товар");
  }
  if (asBool(raw.single_carton_alone_on_plain_background) === false) {
    reasons.push("не одиночная коробка на простом фоне");
  }
  if (asBool(raw.front_panel_fully_visible) === false) {
    reasons.push("лицевая панель видна не полностью");
  }
  const printed = String(raw.printed_count_on_carton ?? "").replace(/\D/g, "");
  if (printed && Number(printed) !== input.expectedCount) {
    reasons.push(`на коробке напечатано ${printed}, ожидалось ${input.expectedCount}`);
  }
  return { clean: reasons.length === 0, verified: true, reasons, observed: raw };
}
