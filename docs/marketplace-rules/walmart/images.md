# Walmart Marketplace — Images

> **Source:** https://sellercentral.walmart.com/help
> **Last verified:** 2026-05-17
> **Priority:** P0

---

## TL;DR

Walmart image requirements **строже Amazon** в некоторых aspects: white background must be RGB 240+ on each channel (not just pure white), product fills 75-90% (Walmart prefers slightly smaller padding chем Amazon). Image hosting на CDN — same requirement.

---

## Hard rules

### 1. Main image

- **Background:** White (RGB 240+/240+/240+) — slightly less strict чем Amazon's pure 255
- **Resolution:** ≥1500×1500 pixels (HIGHER than Amazon's 1000×1000 minimum)
- **Aspect ratio:** Square (1:1)
- **Format:** JPEG only (PNG accepted but JPEG preferred)
- **File size:** ≤10MB
- **Coverage:** Product fills 75-90% of frame
- **No text overlays**, **no watermarks**, **no models**

### 2. Up to 8 secondary images

Aналогично Amazon (Amazon allows 9). Same general rules.

### 3. CDN hosting

Walmart Item API requires HTTPS-accessible image URLs:
- Cloudflare R2 ✓
- AWS S3 ✓
- Google Drive ❌
- Imgur (sometimes blocked)

Vladimir's setup: `https://images.salutemsolutions.info/...` через Cloudflare R2 — works for both Amazon and Walmart.

### 4. Specific Walmart preferences

- **Grocery products:** main image должен показать full product packaging
- **No "lifestyle" main image** — same as Amazon
- **Nutrition Facts panel image (secondary)** — strongly recommended для grocery

---

## Bundle Factory consideration

Main image generated для Amazon (white background, branded gift box) — **works for Walmart** unchanged (just re-upload to same Cloudflare R2 URL).

Walmart-specific secondary images:
- Same donor images
- Add Nutrition Facts panel image (для grocery) — separate AI/template generation

---

## References

- https://sellercentral.walmart.com/help
- Internal: [`../amazon/image-requirements.md`](../amazon/image-requirements.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
