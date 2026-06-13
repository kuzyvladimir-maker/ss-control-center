/**
 * diag-explain-order.ts — READ ONLY. Explain the v3.5 Frozen decision for one
 * order: dump today + Monday rate pools, mark which pass the two conditions,
 * show the cheapest+$3 pick for each day, and the Monday >15% rule outcome.
 *
 * Run: cd ss-control-center && npx tsx scripts/diag-explain-order.ts <ORDER#> [cap]
 */
import "dotenv/config";
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
import { veeqoFetch, getRatesForShipDate, veeqoDateToLocal } from "../src/lib/veeqo/client";

const ORDER_NUMBER = process.argv[2] || "112-5404197-4181866";
const CAP = Number(process.argv[3] || 3);
const TODAY = "2026-06-12";
const MONDAY = "2026-06-15";
const SPEED_TOL = 3;
const MON_MIN = 0.15;

async function findOrder() {
  for (let p = 1; p <= 12; p++) {
    const os = await veeqoFetch(`/orders?status=awaiting_fulfillment&page_size=100&page=${p}`);
    if (!os || !os.length) break;
    const h = os.find((o: any) => o.number === ORDER_NUMBER);
    if (h) return h;
  }
  return null;
}
const cd = (edd: string, ship: string) =>
  Math.round((new Date(edd + "T00:00:00").getTime() - new Date(ship + "T00:00:00").getTime()) / 86_400_000);

function analyze(rates: any[], deadline: string, ship: string, label: string) {
  console.log(`\n── ${label} (ship ${ship}, window ≤${CAP}d, deadline ${deadline}) ──`);
  const rows = rates
    .map((r) => {
      const edd = veeqoDateToLocal(r.delivery_promise_date);
      return { t: r.title, p: parseFloat(r.total_net_charge), edd, days: cd(edd, ship) };
    })
    .sort((a, b) => a.p - b.p);
  for (const r of rows) {
    const okDeadline = r.edd <= deadline;
    const okWindow = r.days <= CAP;
    const valid = okDeadline && okWindow && r.p > 0;
    console.log(
      `  ${valid ? "✓VALID" : "   ✗  "}  $${r.p.toFixed(2).padStart(7)}  EDD ${r.edd} (${r.days}d)  ${r.t}` +
        (valid ? "" : `   [${!okDeadline ? "past deadline " : ""}${!okWindow ? `>${CAP}d window` : ""}]`),
    );
  }
  const pool = rows.filter((r) => r.edd <= deadline && r.days <= CAP && r.p > 0);
  if (!pool.length) { console.log("  → no valid rate"); return null; }
  const cheap = Math.min(...pool.map((r) => r.p));
  const cand = pool.filter((r) => r.p - cheap <= SPEED_TOL).sort((a, b) => a.days - b.days || a.edd.localeCompare(b.edd) || a.p - b.p);
  console.log(`  → PICK: ${cand[0].t} $${cand[0].p.toFixed(2)} EDD ${cand[0].edd} (${cand[0].days}d)  [cheapest $${cheap.toFixed(2)} +$${SPEED_TOL} speed band]`);
  return cand[0];
}

async function main() {
  const order = await findOrder();
  if (!order) { console.error("not found"); process.exit(1); }
  const deadline = veeqoDateToLocal(order.due_date);
  console.log(`\nOrder ${ORDER_NUMBER} — deadline ${deadline}, cap ${CAP}d`);

  const todayR = (await getRatesForShipDate(order, `${TODAY}T16:00:00Z`)).available;
  const monR = (await getRatesForShipDate(order, `${MONDAY}T16:00:00Z`)).available;
  const bToday = analyze(todayR, deadline, TODAY, "TODAY 6/12");
  const bMon = analyze(monR, deadline, MONDAY, "MONDAY 6/15");

  console.log("\n── DECISION ──");
  if (bMon && !bToday) console.log("ship MONDAY (no valid today)");
  else if (bMon && bToday && bMon.days < bToday.days && bMon.p <= bToday.p + SPEED_TOL)
    console.log(`ship MONDAY — faster ${bMon.days}d vs ${bToday.days}d transit (Mon $${bMon.p.toFixed(2)} vs $${bToday.p.toFixed(2)})`);
  else if (bMon && bToday && bMon.days <= bToday.days && bMon.p < bToday.p * (1 - MON_MIN))
    console.log(`ship MONDAY — ${Math.round((1 - bMon.p / bToday.p) * 100)}% cheaper, same ${bMon.days}d transit ($${bToday.p.toFixed(2)}→$${bMon.p.toFixed(2)})`);
  else if (bToday) console.log(`ship TODAY — $${bToday.p.toFixed(2)} (Monday ${bMon ? `$${bMon.p.toFixed(2)}/${bMon.days}d` : "none"} not faster/not enough cheaper, or slower)`);
  else console.log("NO SERVICE");
  console.log();
}
main().catch((e) => { console.error(e); process.exit(1); });
