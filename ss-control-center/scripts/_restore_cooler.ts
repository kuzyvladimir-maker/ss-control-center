// Restore the AI cooler-hero as the MAIN image on the Uncrustables listings I
// wrongly replaced with box composites. Nothing was deleted — the originals sit
// in R2 under a deterministic key: prod/draft-<draftId>-<channel>/main[-retryN].png
//
// Order of operations (assets first, never lose anything):
//   1. Record composite URL + resolved cooler URL for every draft -> data/*.json
//   2. Point GeneratedContent + ChannelSKU at the cooler URL
//   3. runDistribution(republish) -> Amazon PUT
//   4. Verify live: the AI heroes are 2048x2048, the composites are 2200x2200
//
//   BF_PILOT=3 npx tsx scripts/_restore_cooler.ts   # pilot, verify, stop
//   npx tsx scripts/_restore_cooler.ts              # full run
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
import { writeFileSync, mkdirSync } from "node:fs";

const JOBS = ["cmra8yv2k000010fzbuhf8wl9", "cmrbdh4dm0000zhfzhtijm97m"];

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { S3Client, ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const { runDistribution } = await import("@/lib/bundle-factory/distribution/distribution-pipeline");

  const base = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
  const bucket = process.env.R2_BUCKET_NAME!;
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
  });

  const PILOT = process.env.BF_PILOT ? parseInt(process.env.BF_PILOT, 10) : Infinity;
  const say = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

  const drafts = await prisma.bundleDraft.findMany({
    where: { generation_job_id: { in: JOBS } },
    select: {
      id: true, draft_name: true, master_bundle_id: true,
      generated_content: { select: { id: true, channel: true, main_image_url: true } },
    },
    orderBy: { created_at: "asc" },
  });

  // ── 1. Resolve the cooler key for every draft, record the mapping ──────────
  const map: Array<{ draft_id: string; name: string; composite: string | null; cooler: string | null }> = [];
  for (const d of drafts) {
    const gc = d.generated_content[0];
    if (!gc) continue;
    const prefix = `prod/draft-${d.id}-${gc.channel.toLowerCase()}/`;
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    // pick the highest attempt: main.png < main-retry2.png < main-retry3.png
    const keys = (r.Contents ?? []).map((o) => o.Key!).filter((k) => /\/main(-retry\d+)?\.png$/.test(k));
    keys.sort((a, b) => {
      const n = (k: string) => Number(k.match(/-retry(\d+)\.png$/)?.[1] ?? 1);
      return n(a) - n(b);
    });
    const cooler = keys.length ? `${base}/${keys[keys.length - 1]}` : null;
    const composite = (gc.main_image_url ?? "").includes("bf-composite") ? gc.main_image_url : null;
    map.push({ draft_id: d.id, name: d.draft_name, composite, cooler });
  }

  mkdirSync("data", { recursive: true });
  writeFileSync("data/uncrustables-image-map.json", JSON.stringify(map, null, 2));
  const missing = map.filter((m) => !m.cooler);
  say(`mapping saved: ${map.length} drafts | cooler found ${map.length - missing.length} | MISSING ${missing.length}`);
  if (missing.length) missing.forEach((m) => say("   NO COOLER:", m.name.slice(0, 50)));
  say(`composite URLs recorded: ${map.filter((m) => m.composite).length} (for the 3rd-image step)`);

  // ── 2-3. Point everything at the cooler + republish ────────────────────────
  let done = 0, failed = 0;
  for (const d of drafts) {
    if (done >= PILOT) { say(`PILOT limit ${PILOT} reached — stopping for review`); break; }
    const entry = map.find((m) => m.draft_id === d.id);
    if (!entry?.cooler) continue;
    const gc = d.generated_content[0];
    if (!gc) continue;
    try {
      await prisma.generatedContent.update({ where: { id: gc.id }, data: { main_image_url: entry.cooler } });
      if (d.master_bundle_id) {
        await prisma.channelSKU.updateMany({ where: { master_bundle_id: d.master_bundle_id }, data: { main_image_url: entry.cooler } });
      }
      const dist = await runDistribution({ bundle_draft_id: d.id, apply: true, republish: true, actor: "restore-cooler" });
      const s = dist.per_sku.find((x: { marketplace_kind: string }) => x.marketplace_kind === "amazon") ?? dist.per_sku[0];
      if (s && (s.status === "SUBMITTED" || s.status === "LIVE")) {
        done++; say(`RESTORED (${done}) ${s.sku} ${d.draft_name.slice(0, 38)} -> ${s.marketplace_status}`);
      } else {
        failed++; say(`FAIL ${d.draft_name.slice(0, 38)}`, JSON.stringify({ st: s?.status, err: s?.error?.slice(0, 100) }));
      }
    } catch (e) {
      failed++; say(`ERR ${d.draft_name.slice(0, 38)}`, (e as Error).message.slice(0, 120));
    }
    await new Promise((r) => setTimeout(r, 2500));
  }

  say(`\nrestore done: ${done} restored, ${failed} failed`);
  say("verify with: SKU=<sku> npx tsx scripts/_verify_any.ts   (2048 = cooler hero, 2200 = composite)");
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
