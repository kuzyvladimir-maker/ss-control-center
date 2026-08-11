/**
 * QA OFFICER для главной картинки frozen-набора (кулерная сцена).
 *
 * Контракт: BUNDLE_FACTORY_FROZEN_MAIN_IMAGE_v2.0. Картинку генерирует
 * GPT Image 2 по якорю кулера, то есть она НЕ детерминирована: модель может
 * потерять или добавить коробку, исказить печатный текст, перепутать бейдж.
 * Этот офицер — машинная замена ручной агентской вычитки, чтобы конвейер мог
 * крутиться без оператора.
 *
 * Голосование 3 прогонами (как у composite-qa): блокирует только то, что
 * большинство увидело одинаково — одиночная галлюцинация модели-проверяющего
 * не должна заворачивать корректную картинку.
 *
 * Работает на подписке через box worker ($0). Если зрение недоступно —
 * возвращаем pass:false + verified:false: для НЕдетерминированной картинки
 * «не смог проверить» означает «не публиковать», в отличие от композита.
 */

import { identifyImageViaClaudeCli } from "@/lib/image-gen/codex-worker";
import { fetchImageBuffer } from "@/lib/walmart/multipack/composite";

export interface FrozenMainQaComponent {
  /** Точный текст лицевой панели (или имя вкуса, если панель не задана). */
  label: string;
  /** Сколько коробок этого вкуса должно быть видно. */
  boxes: number;
  /** Печатный счётчик на коробке: 4, 8 или 10. */
  boxSize: number;
}

export interface FrozenMainQaInput {
  image_url: string;
  comps: FrozenMainQaComponent[];
}

export interface FrozenMainQaResult {
  pass: boolean;
  verified: boolean;
  hard_fails: string[];
  warnings: string[];
  observed?: Record<string, unknown>;
  cost_cents: 0;
}

function qaPrompt(comps: FrozenMainQaComponent[]): string {
  const expected = comps
    .map((c) => `- ${c.boxes} carton(s) of "${c.label}", each printing the count badge "${c.boxSize}"`)
    .join("\n");
  const totalBoxes = comps.reduce((s, c) => s + c.boxes, 0);
  return (
    `You are a strict Amazon MAIN-image QA reviewer for a frozen gift set.\n\n` +
    `The image must show an open white foam cooler branded "SALUTEM SOLUTIONS" ` +
    `with a green lotus emblem, containing genuine Smucker's Uncrustables retail ` +
    `cartons, plus EXACTLY four white gel packs (two inside the cooler, two ` +
    `standing outside in front), on a pure white background.\n\n` +
    `EXPECTED CONTENTS (count every carton front you can see):\n${expected}\n` +
    `TOTAL cartons expected: ${totalBoxes}.\n\n` +
    `Report ONLY what you actually see. Answer with JSON:\n` +
    `{\n` +
    `  "visible_cartons_total": <integer>,\n` +
    `  "cartons_per_flavor": [{"label": "<flavor as printed>", "count": <int>, "badge_digit": "<digit you read>"}],\n` +
    `  "all_cartons_are_genuine_uncrustables": <true|false>,\n` +
    `  "wordmark_complete_on_every_carton": <true|false>,\n` +
    `  "garbled_or_misspelled_text_on_any_front_panel": <true|false>,\n` +
    `  "misspelled_words": ["..."],\n` +
    `  "gel_packs_total": <integer>,\n` +
    `  "gel_packs_all_say_keep_frozen": <true|false>,\n` +
    `  "cooler_has_green_lotus_and_salutem_wordmark": <true|false>,\n` +
    `  "background_is_pure_white": <true|false>,\n` +
    `  "loose_ice_people_props_or_overlay_text": <true|false>,\n` +
    `  "notes": "<one sentence>"\n` +
    `}\n\n` +
    `Rules for judging text: ignore blur on tiny print smaller than ~10 pixels ` +
    `per character — that is resolution, not a misspelling. Only report a ` +
    `misspelling when a word is large enough to read clearly and is wrong ` +
    `(for example "Strawberru", "UnTrustables", "KEEP PROZEN", "SMUCKEO'S"). ` +
    `A retailer flash such as "Only at Walmart" PRINTED on genuine packaging is ` +
    `normal package art, not a defect.`
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
function asInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  return Number.isInteger(n) ? n : null;
}

async function runOnePass(input: FrozenMainQaInput): Promise<FrozenMainQaResult> {
  let b64: string;
  try {
    const buf = await fetchImageBuffer(input.image_url);
    b64 = buf.toString("base64");
  } catch (e) {
    return {
      pass: false, verified: false, cost_cents: 0, warnings: [],
      hard_fails: [`image fetch failed: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
  const raw = await identifyImageViaClaudeCli([b64], qaPrompt(input.comps));
  if (!raw) {
    return {
      pass: false, verified: false, cost_cents: 0, warnings: [],
      hard_fails: ["vision unavailable"],
    };
  }
  const fails: string[] = [];
  const warns: string[] = [];
  const expectedTotal = input.comps.reduce((s, c) => s + c.boxes, 0);

  const total = asInt(raw.visible_cartons_total);
  if (total != null && total !== expectedTotal) {
    fails.push(`carton total ${total} vs expected ${expectedTotal}`);
  }
  if (asBool(raw.all_cartons_are_genuine_uncrustables) === false) {
    fails.push("a carton is not genuine Uncrustables packaging");
  }
  if (asBool(raw.wordmark_complete_on_every_carton) === false) {
    fails.push("Uncrustables wordmark incomplete on a carton");
  }
  if (asBool(raw.garbled_or_misspelled_text_on_any_front_panel) === true) {
    const words = Array.isArray(raw.misspelled_words) ? raw.misspelled_words.join(", ") : "";
    fails.push(`misspelled front-panel text${words ? `: ${words}` : ""}`);
  }
  const gels = asInt(raw.gel_packs_total);
  if (gels != null && gels !== 4) fails.push(`gel packs ${gels} vs 4`);
  if (asBool(raw.gel_packs_all_say_keep_frozen) === false) {
    fails.push("a gel pack does not read KEEP FROZEN");
  }
  if (asBool(raw.cooler_has_green_lotus_and_salutem_wordmark) === false) {
    fails.push("cooler branding wrong");
  }
  if (asBool(raw.background_is_pure_white) === false) fails.push("background not pure white");
  if (asBool(raw.loose_ice_people_props_or_overlay_text) === true) {
    fails.push("forbidden props/overlay present");
  }
  // Побейджевая сверка: расходится счётчик — это подмена товара, блокер.
  const perFlavor = Array.isArray(raw.cartons_per_flavor) ? raw.cartons_per_flavor : [];
  for (const c of input.comps) {
    const seen = perFlavor.find((x: unknown) => {
      const o = x as Record<string, unknown>;
      const l = String(o?.label ?? "").toLowerCase();
      return l && c.label.toLowerCase().includes(l.split("/")[0].trim().slice(0, 12));
    }) as Record<string, unknown> | undefined;
    if (!seen) { warns.push(`flavor not matched in report: ${c.label}`); continue; }
    const cnt = asInt(seen.count);
    if (cnt != null && cnt !== c.boxes) fails.push(`${c.label}: ${cnt} cartons vs ${c.boxes}`);
    const badge = String(seen.badge_digit ?? "").replace(/\D/g, "");
    if (badge && badge !== String(c.boxSize)) {
      fails.push(`${c.label}: badge "${badge}" vs "${c.boxSize}"`);
    }
  }
  return {
    pass: fails.length === 0, verified: true, hard_fails: fails,
    warnings: warns, observed: raw, cost_cents: 0,
  };
}

/** Три прогона, решает большинство. Fail-closed при недоступном зрении. */
export async function qaFrozenMainImage(
  input: FrozenMainQaInput,
): Promise<FrozenMainQaResult> {
  const first = await runOnePass(input);
  if (!first.verified) return first; // зрение недоступно — не публикуем
  if (first.pass) {
    // Подтверждаем ещё двумя прогонами: пропуск дороже лишнего ре-ролла.
    const rest = [await runOnePass(input), await runOnePass(input)].filter((r) => r.verified);
    const passes = 1 + rest.filter((r) => r.pass).length;
    const votes = 1 + rest.length;
    if (passes >= Math.ceil(votes / 2)) {
      return { ...first, warnings: [...first.warnings, `QA majority-pass (${passes}/${votes})`] };
    }
    const merged = rest.flatMap((r) => r.hard_fails);
    return { ...first, pass: false, hard_fails: merged, warnings: [...first.warnings, `QA majority-fail (${passes}/${votes})`] };
  }
  // Первый прогон завернул — переспрашиваем, чтобы не резать по галлюцинации.
  const second = await runOnePass(input);
  if (second.verified && second.pass) {
    const third = await runOnePass(input);
    if (third.verified && third.pass) {
      return { ...third, warnings: [...third.warnings, "QA majority-pass (2/3) after first reject"] };
    }
  }
  return first;
}
