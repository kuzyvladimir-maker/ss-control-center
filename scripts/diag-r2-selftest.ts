// R2 connectivity self-test: upload a tiny PNG, fetch it back via public URL.
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

async function main() {
  const acct = process.env.R2_ACCOUNT_ID!;
  const bucket = process.env.R2_BUCKET_NAME!;
  const pub = (process.env.R2_PUBLIC_URL || "").replace(/\/$/, "");
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${acct}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  const key = "selftest/r2-connectivity-20260613.png";
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: png, ContentType: "image/png" }));
  console.log("UPLOAD OK ->", key);
  const url = `${pub}/${key}`;
  const res = await fetch(url);
  const bytes = (await res.arrayBuffer()).byteLength;
  console.log("FETCH", res.status, res.headers.get("content-type"), "bytes:", bytes);
  console.log("PUBLIC URL:", url);
  if (res.status === 200 && bytes > 0) console.log("\n✅ R2 WORKS end-to-end");
  else console.log("\n❌ fetch failed");
}
main().catch((e) => { console.error("ERROR:", e.name, e.message); process.exit(1); });
