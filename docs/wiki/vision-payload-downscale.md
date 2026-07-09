# Vision payload downscale (1536px JPEG) — why we stopped shipping full-res tiles

**Date:** 2026-07-09 · **Code:** `src/lib/sourcing/vision.ts` → `downscaleForVision()` in `fetchB64()`

## The incident

The box worker (`mcp.salutem.solutions`) began returning **nginx HTTP 500 in 0.03s** on every
vision call. Root cause: **`/dev/sda2` was 100% full** (158G, 0 free). nginx buffers request
bodies larger than `client_body_buffer_size` (~16KB) to a temp file; with a full disk that
write fails → instant 500. Every real image is ≫16KB, so **all vision died** — both the
BF-Images tile QC and the COGS identify sweep.

Measured threshold from the client: 11KB body → 200, 44KB body → 500.

## Why the disk filled

`/root/.codex/sessions` = **16 GB / 7236 `.jsonl` files**, growing **+4.31 GB/day**.

These are not logs. The codex CLI persists a full transcript per invocation, and the
transcript **embeds the base64 of every image we sent**. One sampled rollout: 8.8 MB total,
18 lines, of which **8.7 MB was two base64 images**.

Crucially, **the images themselves were never misrouted** — our generated tiles live in R2 as
intended. Image *files* on the box totalled only 1.44 GB, all system/library assets. The box
was storing incidental copies of what we uploaded for analysis.

Age profile showed the growth was ours and recent: >7 days old = 0.3 GB, >1 day = 5.0 GB,
total 16 GB. So a 7-day retention policy alone would have freed almost nothing — the payload
size had to shrink first.

## The fix

`fetchB64()` used to base64 the image **at full resolution**, and `highResImageUrl()` even
strips size params off Walmart URLs to request the *largest* variant. Our Walmart main images
are 2200×2200 PNG ≈ **1.85 MB of base64 per call**.

Now every image is downscaled before it leaves the process:

```
resize(1536, 1536, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 })
```

Tunable via `SS_VISION_MAX_PX` / `SS_VISION_JPEG_Q`. On sharp failure it falls back to the raw
buffer, so a QC call never dies over an encode hiccup.

## Why 1536px and not 1024px

The wrong-variant gate depends on **reading the package label** (it is what caught Snyder's
"Dipping Sticks" being substituted for "Seasoned Twisted"). On a 12-unit tile:

| size | per-cell | label legible? | b64 per call | disk/day |
|------|----------|----------------|--------------|----------|
| 2200px PNG (old) | 550px | yes | 1.85 MB | 4310 MB |
| **1536px JPEG q85** | **384px** | **yes (verified)** | **287 KB** | **~650 MB** |
| 1280px JPEG q82 | 320px | yes | 199 KB | ~452 MB |
| 1024px JPEG q80 | 256px | **too tight** | 133 KB | ~303 MB |

Verified by eye on a 12-cell tile at 1536px: brand, product line, and variant text all remain
readable. 1024px was rejected — the saving is not worth risking the variant gate.

## Lane compatibility

All three vision lanes accept JPEG:
- **gemini** sniffs the mime from the base64 magic bytes (`/9j/` → `image/jpeg`).
- **codex** / **claude** workers detect format from file content.

## Follow-ups

- Retention on `/root/.codex/sessions` (2–3 days) — *after* the downscale, since the bulk of
  the 16 GB was under 24 hours old.
- A disk upgrade was considered and **rejected**: at 4.3 GB/day it only delays the wall, and
  costs monthly. With the downscale + retention, growth is bounded.
