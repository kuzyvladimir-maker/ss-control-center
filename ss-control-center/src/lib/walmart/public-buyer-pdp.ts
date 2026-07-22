/**
 * Strict projection of Walmart.com's server-rendered __NEXT_DATA__ into the
 * small buyer-PDP contract consumed by buyer-facing-snapshot.ts.
 *
 * This parser performs no network or filesystem I/O. It never chooses a
 * related/variant product: the primary product, canonical URL and both public
 * item-id fields must all equal the exact requested numeric item ID.
 */

const MAX_PUBLIC_PDP_HTML_BYTES = 5 * 1024 * 1024;
const MAX_PUBLIC_PDP_IMAGES = 50;
const MAX_PUBLIC_PDP_SPECIFICATIONS = 500;

type JsonRecord = Record<string, unknown>;

export interface WalmartPublicBuyerPdpPayload {
  product: {
    item_id: string;
    product_url: string;
    title: string;
    main_image: string;
    images: string[];
    description: string;
    feature_bullets: string[];
    specifications: Array<{ name: string; value: string }>;
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requiredRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requiredString(value: unknown, label: string, maxLength = 100_000): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const text = value.trim();
  if (!text || text.length > maxLength || /[\u0000]/u.test(text)) {
    throw new Error(`${label} is empty or invalid`);
  }
  return text;
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;|&#38;/giu, "&")
    .replace(/&quot;|&#34;/giu, '"')
    .replace(/&apos;|&#39;|&rsquo;/giu, "'")
    .replace(/&lt;|&#60;/giu, "<")
    .replace(/&gt;|&#62;/giu, ">")
    .replace(/\s+/gu, " ")
    .trim();
}

function listItemTexts(value: unknown): string[] {
  if (value === null || value === undefined || value === "") return [];
  const html = requiredString(value, "Walmart PDP longDescription");
  const bullets = [...html.matchAll(/<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/giu)]
    .map((match) => decodeHtmlText(match[1] ?? ""))
    .filter(Boolean);
  if (new Set(bullets).size !== bullets.length) {
    throw new Error("Walmart PDP longDescription contains duplicate bullets");
  }
  return bullets;
}

function exactWalmartImageUrl(value: unknown, label: string): string {
  const raw = requiredString(value, label, 4_096);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${label} is not a URL`); }
  if (url.protocol !== "https:"
    || (url.hostname !== "walmartimages.com" && !url.hostname.endsWith(".walmartimages.com"))) {
    throw new Error(`${label} must be a Walmart HTTPS image`);
  }
  url.hash = "";
  return url.toString();
}

function exactProductUrl(value: unknown, itemId: string): string {
  const raw = requiredString(value, "Walmart PDP canonicalUrl", 4_096);
  const url = new URL(raw, "https://www.walmart.com");
  if ((url.hostname !== "walmart.com" && !url.hostname.endsWith(".walmart.com"))
    || !url.pathname.match(new RegExp(`/ip/(?:[^/]+/)?${itemId}/?$`, "iu"))) {
    throw new Error("Walmart PDP canonicalUrl does not bind the requested item ID");
  }
  url.hash = "";
  return url.toString();
}

function parseSpecifications(value: unknown): Array<{ name: string; value: string }> {
  if (!Array.isArray(value) || value.length > MAX_PUBLIC_PDP_SPECIFICATIONS) {
    throw new Error("Walmart PDP specifications must be a bounded array");
  }
  return value.map((entry, index) => {
    const row = requiredRecord(entry, `Walmart PDP specifications[${index}]`);
    const keys = Object.keys(row).sort();
    if (keys.length !== 2 || keys[0] !== "name" || keys[1] !== "value") {
      throw new Error(`Walmart PDP specifications[${index}] has unsupported keys`);
    }
    return {
      name: requiredString(row.name, `Walmart PDP specifications[${index}].name`, 500),
      value: requiredString(row.value, `Walmart PDP specifications[${index}].value`, 10_000),
    };
  });
}

function extractNextData(html: string): JsonRecord {
  const matches = [...html.matchAll(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/giu)];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one Walmart __NEXT_DATA__ script, found ${matches.length}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(matches[0]![1]!); } catch {
    throw new Error("Walmart __NEXT_DATA__ is not valid JSON");
  }
  return requiredRecord(parsed, "Walmart __NEXT_DATA__");
}

/** Convert one exact public Walmart PDP HTML document into the canonical PDP payload. */
export function projectWalmartPublicBuyerPdpHtml(
  html: string,
  expectedItemId: string,
): WalmartPublicBuyerPdpPayload {
  if (typeof html !== "string" || Buffer.byteLength(html, "utf8") > MAX_PUBLIC_PDP_HTML_BYTES) {
    throw new Error("Walmart PDP HTML must be a bounded string");
  }
  if (!/^\d+$/u.test(expectedItemId)) {
    throw new Error("expected Walmart item ID must contain digits only");
  }
  const next = extractNextData(html);
  const props = requiredRecord(next.props, "Walmart __NEXT_DATA__.props");
  const pageProps = requiredRecord(props.pageProps, "Walmart __NEXT_DATA__.props.pageProps");
  const initialData = requiredRecord(pageProps.initialData, "Walmart PDP initialData");
  const data = requiredRecord(initialData.data, "Walmart PDP data");
  const product = requiredRecord(data.product, "Walmart PDP primary product");
  const idml = requiredRecord(data.idml, "Walmart PDP idml");

  const publicIds = [product.usItemId, product.primaryUsItemId].map((value, index) => (
    requiredString(value, `Walmart PDP public item ID ${index + 1}`, 100)
  ));
  if (publicIds.some((value) => value !== expectedItemId)) {
    throw new Error("Walmart PDP primary product does not match the requested item ID");
  }

  const imageInfo = requiredRecord(product.imageInfo, "Walmart PDP imageInfo");
  if (!Array.isArray(imageInfo.allImages)
    || imageInfo.allImages.length < 1
    || imageInfo.allImages.length > MAX_PUBLIC_PDP_IMAGES) {
    throw new Error("Walmart PDP allImages must be a non-empty bounded array");
  }
  const images = imageInfo.allImages.map((entry, index) => {
    const image = requiredRecord(entry, `Walmart PDP allImages[${index}]`);
    return exactWalmartImageUrl(image.url, `Walmart PDP allImages[${index}].url`);
  });
  if (new Set(images).size !== images.length) {
    throw new Error("Walmart PDP allImages contains duplicate URLs");
  }

  const description = requiredString(
    idml.shortDescription ?? product.shortDescription,
    "Walmart PDP shortDescription",
  );
  return {
    product: {
      item_id: expectedItemId,
      product_url: exactProductUrl(product.canonicalUrl, expectedItemId),
      title: requiredString(product.name, "Walmart PDP product name", 10_000),
      main_image: images[0]!,
      images,
      description,
      feature_bullets: listItemTexts(idml.longDescription),
      specifications: parseSpecifications(idml.specifications),
    },
  };
}
