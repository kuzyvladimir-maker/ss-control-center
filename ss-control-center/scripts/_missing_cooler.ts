import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync } from "node:fs";

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { S3Client, ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
  });
  const bucket = process.env.R2_BUCKET_NAME!;

  const map = JSON.parse(readFileSync("data/uncrustables-image-map.json", "utf8")) as Array<{ draft_id: string; name: string; cooler: string | null }>;
  const missing = map.filter((m) => !m.cooler);
  for (const m of missing) {
    const d = await prisma.bundleDraft.findUnique({
      where: { id: m.draft_id },
      select: {
        draft_name: true, status: true, created_at: true,
        generated_content: { select: { channel: true, image_retry_count: true, compliance_status: true, image_generated_at: true } },
      },
    });
    const gc = d?.generated_content[0];
    console.log(`\n${d?.draft_name}`);
    console.log(`  draft_id=${m.draft_id} status=${d?.status} created=${d?.created_at.toISOString()}`);
    console.log(`  gc: channel=${gc?.channel} retries=${gc?.image_retry_count} compliance=${gc?.compliance_status} image_generated_at=${gc?.image_generated_at?.toISOString() ?? "never"}`);
    // list EVERYTHING under both the prod/ and bf-composite/ prefixes for this draft
    for (const prefix of [`prod/draft-${m.draft_id}-${(gc?.channel ?? "").toLowerCase()}/`, `bf-composite/draft-${m.draft_id}/`]) {
      const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
      const keys = (r.Contents ?? []).map((o) => `${o.Key} (${Math.round((o.Size ?? 0) / 1024)}kb)`);
      console.log(`  ${prefix} -> ${keys.length ? keys.join(", ") : "EMPTY"}`);
    }
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
