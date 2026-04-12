import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { spApiGet } from "@/lib/amazon-sp-api/client";
import {
  getConnectedGmailAccounts,
  searchMessages,
  readMessage,
  loadEmailToStoreMap,
} from "@/lib/gmail-api";
import { parseAtozEmail } from "@/lib/customer-hub/atoz-gmail-parser";
import { parseChargebackEmail } from "@/lib/customer-hub/chargeback-gmail-parser";

/**
 * Enrich an AtozzClaim with SP-API order data + Veeqo tracking.
 * Non-blocking — any failure leaves the claim with what it has.
 */
async function enrichClaim(claimId: string, amazonOrderId: string, storeIndex: number) {
  const storeId = `store${storeIndex || 1}`;
  const updates: Record<string, unknown> = {};

  // SP-API Orders
  try {
    const orderRes = await spApiGet(
      `/orders/v0/orders/${amazonOrderId}`,
      { storeId }
    );
    const order = orderRes.payload;
    if (order) {
      const shipDate = order.EarliestShipDate?.split("T")[0] || null;
      const latestShipDate = order.LatestShipDate?.split("T")[0] || null;
      if (shipDate) updates.shipDate = shipDate;
      if (shipDate && latestShipDate) {
        updates.shippedOnTime = shipDate <= latestShipDate;
      }
    }
  } catch {
    // non-blocking
  }

  // Veeqo tracking
  const VEEQO_API_KEY = process.env.VEEQO_API_KEY;
  const VEEQO_BASE_URL = process.env.VEEQO_BASE_URL || "https://api.veeqo.com";
  if (VEEQO_API_KEY) {
    try {
      const veeqoRes = await fetch(
        `${VEEQO_BASE_URL}/orders?query=${amazonOrderId}&page_size=5`,
        { headers: { "x-api-key": VEEQO_API_KEY } }
      );
      if (veeqoRes.ok) {
        const veeqoOrders = await veeqoRes.json();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const match = veeqoOrders?.find?.((o: any) => {
          const ids = [o.number, o.channel_order_id].filter(Boolean);
          return ids.some((id: string) => id === amazonOrderId || id.includes(amazonOrderId));
        });
        if (match) {
          const alloc = match.allocations?.[0];
          const shipment = alloc?.shipment;
          if (shipment) {
            const rawTracking = shipment.tracking_number;
            if (typeof rawTracking === "string") {
              updates.trackingNumber = rawTracking;
            } else if (rawTracking && typeof rawTracking === "object" && typeof rawTracking.tracking_number === "string") {
              updates.trackingNumber = rawTracking.tracking_number;
            }

            const carrierCandidates = [
              shipment.carrier_name,
              shipment.carrier?.name,
              alloc?.carrier?.name,
            ].filter((v: unknown): v is string =>
              typeof v === "string" && v.length > 0 && v.toLowerCase() !== "buy shipping"
            );
            if (carrierCandidates.length > 0) {
              updates.carrier = carrierCandidates[0];
            } else {
              const svc = (shipment.service_name || "").toLowerCase();
              if (svc.includes("ups")) updates.carrier = "UPS";
              else if (svc.includes("usps") || svc.includes("priority"))
                updates.carrier = "USPS";
              else if (svc.includes("fedex")) updates.carrier = "FedEx";
              else if (svc.includes("dhl")) updates.carrier = "DHL";
            }

            if (shipment.shipped_at) {
              updates.shipDate = shipment.shipped_at.split("T")[0];
            }

            if (shipment.delivery_date) {
              updates.deliveredDate = shipment.delivery_date.split("T")[0];
            }

            const firstScan = shipment.first_scan_at || shipment.shipped_at;
            if (firstScan) {
              updates.firstScanDate = firstScan.split("T")[0];
            }
          }

          // Buy Shipping detection — any Veeqo shipment = Buy Shipping per policy
          if (alloc?.shipment?.tracking_number || alloc?.shipment?.id) {
            updates.claimsProtectedBadge = true;
          }
        }
      }
    } catch {
      // non-blocking
    }
  }

  if (Object.keys(updates).length > 0) {
    updates.status = "EVIDENCE_GATHERED";
    await prisma.atozzClaim.update({ where: { id: claimId }, data: updates });
    console.log(`[atoz enrichment] ${claimId}: enriched with ${Object.keys(updates).length} fields`);
  }
}

// GET /api/customer-hub/atoz
// Lists claims from the AtozzClaim table. `type` query param selects which
// kind of claim to return (A_TO_Z by default); the /chargebacks route calls
// this same table with type=CHARGEBACK.
export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const type = sp.get("type") || "A_TO_Z";
    const status = sp.get("status");
    const limit = parseInt(sp.get("limit") || "50");

    const where: Record<string, unknown> = { claimType: type };
    if (status && status !== "all") where.status = status;

    const [claims, total] = await Promise.all([
      prisma.atozzClaim.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      prisma.atozzClaim.count({ where }),
    ]);

    return NextResponse.json({ claims, total });
  } catch (err) {
    console.error("[customer-hub/atoz] GET failed:", err);
    return NextResponse.json({ claims: [], total: 0 });
  }
}

// POST /api/customer-hub/atoz
// action: "create" — manually add a claim/chargeback (until SP-API sync
// is wired up). Tries to enrich with SP-API order data + Veeqo tracking.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));

    if (body.action === "sync") {
      const period = parseInt(body.period) || 30;
      const syncType: string = body.type || "A_TO_Z";
      const accounts = await getConnectedGmailAccounts();
      const emailToStoreMap = await loadEmailToStoreMap();
      let synced = 0;
      const errors: string[] = [];

      for (const account of accounts) {
        try {
          // A-to-Z query
          const queries: string[] = [];
          if (syncType === "A_TO_Z" || syncType === "ALL") {
            queries.push(
              `from:atoz-guarantee-no-reply@amazon.com to:${account.email} newer_than:${period}d`
            );
          }
          // Chargeback queries
          if (syncType === "CHARGEBACK" || syncType === "ALL") {
            queries.push(
              `from:cb-seller-notification@amazon.com to:${account.email} newer_than:${period}d`
            );
            queries.push(
              `from:cb-seller-query@amazon.com to:${account.email} newer_than:${period}d`
            );
          }

          for (const query of queries) {
            const messageList = await searchMessages(
              account.refreshToken,
              query,
              50
            );

            for (const msg of messageList) {
              const msgId = msg.id;
              if (!msgId) continue;

              // Dedup — skip if already in DB
              const existing = await prisma.atozzClaim.findFirst({
                where: { gmailMessageId: msgId },
              });
              if (existing) continue;

              try {
                const full = await readMessage(account.refreshToken, msgId);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const headers: any[] = full.payload?.headers || [];
                const snippet = full.snippet || "";
                // Decode body
                let bodyText = snippet;
                const parts = full.payload?.parts || [full.payload];
                for (const part of parts) {
                  if (part?.mimeType === "text/plain" && part?.body?.data) {
                    const decoded = Buffer.from(
                      part.body.data.replace(/-/g, "+").replace(/_/g, "/"),
                      "base64"
                    ).toString("utf-8");
                    bodyText = decoded;
                    break;
                  }
                }

                // Try A-to-Z parser
                const atoz = parseAtozEmail(
                  msgId,
                  headers,
                  bodyText,
                  emailToStoreMap
                );
                if (atoz && atoz.amazonOrderId) {
                  // Dedup by order + claim type
                  const dup = await prisma.atozzClaim.findFirst({
                    where: {
                      amazonOrderId: atoz.amazonOrderId,
                      claimType: "A_TO_Z",
                    },
                  });
                  if (!dup) {
                    const created = await prisma.atozzClaim.create({
                      data: {
                        amazonOrderId: atoz.amazonOrderId,
                        claimType: "A_TO_Z",
                        amount: atoz.amount,
                        deadline: atoz.deadline,
                        gmailMessageId: msgId,
                        status:
                          atoz.emailType === "decision"
                            ? "DECIDED"
                            : "NEW",
                        amazonDecision: atoz.amazonDecision,
                      },
                    });
                    // Enrich with SP-API + Veeqo (non-blocking)
                    try {
                      await enrichClaim(created.id, atoz.amazonOrderId, atoz.storeIndex);
                    } catch { /* non-blocking */ }
                    synced++;
                  } else if (atoz.emailType === "decision" && dup.status !== "DECIDED") {
                    await prisma.atozzClaim.update({
                      where: { id: dup.id },
                      data: {
                        status: "DECIDED",
                        amazonDecision: atoz.amazonDecision,
                        amountCharged:
                          atoz.amazonDecision === "AGAINST_US"
                            ? atoz.amount
                            : null,
                        amountSaved:
                          atoz.amazonDecision === "AMAZON_FUNDED"
                            ? atoz.amount
                            : null,
                      },
                    });
                    synced++;
                  }
                  continue;
                }

                // Try Chargeback parser
                const cb = parseChargebackEmail(
                  msgId,
                  headers,
                  bodyText,
                  emailToStoreMap
                );
                if (cb && cb.amazonOrderId) {
                  const dup = await prisma.atozzClaim.findFirst({
                    where: {
                      amazonOrderId: cb.amazonOrderId,
                      claimType: "CHARGEBACK",
                    },
                  });
                  if (!dup) {
                    const created = await prisma.atozzClaim.create({
                      data: {
                        amazonOrderId: cb.amazonOrderId,
                        claimType: "CHARGEBACK",
                        claimReason: cb.product
                          ? `Chargeback: ${cb.product.substring(0, 100)}`
                          : "Chargeback",
                        amount: cb.amount,
                        deadline: cb.deadline,
                        gmailMessageId: msgId,
                        status:
                          cb.emailType === "decision"
                            ? "DECIDED"
                            : "NEW",
                        amazonDecision: cb.amazonDecision,
                      },
                    });
                    try {
                      await enrichClaim(created.id, cb.amazonOrderId, cb.storeIndex);
                    } catch { /* non-blocking */ }
                    synced++;
                  } else if (cb.emailType === "decision" && dup.status !== "DECIDED") {
                    await prisma.atozzClaim.update({
                      where: { id: dup.id },
                      data: {
                        status: "DECIDED",
                        amazonDecision: cb.amazonDecision,
                        amountCharged:
                          cb.amazonDecision === "AGAINST_US"
                            ? cb.amount
                            : null,
                      },
                    });
                    synced++;
                  }
                }
              } catch (msgErr) {
                console.warn(
                  "[atoz sync] message parse failed:",
                  msgErr instanceof Error ? msgErr.message : String(msgErr)
                );
              }
            }
          }
        } catch (acctErr) {
          errors.push(
            `${account.email}: ${acctErr instanceof Error ? acctErr.message : String(acctErr)}`
          );
        }
      }

      return NextResponse.json({
        synced,
        accounts: accounts.length,
        errors: errors.length > 0 ? errors : undefined,
      });
    }

    if (body.action === "create") {
      const d = body.data || {};
      if (!d.amazonOrderId) {
        return NextResponse.json(
          { error: "Order ID is required" },
          { status: 400 }
        );
      }

      const storeId = `store${d.storeIndex || 1}`;
      // Enrich with SP-API order data (best-effort)
      const carrier: string | null = null;
      const trackingNumber: string | null = null;
      let shipDate: string | null = null;
      let shippedOnTime: boolean | null = null;

      try {
        const orderRes = await spApiGet(
          `/orders/v0/orders/${d.amazonOrderId}`,
          { storeId }
        );
        const order = orderRes.payload;
        if (order) {
          shipDate = order.EarliestShipDate?.split("T")[0] || null;
          const latestShipDate = order.LatestShipDate?.split("T")[0] || null;
          if (shipDate && latestShipDate) {
            shippedOnTime = shipDate <= latestShipDate;
          }
        }
      } catch {
        // Non-blocking — enrichment is best-effort
      }

      const claim = await prisma.atozzClaim.create({
        data: {
          amazonOrderId: d.amazonOrderId,
          claimType: d.claimType || "A_TO_Z",
          claimReason: d.claimReason || null,
          amount: typeof d.amount === "number" ? d.amount : null,
          deadline: d.deadline || null,
          carrier,
          trackingNumber,
          shipDate,
          shippedOnTime,
          vladimirNotes: d.vladimirNotes || null,
          status: "NEW",
        },
      });

      return NextResponse.json({ claim });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    console.error("[customer-hub/atoz] POST failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 }
    );
  }
}
