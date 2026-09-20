// Одноразовый отчёт владельцу: продуктивность 22 июльских Uncrustables-листингов
// (batch12 + trial), store1. Статус на Amazon (Listings API) + Sales & Traffic
// (сессии/просмотры/заказы/выручка) за последние 30 дней. Только чтение.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });

async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const li: any = await import("../src/lib/amazon-sp-api/listings");
  const rep: any = await import("../src/lib/amazon/growth/reports");

  // 22 июльских SKU: ChannelSKU на AMAZON_SALUTEM с Uncrustables в тайтле,
  // созданные в июле 2026.
  const skus = await prisma.channelSKU.findMany({
    where: {
      channel: "AMAZON_SALUTEM",
      title: { contains: "Uncrustables" },
      created_at: { gte: new Date("2026-07-01"), lt: new Date("2026-08-01") },
    },
    select: { sku: true, asin: true, title: true, price_cents: true, created_at: true },
    orderBy: { created_at: "asc" },
  });
  console.log(`SKUs created in July: ${skus.length}`);

  // Sales & Traffic, окно 30 дней (по вчера включительно).
  const end = new Date(); end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 29);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  console.log(`Sales&Traffic window: ${iso(start)}..${iso(end)}`);
  let traffic: any[] = [];
  try {
    traffic = await rep.runSalesTrafficWindow(1, `${iso(start)}T00:00:00Z`, `${iso(end)}T23:59:59Z`);
  } catch (e: any) {
    console.log(`traffic report failed: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  const byAsin: Record<string, any> = {};
  for (const r of traffic) byAsin[r.asin] = r;

  const SELLER = "A3A7A0RDFUSGBS";
  const rows: any[] = [];
  for (const s of skus) {
    let status = "?";
    try {
      const listing = await li.getListing(1, SELLER, s.sku, { includedData: ["summaries"] });
      const summary = (listing.summaries ?? [])[0];
      const st: string[] = summary?.status ?? [];
      status = st.length ? st.join("+") : "NO_STATUS";
    } catch (e: any) {
      status = /404/.test(String(e)) ? "NOT_FOUND" : `ERR ${String(e?.message ?? e).slice(0, 40)}`;
    }
    const t = s.asin ? byAsin[s.asin] : null;
    rows.push({
      sku: s.sku,
      asin: s.asin ?? "—",
      price: (s.price_cents / 100).toFixed(2),
      status,
      sessions: t?.sessions ?? 0,
      pageViews: t?.pageViews ?? 0,
      units: t?.units ?? 0,
      revenue: t?.revenue ?? 0,
      buyBoxPct: t?.featuredOfferPct ?? null,
      title: s.title.slice(0, 60),
    });
    await new Promise((r) => setTimeout(r, 600)); // listings API rate limit
  }

  console.log("\nSKU | ASIN | $ | status | sessions | pageViews | units | revenue$ | buyBox%");
  for (const r of rows) {
    console.log(
      `${r.sku} | ${r.asin} | ${r.price} | ${r.status} | ${r.sessions} | ${r.pageViews} | ${r.units} | ${r.revenue} | ${r.buyBoxPct ?? "—"}`,
    );
  }
  const active = rows.filter((r) => /BUYABLE/.test(r.status)).length;
  const discoverableOnly = rows.filter((r) => /DISCOVERABLE/.test(r.status) && !/BUYABLE/.test(r.status)).length;
  const dead = rows.length - active - discoverableOnly;
  const sumSessions = rows.reduce((a, r) => a + r.sessions, 0);
  const sumUnits = rows.reduce((a, r) => a + r.units, 0);
  const sumRevenue = rows.reduce((a, r) => a + r.revenue, 0);
  console.log(`\nTOTALS: listings ${rows.length} | BUYABLE ${active} | discoverable-only ${discoverableOnly} | other ${dead}`);
  console.log(`TRAFFIC 30d: sessions ${sumSessions} | units ${sumUnits} | revenue $${sumRevenue.toFixed(2)}`);
  console.log(`with>=1 session: ${rows.filter((r) => r.sessions > 0).length}; with>=1 order: ${rows.filter((r) => r.units > 0).length}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
