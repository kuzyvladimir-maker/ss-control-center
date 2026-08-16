import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const rows = await prisma.channelSKU.findMany({
    where: { submission_id: { not: null }, title: { contains: "Uncrustables" } },
    select: { lifecycle_status: true, sku: true },
    take: 400,
  });
  const b = new Map<string, number>(); const st = new Map<string, number>();
  for (const r of rows) {
    b.set("n/a", (b.get("n/a") ?? 0) + 1);
    st.set(r.lifecycle_status ?? "—", (st.get(r.lifecycle_status ?? "—") ?? 0) + 1);
  }
  console.log("опубликованных Uncrustables:", rows.length);
  console.log("бренд в карточке:", [...b].map(([k, n]) => `${k} × ${n}`).join(" | "));
  console.log("статусы:", [...st].map(([k, n]) => `${k} × ${n}`).join(" | "));
  await prisma.$disconnect(); process.exit(0);
}
main();
