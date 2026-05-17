# Amazon Image Requirements

> **Source:** https://sellercentral.amazon.com/help/hub/reference/external/GLHXEX85MHKWPVWE
> **Last verified:** 2026-05-17
> **Applies to:** All Amazon listings
> **Priority:** P0 (main image нарушение = suppression)

---

## TL;DR

Main image: **white background (255,255,255 pure white)**, ≥1000×1000 pixels (recommended 2000×2000), product ≥85% of frame, no text/watermark overlays. До 9 images total per listing (включая main). Image URLs должны быть **CDN-accessible** (Cloudflare R2 / S3 / similar) — Google Drive / Dropbox блокируются.

---

## Hard rules (must)

### 1. Main image — strict requirements

- **Background:** Pure white (RGB 255,255,255) — НЕ off-white, НЕ gray, НЕ gradient
- **Product coverage:** Product (or bundle box) занимает ≥85% of frame
- **Resolution:** Minimum 1000×1000 pixels. **Recommended:** 2000×2000+ для Amazon zoom feature
- **Format:** JPEG (preferred) или PNG. No GIF (animations rejected for main).
- **File size:** ≤10MB
- **Color space:** sRGB (CMYK rejected)
- **Aspect ratio:** Square (1:1). Other ratios accepted но get padding.

### 2. Запрещено в main image

- ❌ **Text overlays:** "BEST PRICE", "Save 30%", "FREE SHIPPING" — даже как graphic decoration
- ❌ **Watermarks:** logos, copyright stamps, photo credits
- ❌ **Multiple products:** main image shows ONE product (или bundle as единое целое)
- ❌ **Borders / frames** вокруг продукта
- ❌ **Models / hands holding product** (только в secondary images)
- ❌ **Props / accessories не входящие в bundle**
- ❌ **Lifestyle background** (только в secondary images)

### 3. Что разрешено как часть продукта

Текст на упаковке продукта — **это часть продукта**, не overlay. Vladimir's коробка с надписью "GIFT SET 12 COUNT" + Salutem Solutions logo + "100% FRESHNESS GUARANTEED" badge — это всё **printed на коробке** → разрешено в main image.

Это критическое различие. Текст внутри упаковки (физически напечатанный) — OK. Текст добавленный в Photoshop поверх — нет.

### 4. Secondary images (positions 2-9)

Less strict. Разрешены:
- Lifestyle shots (продукт в use case)
- Multiple angles
- Close-ups деталей
- Comparison shots
- Infographics (nutrition facts, instructions)
- Text overlays (но не promotional)

Vladimir's strategy: 1 AI-generated main + 3-5 donor secondary images (Walmart/brand site).

### 5. Image URLs must be CDN-accessible

Amazon's image scraper fetches images at submission time. Must be:
- ✅ Public CDN URLs (Cloudflare R2, AWS S3, custom CDN)
- ✅ HTTPS (not HTTP)
- ✅ Direct image link (ends in `.jpg`, `.png`)
- ❌ Google Drive share links (returns HTML, not image)
- ❌ Dropbox preview links
- ❌ Imgur (rate-limited, sometimes blocked)
- ❌ Pinterest / Instagram URLs

**Vladimir's setup:** Cloudflare R2 bucket → `https://images.salutemsolutions.info/main/{id}.png`

---

## Soft rules (should)

### 1. Resolution maximization для Amazon Zoom

Amazon Zoom активируется когда image ≥1000×1000. Для best UX — upload 2000×2000 или 3000×3000 (file size still OK). Customer hover zoom = bigger trust signal.

### 2. Lighting / shadow

- Soft shadows под продуктом ОК (suggests depth, professional photography)
- Hard shadows / harsh lighting — выглядит amateur
- AI-generated images Vladimir: добавляем "soft shadow" в prompt

### 3. Color accuracy

Если продукт зелёный — он зелёный, не желтоватый или blue-tinted. AI generation иногда смещает colors → проверка перед submission.

### 4. Gift set specific best practices

Для Vladimir's gift sets — main image должен показать:
- Коробку (Salutem Solutions packaging) — фронтальный вид с "GIFT SET N COUNT" текстом видимым
- Продукты внутри (visible через open top или partially visible)
- Cooler + gel packs в bottom-left corner (для frozen)
- White background, professional studio photo style

---

## AI Image Generation Pattern (Vladimir's main image)

Prompt template для GPT-Image / DALL-E 3:

```
A professional product photo of a brown cardboard gift set box on pure white background (RGB 255,255,255).

The box has bold green text "GIFT SET {N} COUNT" prominently on the front panel.

Below the text is the Salutem Solutions logo: green leaves icon with the tagline "OUR BEST SOLUTIONS FOR YOU".

Inside the box, neatly stacked vertically and clearly visible: {pack_count} units of {product_description} in their original retail packaging.

In the bottom-left corner of the image: a small white styrofoam cooler with two blue gel ice packs visible.

A green circular badge "100% FRESHNESS GUARANTEED" overlaid in the bottom-right corner — printed as if physically on the box, not photoshopped.

Style: Photorealistic, soft studio lighting, slight soft shadow under the box for depth, e-commerce product photography aesthetic.

Resolution: 2048x2048 pixels.
Format: PNG with transparent or pure white background.
```

Key prompt insights:
- "pure white background (RGB 255,255,255)" — explicit для compliance
- "printed as if physically on the box" — позволяет text без violating overlay rule
- "Photorealistic, e-commerce product photography" — style cue

---

## Examples

### ✅ Correct — Vladimir's existing listing main image

[B0FH2NX7J9 — Salutem Vita Pizza Lunchables Gift Set Pack of 12]

- White background ✓
- Brown gift set box ≥85% of frame ✓
- "GIFT SET 12 COUNT" text **printed on box** (not overlay) ✓
- Salutem Solutions logo on box ✓
- 12 Lunchables units visible inside ✓
- "100% FRESHNESS GUARANTEED" badge — printed on box ✓
- No promotional text overlays ✓

### ❌ Incorrect — гипотетические нарушения

**Нарушение #1:** Main image с "★ BEST GIFT ★" текстом, добавленным в Photoshop поверх фотографии. → Promotional text overlay = suppression.

**Нарушение #2:** Main image с Salutem Solutions watermark (полупрозрачный logo) в углу фотографии. → Watermark на main image (overlay, not part of physical product) = suppression.

**Нарушение #3:** Main image с моделью держащей box. → Human hands в main image = guidance violation. (OK для secondary).

**Нарушение #4:** Main image на бежевом или светло-сером фоне (не pure white). → Background не RGB 255,255,255 = suppression.

**Нарушение #5:** Image URL = Google Drive share link. → Amazon scraper не может fetch → ASIN остается без image → suppression after 24h.

---

## Donor secondary images workflow

Vladimir's pipeline для secondary images (positions 2-6):

1. **Source:** Walmart.com / target.com / brand-site (например smuckers.com)
2. **Download:** Raw image от scraper (1000-2000 pixel size usually)
3. **Light edit:**
   - Crop to 1:1 if needed
   - Remove watermark (Walmart logo, brand stamps) — using OpenAI Image Edit API or similar
   - Harmonize white background (если donor image has different shade)
   - Resize to 2000×2000
4. **Upload:** to Cloudflare R2 → public URL
5. **Reference:** в ChannelSKU.attributes.secondary_images

Cost: ~$0.02-0.05 per secondary image (OpenAI Image Edit API).

**Copyright caveat:** Использование donor images — серая зона. Legal принципом: bundle = product Vladimir's company, Vladimir может show содержимое (which включает оригинальные продукты). Не использовать donor images как main (main = свой gift set photo).

---

## Compliance checks для Stage 6

```typescript
async function validateImages(images: string[]): Promise<ComplianceResult> {
  const issues: string[] = [];

  if (images.length === 0) {
    issues.push('No main image set');
    return { passed: false, issues };
  }

  if (images.length > 9) issues.push(`Too many images: ${images.length} > 9`);

  for (let i = 0; i < images.length; i++) {
    const url = images[i];
    const isMain = i === 0;

    // URL accessible?
    if (!url.startsWith('https://')) issues.push(`Image ${i+1}: not HTTPS`);
    if (url.includes('drive.google.com')) issues.push(`Image ${i+1}: Google Drive URL (Amazon will reject)`);
    if (url.includes('dropbox.com')) issues.push(`Image ${i+1}: Dropbox URL (Amazon will reject)`);

    // Fetch and validate (Stage 6 expensive check)
    if (isMain) {
      const meta = await fetchImageMeta(url);
      if (meta.width < 1000 || meta.height < 1000)
        issues.push(`Main image: too small (${meta.width}x${meta.height} < 1000x1000)`);
      if (meta.format !== 'JPEG' && meta.format !== 'PNG')
        issues.push(`Main image: format ${meta.format} not supported`);
      if (meta.fileSize > 10_000_000) issues.push(`Main image: > 10MB`);
      // Background whiteness check (AI-based or pixel-sampling)
      const whitenessScore = await checkBackgroundWhiteness(url);
      if (whitenessScore < 0.95) issues.push(`Main image: background не pure white (${whitenessScore})`);
    }
  }

  return { passed: issues.length === 0, issues };
}
```

---

## References

- **Official image guidelines:** https://sellercentral.amazon.com/help/hub/reference/external/GLHXEX85MHKWPVWE
- **Product image style guide:** https://sellercentral.amazon.com/help/hub/reference/external/G1881
- **Internal:** [`title-policy.md`](title-policy.md), [`gift-set-policy.md`](gift-set-policy.md)
- **External:** https://www.bigcommerce.com/blog/amazon-product-photography/ (best practices, not official)

---

**Maintained by:** Vladimir + Claude
**Last reviewed:** 2026-05-17
