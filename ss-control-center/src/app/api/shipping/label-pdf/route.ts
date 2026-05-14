import { NextRequest, NextResponse } from "next/server";

// Server-side proxy for Veeqo's shipping-label PDF endpoint.
//
// Veeqo's `/shipping/labels?shipment_ids[]=X&format=pdf` requires the
// `x-api-key` header — we can't link to it directly from the browser
// without exposing the key. Instead, the "Open PDF" link in the
// post-buy modal points here, and this route fetches the PDF on the
// server (with auth) and streams it back to the user.
//
// Usage: /api/shipping/label-pdf?shipmentId=1194231799
//
// This is the fallback persistence layer. When Google Drive upload is
// configured the modal links to the Drive file instead — proxy is only
// used when Drive failed (or isn't set up yet).

export async function GET(request: NextRequest) {
  const shipmentId = request.nextUrl.searchParams.get("shipmentId");
  if (!shipmentId || !/^\d+$/.test(shipmentId)) {
    return NextResponse.json(
      { error: "shipmentId query param required (numeric)" },
      { status: 400 }
    );
  }

  const base = process.env.VEEQO_BASE_URL || "https://api.veeqo.com";
  const apiKey = process.env.VEEQO_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "VEEQO_API_KEY not configured" },
      { status: 500 }
    );
  }

  const url = `${base}/shipping/labels?shipment_ids%5B%5D=${shipmentId}&format=pdf`;
  const veeqoRes = await fetch(url, {
    headers: {
      "x-api-key": apiKey,
      Accept: "application/pdf",
    },
  });

  if (!veeqoRes.ok) {
    const text = await veeqoRes.text();
    return NextResponse.json(
      {
        error: `Veeqo returned ${veeqoRes.status}`,
        body: text.slice(0, 500),
      },
      { status: veeqoRes.status }
    );
  }

  const buf = Buffer.from(await veeqoRes.arrayBuffer());
  // Defensive guard — the same endpoint without format=pdf returns a
  // tiny JSON counter; if we somehow got it back, surface that as a
  // server error rather than serving a fake PDF to the browser.
  if (buf.length < 1000 || buf.slice(0, 5).toString("ascii") !== "%PDF-") {
    return NextResponse.json(
      {
        error: "Veeqo did not return a PDF — got " + buf.length + " bytes",
        preview: buf.slice(0, 200).toString("utf-8"),
      },
      { status: 502 }
    );
  }

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="veeqo-label-${shipmentId}.pdf"`,
      "Cache-Control": "private, max-age=300",
    },
  });
}
