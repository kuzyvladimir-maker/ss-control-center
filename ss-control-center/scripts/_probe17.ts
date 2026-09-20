import { prisma } from "../src/lib/prisma";
async function main() {
  const d = await prisma.bundleDraft.findUniqueOrThrow({
    where: { id: "cmscfn6bw000604jp1e4deiny" },
    select: { status: true, master_bundle_id: true },
  });
  console.log("draft.status:", d.status);
  const skus = await prisma.channelSKU.findMany({
    where: { master_bundle_id: d.master_bundle_id! },
    select: { sku: true, validation_status: true, lifecycle_status: true, listing_status: true },
  });
  console.log(JSON.stringify(skus));
}
main().finally(() => void prisma.$disconnect());
