// Seed the recurring-expense master list (Salutem Solutions, from Sellerboard) +
// the FP1 funds. Idempotent. Run: npx tsx --env-file=.env scripts/seed-finance-expenses.ts
import { prisma } from "@/lib/prisma";
import { monthlyAmount, EXPENSE_CATEGORIES } from "@/lib/finance/expenses";

type Row = { name: string; category: string; amount: number; frequency: "monthly" | "weekly" };
const EXPENSES: Row[] = [
  // Subscriptions (Подписки)
  { name: "BJ's", category: "Subscriptions", amount: 5, frequency: "monthly" },
  { name: "Costco", category: "Subscriptions", amount: 5, frequency: "monthly" },
  { name: "Instacart", category: "Subscriptions", amount: 5, frequency: "monthly" },
  { name: "Sam's Club", category: "Subscriptions", amount: 5, frequency: "monthly" },
  { name: "Walmart", category: "Subscriptions", amount: 5, frequency: "monthly" },
  // Software (Софт)
  { name: "channelmax", category: "Software", amount: 17.5, frequency: "monthly" },
  { name: "Google Workspace", category: "Software", amount: 125, frequency: "monthly" },
  { name: "Atlantic.net (серверы)", category: "Software", amount: 150, frequency: "monthly" },
  { name: "Manychat", category: "Software", amount: 8, frequency: "monthly" },
  { name: "keepa", category: "Software", amount: 13, frequency: "monthly" },
  { name: "sellerboard", category: "Software", amount: 10, frequency: "monthly" },
  { name: "GoDaddy Hosting", category: "Software", amount: 22.97, frequency: "monthly" },
  // Warehouse & Logistics (Склад, логистика, расходники)
  { name: "Аренда склада", category: "Warehouse & Logistics", amount: 1200, frequency: "monthly" },
  { name: "Интернет", category: "Warehouse & Logistics", amount: 40, frequency: "monthly" },
  { name: "Электричество", category: "Warehouse & Logistics", amount: 500, frequency: "monthly" },
  { name: "Обслуживание автомобиля Ford", category: "Warehouse & Logistics", amount: 142, frequency: "monthly" },
  { name: "FedEx Pick-up", category: "Warehouse & Logistics", amount: 12, frequency: "weekly" },
  { name: "UPS Pick-up", category: "Warehouse & Logistics", amount: 16, frequency: "weekly" },
  // Salaries (ЗП)
  { name: "Дмитрий и Лиза (Amazon команда)", category: "Salaries", amount: 136, frequency: "weekly" },
  { name: "Мохаммед (TikTok)", category: "Salaries", amount: 63, frequency: "weekly" },
  { name: "Елена (склад)", category: "Salaries", amount: 330, frequency: "weekly" },
  { name: "Гульнара (ассистент/снабженец)", category: "Salaries", amount: 413, frequency: "weekly" },
  { name: "Дмитрий (склад)", category: "Salaries", amount: 330, frequency: "weekly" },
];

(async () => {
  // FP1 funds per category.
  for (const cat of [...new Set(EXPENSES.map((e) => e.category))]) {
    const existing = await prisma.fund.findFirst({ where: { name: cat, group: "FP1" } });
    if (!existing) {
      const order = EXPENSE_CATEGORIES.indexOf(cat as (typeof EXPENSE_CATEGORIES)[number]);
      await prisma.fund.create({ data: { name: cat, group: "FP1", allocationType: "percent", value: 0, priority: 10 + (order < 0 ? 9 : order), active: true } });
      console.log("  + fund", cat);
    }
  }
  // Expenses.
  let created = 0;
  for (const r of EXPENSES) {
    const existing = await prisma.recurringExpense.findFirst({ where: { name: r.name, category: r.category } });
    if (existing) continue;
    await prisma.recurringExpense.create({ data: { ...r, source: "sellerboard" } });
    created++;
  }
  console.log(`seeded ${created} expenses`);

  const all = await prisma.recurringExpense.findMany();
  const byCat = new Map<string, number>();
  for (const e of all) byCat.set(e.category, (byCat.get(e.category) ?? 0) + monthlyAmount(e.amount, e.frequency));
  let total = 0;
  for (const [c, m] of byCat) { console.log(`  ${c.padEnd(24)} $${m.toFixed(2)}/mo`); total += m; }
  console.log(`  TOTAL OpEx (this entity): $${total.toFixed(2)}/mo`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
