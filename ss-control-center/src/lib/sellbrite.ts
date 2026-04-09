const ACCOUNT_TOKEN = process.env.SELLBRITE_ACCOUNT_TOKEN!;
const SECRET_KEY = process.env.SELLBRITE_SECRET_KEY!;
const BASE_URL =
  process.env.SELLBRITE_BASE_URL || "https://api.sellbrite.com/v1";

function getAuthHeader() {
  const credentials = Buffer.from(`${ACCOUNT_TOKEN}:${SECRET_KEY}`).toString(
    "base64"
  );
  return `Basic ${credentials}`;
}

async function sellbriteFetch(path: string, options?: RequestInit) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sellbrite API error ${res.status}: ${text}`);
  }
  return res.json();
}

export async function getInventory(params?: { sku?: string; page?: number }) {
  const query = new URLSearchParams();
  if (params?.sku) query.set("sku", params.sku);
  if (params?.page) query.set("page", String(params.page));
  return sellbriteFetch(`/inventory?${query}`);
}

export async function getProducts(params?: { page?: number }) {
  const query = new URLSearchParams();
  if (params?.page) query.set("page", String(params.page));
  return sellbriteFetch(`/products?${query}`);
}
