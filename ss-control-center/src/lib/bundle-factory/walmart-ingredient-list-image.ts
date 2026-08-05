/**
 * The ingredient-list image Walmart requires to create a food listing.
 *
 * `ingredientListImage` is required for food product types and it is an IMAGE,
 * not text. We hold the manufacturer's ingredient statement as text, and donor
 * galleries usually hold five to seven photographs — but on inspection those are
 * mostly marketing panels ("14g of protein", "Heat & Eat") and a Nutrition Facts
 * crop, which is a different panel and must not be passed off as this one.
 *
 * Owner decision 2026-08-03: look for the real photograph first, render from the
 * manufacturer's own text when there isn't one. Both are factual; only the order
 * of preference is a judgement call, and it is his.
 *
 * What this must never do is submit a picture that is not the ingredient list.
 * A Nutrition Facts panel in this field would be wrong on a live buyer-facing
 * listing, and wrong quietly, which is worse.
 */

import { createHash } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";

import { prisma } from "@/lib/prisma";
import { analyzeImagesWithFallback } from "@/lib/ai-vision";

const DEFAULT_BUCKET = "salutem-bundle-factory";
const PLACEHOLDER = "placeholder";
/** How many donor photographs are worth a look. Galleries are small. */
const MAX_CANDIDATES = 8;

let client: S3Client | null = null;

function r2Client(): S3Client | null {
  if (client) return client;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secret = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKey || !secret) return null;
  if ([accountId, accessKey, secret].includes(PLACEHOLDER)) return null;
  client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secret },
  });
  return client;
}

export interface IngredientListImageInput {
  /** Photographs from the donor, best candidates first. */
  candidateImageUrls: string[];
  /** The manufacturer's ingredient statement, exactly as catalogued. */
  ingredientsText: string | null | undefined;
  /** Used only to key the cache and name the object. */
  productKey: string;
}

export interface IngredientListImageResult {
  url: string;
  /** DONOR_PHOTO when a real panel was found, RENDERED when we drew the text. */
  source: "DONOR_PHOTO" | "RENDERED";
}

/** Cache key. Same ingredient statement → same rendered panel, drawn once. */
function cacheKey(input: IngredientListImageInput): string {
  const digest = createHash("sha256")
    .update(`${input.ingredientsText ?? ""}\n${input.candidateImageUrls.join("\n")}`)
    .digest("hex")
    .slice(0, 32);
  return `walmart_ingredient_image:${digest}`;
}

/**
 * Ask the vision model which photograph, if any, shows the ingredient list.
 *
 * Deliberately strict: the model is told to answer "none" unless it can read an
 * actual ingredient statement, because the failure we are guarding against is
 * confidently returning the Nutrition Facts panel.
 */
async function findDonorIngredientPanel(
  urls: string[],
): Promise<string | null> {
  const candidates = urls.slice(0, MAX_CANDIDATES);
  if (candidates.length === 0) return null;

  const images: string[] = [];
  const kept: string[] = [];
  for (const url of candidates) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > 4 * 1024 * 1024) continue;
      images.push(buffer.toString("base64"));
      kept.push(url);
    } catch {
      // An unreachable donor photo is simply not a candidate.
    }
  }
  if (images.length === 0) return null;

  const prompt = [
    "You are shown product photographs, numbered from 1.",
    "Identify the one that shows the INGREDIENT LIST — the statement that begins",
    'with "Ingredients:" and lists what the food is made of.',
    "",
    "A Nutrition Facts panel is NOT an ingredient list. Marketing images are not",
    "either. If no image clearly shows a readable ingredient statement, say none.",
    "",
    'Reply with JSON only: {"index": <1-based number>} or {"index": null}.',
  ].join("\n");

  try {
    const answer = await analyzeImagesWithFallback(images, prompt);
    const index = extractIndex(answer);
    if (index == null) return null;
    return kept[index - 1] ?? null;
  } catch {
    // Vision being unavailable is not a reason to publish nothing; we render.
    return null;
  }
}

function extractIndex(answer: unknown): number | null {
  const text = typeof answer === "string" ? answer : JSON.stringify(answer);
  const match = text.match(/"index"\s*:\s*(\d+|null)/i);
  if (!match || match[1]?.toLowerCase() === "null") return null;
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Escape for inclusion in SVG text. */
function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function wrap(text: string, perLine: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length + word.length + 1 > perLine) {
      if (line) lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Draw the manufacturer's ingredient statement as a plain, legible panel.
 *
 * No styling beyond legibility, and no wording of ours: the buyer must see the
 * manufacturer's declaration and nothing that could read as our claim.
 */
async function renderIngredientPanel(
  ingredientsText: string,
): Promise<Buffer> {
  const body = ingredientsText.trim().replace(/^ingredients:\s*/i, "");
  const lines = wrap(body, 78);
  const top = 150;
  const lineHeight = 38;
  const height = Math.max(1000, top + lines.length * lineHeight + 80);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="60" y="80" font-family="Helvetica, Arial, sans-serif" font-size="44" font-weight="bold" fill="#111111">Ingredients</text>
  ${lines
    .map((line, index) =>
      `<text x="60" y="${top + index * lineHeight}" font-family="Helvetica, Arial, sans-serif" font-size="26" fill="#222222">${xml(line)}</text>`)
    .join("\n  ")}
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function uploadPanel(key: string, body: Buffer): Promise<string | null> {
  const s3 = r2Client();
  if (!s3) return null;
  const bucket = process.env.R2_BUCKET_NAME || DEFAULT_BUCKET;
  const publicUrl = process.env.R2_PUBLIC_URL;
  if (!publicUrl) return null;
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: "image/png",
  }));
  return `${publicUrl.replace(/\/$/, "")}/${key}`;
}

/**
 * The panel exists but has nowhere to live.
 *
 * Distinct from "no ingredient statement": the data was there and the image
 * was drawn, so the fix is configuration, not catalogue work.
 */
export class IngredientPanelNotHostedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngredientPanelNotHostedError";
  }
}

/**
 * Resolve the ingredient-list image for a listing: donor photograph if one
 * genuinely shows the ingredient statement, otherwise the manufacturer's text
 * rendered as a panel.
 *
 * Returns null when neither is possible — the caller must then refuse to
 * publish rather than send something else in this field.
 */
export async function resolveIngredientListImage(
  input: IngredientListImageInput,
): Promise<IngredientListImageResult | null> {
  const key = cacheKey(input);
  const cached = await prisma.setting.findUnique({ where: { key } });
  if (cached?.value) {
    try {
      return JSON.parse(cached.value) as IngredientListImageResult;
    } catch {
      // A corrupt cache entry is simply recomputed below.
    }
  }

  const remember = async (result: IngredientListImageResult) => {
    await prisma.setting.upsert({
      where: { key },
      create: { key, value: JSON.stringify(result) },
      update: { value: JSON.stringify(result) },
    });
    return result;
  };

  const donor = await findDonorIngredientPanel(input.candidateImageUrls);
  if (donor) return remember({ url: donor, source: "DONOR_PHOTO" });

  const text = input.ingredientsText?.trim();
  if (!text) return null;

  const png = await renderIngredientPanel(text);
  const objectKey = `walmart-ingredients/${createHash("sha256")
    .update(`${input.productKey}\n${text}`)
    .digest("hex")}.png`;
  const url = await uploadPanel(objectKey, png);
  if (!url) {
    // The statement was found and the panel was drawn; only the hosting failed.
    // Reporting this as "no ingredient text" sent the operator looking for
    // missing data that was never missing.
    throw new IngredientPanelNotHostedError(
      "The ingredient panel was rendered but could not be hosted: R2 is not "
      + "configured in this environment (R2_PUBLIC_URL / credentials).",
    );
  }
  return remember({ url, source: "RENDERED" });
}
