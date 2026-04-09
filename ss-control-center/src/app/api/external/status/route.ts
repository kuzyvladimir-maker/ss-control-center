import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchAllOrders, veeqoDateToLocal, getTodayNY } from "@/lib/veeqo";

export async function GET() {
  try {
    const today = getTodayNY();

    const [orders, openCases] = await Promise.all([
      fetchAllOrders().catch(() => []),
      prisma.csCase.count({ where: { status: "open" } }),
    ]);

    const todayOrders = orders.filter((o: { dispatch_date: string }) => {
      if (!o.dispatch_date) return false;
      return veeqoDateToLocal(o.dispatch_date) === today;
    });

    const labelsBought = todayOrders.filter(
      (o: { employee_notes: string }) =>
        o.employee_notes?.includes("Label Purchased")
    ).length;

    return NextResponse.json({
      date: today,
      ordersTotal: orders.length,
      ordersToday: todayOrders.length,
      labelsBought,
      labelsTotal: todayOrders.length,
      csCasesOpen: openCases,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal error" },
      { status: 500 }
    );
  }
}
