// Browser-side helpers that talk to the DYMO Connect Web Service running
// locally on the operator's Mac. Same mechanism Veeqo uses — DYMO ships a
// daemon as part of DYMO Connect that listens on https://127.0.0.1:41952
// and accepts PrintLabel requests over CORS.
//
// IMPORTANT: every function in this file must only be called from a
// React effect or event handler — never from server components or API
// routes. The DYMO endpoints are bound to localhost on the OPERATOR'S
// machine and are unreachable from Vercel.
//
// Two DYMO ports exist in the wild:
//   41951 — legacy "DYMO Label" Web Service (DLS v8). Listens over HTTPS,
//           with a self-signed cert the user must trust manually
//           (https://127.0.0.1:41951/DYMO/DLS/Printing/StatusConnected
//           returns `true` once trusted).
//   41952 — modern "DYMO Connect" Web Service (DCS). On some installs this
//           ends up as HTTP-only and fails our HTTPS probe with
//           ERR_SSL_PROTOCOL_ERROR — that's why 41951 is tried first.
// We try 41951 first (HTTPS, broadest compatibility) and fall back to 41952.

const DYMO_PORTS = [41951, 41952] as const;
const PRINTER_NAME_HINT = "5XL"; // we PREFER the LabelWriter 5XL specifically

export interface DymoStatus {
  reachable: boolean;
  port: number | null;
  printerName: string | null;
  // Free-form error/diagnostic when not reachable — surfaced in the UI badge.
  error: string | null;
}

/**
 * Pings DYMO Connect on both well-known ports and returns the first one
 * that answers, plus the name of the 5XL printer if one is connected.
 * Never throws — connection failures (Mac off, DYMO Connect quit, certs
 * not trusted, etc.) come back as `reachable: false`.
 */
export async function checkDymoStatus(): Promise<DymoStatus> {
  let lastError: string | null = null;
  for (const port of DYMO_PORTS) {
    const url = `https://127.0.0.1:${port}/DYMO/DLS/Printing`;
    try {
      const statusRes = await fetch(`${url}/StatusConnected`, {
        method: "GET",
        // 1.5s ceiling — Mac asleep should fail fast.
        signal: AbortSignal.timeout(1500),
      });
      if (!statusRes.ok) {
        lastError = `StatusConnected on ${port} returned ${statusRes.status}`;
        continue;
      }
      const text = (await statusRes.text()).trim();
      // DLS v8 returns the literal `true`; DCS sometimes returns `"true"`
      // (JSON-quoted). Accept either, case-insensitively.
      const ok = /^"?true"?$/i.test(text);
      if (!ok) {
        lastError = `StatusConnected on ${port} returned ${text || "empty"}`;
        continue;
      }

      // Enumerate printers and pick the 5XL (or any DYMO if 5XL not present).
      const printersRes = await fetch(`${url}/GetPrinters`, {
        method: "GET",
        signal: AbortSignal.timeout(2000),
      });
      if (!printersRes.ok) {
        lastError = `GetPrinters on ${port} returned ${printersRes.status}`;
        continue;
      }
      const body = await printersRes.text();
      const printerName = pickPrinterFromResponse(body);
      return {
        reachable: true,
        port,
        printerName,
        error: printerName ? null : "No DYMO printer connected (5XL expected)",
      };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return {
    reachable: false,
    port: null,
    printerName: null,
    error: lastError ?? "DYMO Connect not reachable",
  };
}

// Parses the GetPrinters response and picks the best printer name.
// Handles both XML (DLS v8 on 41951) and JSON (DCS on 41952) shapes, and
// falls back to any DYMO printer if a 5XL-named one isn't found — the
// operator only has one printer in practice, and "DYMO 5XL" vs
// "DYMO LabelWriter 5XL" vs "DYMOLabelWriter5XL" all need to match.
function pickPrinterFromResponse(body: string): string | null {
  const names: string[] = [];

  // XML form: <Name>...</Name> or, on some installs, <n>...</n> (very rare).
  const xmlRe = /<Name>([^<]+)<\/Name>/g;
  let m: RegExpExecArray | null;
  while ((m = xmlRe.exec(body)) !== null) names.push(m[1].trim());

  // JSON form: parse and walk for any "Name" keys.
  if (names.length === 0) {
    try {
      const j = JSON.parse(body);
      const walk = (v: unknown) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") {
          const o = v as Record<string, unknown>;
          for (const k of Object.keys(o)) {
            if (k.toLowerCase() === "name" && typeof o[k] === "string") {
              names.push((o[k] as string).trim());
            } else walk(o[k]);
          }
        }
      };
      walk(j);
    } catch {
      /* not JSON */
    }
  }

  if (names.length === 0) return null;
  // 1) prefer an exact 5XL match.
  const fiveXl = names.find((n) => n.toUpperCase().includes(PRINTER_NAME_HINT));
  if (fiveXl) return fiveXl;
  // 2) otherwise any DYMO-branded printer.
  const anyDymo = names.find((n) => n.toUpperCase().includes("DYMO"));
  if (anyDymo) return anyDymo;
  // 3) last resort — first non-empty name.
  return names[0] ?? null;
}

/**
 * Render the first page of a PDF (given as a Blob) to a base64 PNG,
 * sized to the standard 4×6 shipping label.
 *
 * Uses pdf.js loaded from the CDN — keeps it out of the Next.js bundle
 * and avoids the worker-asset wrangling. Cached on window after first
 * load.
 */
// Minimal shape of the pdfjs surface we actually use. Keeps us off the
// pdfjs-dist type dep while still preventing accidental misuse.
interface PdfJsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (params: { data: ArrayBuffer }) => {
    promise: Promise<{
      getPage: (n: number) => Promise<{
        getViewport: (opts: { scale: number }) => {
          width: number;
          height: number;
        };
        render: (opts: {
          canvasContext: CanvasRenderingContext2D;
          viewport: { width: number; height: number };
          canvas: HTMLCanvasElement;
        }) => { promise: Promise<void> };
      }>;
    }>;
  };
}

async function pdfFirstPageToBase64Png(pdfBytes: ArrayBuffer): Promise<string> {
  // Lazy-load pdfjs once per page. We attach to window to dedupe across
  // multiple buy clicks in a session.
  const w = window as unknown as {
    __pdfjsLib?: PdfJsModule;
    __pdfjsReady?: Promise<PdfJsModule>;
  };
  if (!w.__pdfjsLib) {
    if (!w.__pdfjsReady) {
      w.__pdfjsReady = (async () => {
        // CDN copy keyed to a pinned version. pdf.js >= 4 ships ES modules
        // with a self-hosted worker; loading via dynamic import keeps the
        // worker as a sibling chunk. webpackIgnore stops Next.js from
        // trying to resolve the URL at build time.
        const url =
          "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/+esm";
        const mod = (await import(
          /* webpackIgnore: true */ /* @vite-ignore */ url
        )) as PdfJsModule;
        mod.GlobalWorkerOptions.workerSrc =
          "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs";
        w.__pdfjsLib = mod;
        return mod;
      })();
    }
    await w.__pdfjsReady;
  }
  const pdfjs = w.__pdfjsLib!;

  const doc = await pdfjs.getDocument({ data: pdfBytes }).promise;
  const page = await doc.getPage(1);

  // Target ~300 DPI on a 4×6 label. DYMO 5XL native resolution is 300 DPI.
  // Compute scale from the page's natural viewport so we hit ~1200×1800 px
  // regardless of the source PDF's stated size.
  const baseViewport = page.getViewport({ scale: 1 });
  const targetLongEdgePx = 1800;
  const longEdgePts = Math.max(baseViewport.width, baseViewport.height);
  const scale = targetLongEdgePx / longEdgePts;
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context");
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;

  // Strip the "data:image/png;base64," prefix — DYMO wants raw base64.
  const dataUrl = canvas.toDataURL("image/png");
  return dataUrl.replace(/^data:image\/png;base64,/, "");
}

/**
 * Wrap a base64 PNG into the DYMO-Connect label XML format. We use the
 * 1744907 / 30387 / 30256 family (4×6 shipping label) which is what the
 * 5XL paper-feeds.
 *
 * The XML schema is documented in the DYMO Label Framework reference;
 * the minimal shape below works on both DYMO Label and DYMO Connect
 * web services.
 */
function buildLabelXml(base64Png: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<DieCutLabel Version="8.0" Units="twips" MediaType="Default">
  <PaperOrientation>Portrait</PaperOrientation>
  <Id>w300_h456</Id>
  <PaperName>1744907 Shipping</PaperName>
  <DrawCommands>
    <RoundRectangle X="0" Y="0" Width="5760" Height="8640" Rx="180" Ry="180"/>
  </DrawCommands>
  <ObjectInfo>
    <ImageObject>
      <Name>Label</Name>
      <BorderColor Alpha="255" Red="0" Green="0" Blue="0"/>
      <BorderThickness>0</BorderThickness>
      <BorderEnabled>False</BorderEnabled>
      <Image>${base64Png}</Image>
      <ScaleMode>Uniform</ScaleMode>
      <HorizontalAlignment>Center</HorizontalAlignment>
      <VerticalAlignment>Middle</VerticalAlignment>
    </ImageObject>
    <Bounds X="0" Y="0" Width="5760" Height="8640"/>
  </ObjectInfo>
</DieCutLabel>`;
}

/**
 * Print a PDF (fetched as ArrayBuffer) on the DYMO LabelWriter 5XL via the
 * DYMO Connect Web Service. Returns true on success.
 *
 * Performs no UI fallback — caller decides what to do on failure (we
 * typically open the PDF in a new tab so the operator can Cmd+P).
 */
export async function printPdfViaDymo(
  pdfBytes: ArrayBuffer,
  status: DymoStatus,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!status.reachable || !status.port || !status.printerName) {
    return {
      ok: false,
      reason: status.error ?? "DYMO Connect not reachable",
    };
  }
  try {
    const base64Png = await pdfFirstPageToBase64Png(pdfBytes);
    const labelXml = buildLabelXml(base64Png);

    // DYMO's PrintLabel endpoint takes form-encoded fields.
    const body = new URLSearchParams({
      printerName: status.printerName,
      labelXml,
      labelSetXml: "",
    });
    const res = await fetch(
      `https://127.0.0.1:${status.port}/DYMO/DLS/Printing/PrintLabel`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      return {
        ok: false,
        reason: `DYMO PrintLabel returned ${res.status}`,
      };
    }
    const text = (await res.text()).trim().toLowerCase();
    // DYMO returns "true" on success, "false" on rejection (printer
    // offline, paper out, etc.).
    if (text !== "true" && text !== '"true"') {
      return {
        ok: false,
        reason: `DYMO rejected the job (response: ${text || "empty"})`,
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Convenience: fetch a PDF from a URL (e.g. a Drive webContentLink that's
 * publicly readable, or our own label-pdf endpoint) and send it to DYMO.
 */
export async function printPdfUrlViaDymo(
  pdfUrl: string,
  status: DymoStatus,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const res = await fetch(pdfUrl, {
      // Drive's webContentLink lives on drive.google.com — same-origin
      // restrictions don't apply since it returns the file with permissive
      // CORS for direct download.
      credentials: "omit",
    });
    if (!res.ok) {
      return {
        ok: false,
        reason: `Could not fetch PDF (${res.status})`,
      };
    }
    const bytes = await res.arrayBuffer();
    return printPdfViaDymo(bytes, status);
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}
