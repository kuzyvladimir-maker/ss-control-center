// Fetches SKU data from existing Google Sheets "SKU Shipping Database v2"
// Sheet must be shared as "Anyone with the link can view"

function getSheetId(): string {
  const sheetId = process.env.GOOGLE_SHEETS_ID;
  if (!sheetId) {
    throw new Error("GOOGLE_SHEETS_ID is not configured");
  }
  return sheetId;
}

function getSheetsApiKey(): string {
  const apiKey = process.env.GOOGLE_SHEETS_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_SHEETS_API_KEY is not configured");
  }
  return apiKey;
}

export interface SkuRow {
  sku: string;           // Column A
  productTitle: string;  // Column B
  marketplace: string;   // Column C
  category: string;      // Column D (Frozen / Dry)
  length: number | null; // Column E
  width: number | null;  // Column F
  height: number | null; // Column G
  weight: number | null; // Column H — Weight (lbs) for UPS/USPS/FedEx standard
  weightFedex: number | null; // Column K — Weight FedEx One Rate (lbs)
  hasCompleteData: boolean;
}

// Parse a CSV line handling quoted fields
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseNumber(val: string): number | null {
  if (!val || val === "N/A" || val === "-" || val === "") return null;
  const n = parseFloat(val.replace(/,/g, ""));
  return isNaN(n) ? null : n;
}

export async function fetchSkuDatabase(): Promise<SkuRow[]> {
  // Use Google Sheets CSV export (requires sheet to be publicly viewable)
  const sheetId = getSheetId();
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;

  const res = await fetch(url, {
    next: { revalidate: 300 }, // Cache for 5 minutes
  });

  if (!res.ok) {
    throw new Error(
      `Failed to fetch SKU Database: ${res.status} ${res.statusText}`
    );
  }

  const csv = await res.text();
  const lines = csv.split("\n").filter((l) => l.trim());

  if (lines.length < 2) return [];

  // Skip header row (line 0)
  const rows: SkuRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    // Columns: A=SKU, B=Title, C=Marketplace, D=Category, E=Length, F=Width, G=Height, H=Weight, I=SampleCount, J=Notes, K=WeightFedEx
    const sku = cols[0] || "";
    if (!sku) continue;

    const length = parseNumber(cols[4]);
    const width = parseNumber(cols[5]);
    const height = parseNumber(cols[6]);
    const weight = parseNumber(cols[7]);
    const weightFedex = parseNumber(cols[10]); // Column K (index 10)

    const hasCompleteData =
      weight !== null && length !== null && width !== null && height !== null;

    rows.push({
      sku,
      productTitle: cols[1] || "",
      marketplace: cols[2] || "",
      category: cols[3] || "",
      length,
      width,
      height,
      weight,
      weightFedex,
      hasCompleteData,
    });
  }

  return rows;
}

// Lookup a single SKU — returns the row or null
export async function lookupSku(sku: string): Promise<SkuRow | null> {
  const allRows = await fetchSkuDatabase();
  return allRows.find((r) => r.sku === sku) || null;
}

// Append a new SKU row to Google Sheets via the Forms/API workaround
// Since direct write requires OAuth, we use the Google Sheets API v4 append
// The sheet must be writable (not just viewable)
export async function appendSkuRow(data: {
  sku: string;
  productTitle: string;
  marketplace: string;
  category: string;
  length: number;
  width: number;
  height: number;
  weight: number;
  weightFedex: number;
}): Promise<boolean> {
  const sheetId = getSheetId();
  const apiKey = getSheetsApiKey();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A:K:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS&key=${apiKey}`;

  // Columns: A=SKU, B=Title, C=Marketplace, D=Category, E=Length, F=Width, G=Height, H=Weight, I=SampleCount, J=Notes, K=WeightFedex
  const row = [
    data.sku,
    data.productTitle,
    data.marketplace,
    data.category,
    data.length,
    data.width,
    data.height,
    data.weight,
    1, // Sample Count
    "Added from Control Center",
    data.weightFedex,
  ];

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values: [row] }),
  });

  if (!res.ok) {
    // Fallback: if API key approach doesn't work, store locally
    // and indicate that manual entry is needed
    const text = await res.text();
    throw new Error(
      `Could not write to Google Sheets (${res.status}). Please add SKU ${data.sku} manually. Details: ${text.substring(0, 200)}`
    );
  }

  return true;
}
