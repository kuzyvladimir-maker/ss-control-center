# Cloudflare R2 Setup Guide

> **Purpose:** Хранилище для всех Bundle Factory картинок (main + secondary mirrored)
> **Time:** 5-10 минут setup один раз, дальше работает автоматически
> **Cost:** ~$1-3/month at scale (5000 bundles/month × 12 months ≈ 180GB = $2.70/mo)
> **Required for:** Phase 2.3 (Image Generation). НЕ нужен для Phase 2.1 (Brief + Research)
> **Audience:** Vladimir (не разработчик) — пошаговая инструкция со скриншот-указаниями

---

## TL;DR

Cloudflare R2 = S3-совместимое хранилище объектов с **бесплатным трафиком наружу** (egress). Идеальное решение для product images: Amazon скачивает картинку много раз → у нас $0 расходов на трафик.

После настройки получим:
- **Bucket name:** `salutem-bundle-factory` (или другой)
- **Public URL pattern:** `https://images.salutemsolutions.info/main/<sku>.jpg` (с custom domain) или `https://pub-xxxxx.r2.dev/main/<sku>.jpg` (default)
- **API credentials:** 3 значения для Bundle Factory (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`)

---

## ⏰ Когда делать

**Можно отложить.** Phase 2.1 (Brief + Research) работает без R2. R2 нужен только для Phase 2.3 когда мы начнём генерировать картинки.

Recommended timing:
1. **Сейчас (опционально):** Если Vladimir хочет всё подготовить заранее
2. **Между Phase 2.1 и Phase 2.3** (~2-3 недели от now): когда Claude Code закончит Brief + Research + Content Generation

---

## 🚀 Setup steps (за 5-10 минут)

### Step 1: Войти в Cloudflare account

1. Открой https://dash.cloudflare.com/
2. Если уже есть account (для `images.salutemsolutions.info`) → войди
3. Если нет — Sign up бесплатно (нужна только email + пароль)

### Step 2: Проверить — может быть R2 уже включён

В Cloudflare dashboard:
1. Слева в меню найди раздел **R2 Object Storage**
2. Если видишь список buckets — **R2 уже активирован**, можно использовать existing bucket или создать новый
3. Если видишь "Subscribe to R2" — нужно активировать (бесплатно для первых 10 GB/mo)

**Активация R2 (если не активирован):**
- Click "Subscribe to R2"
- Free tier: 10 GB storage, 1M Class A operations, 10M Class B operations — навсегда бесплатно
- Beyond: $0.015/GB storage, $4.50/1M writes, $0.36/1M reads
- Никакой credit card required для free tier (но Cloudflare попросит payment method для overage protection)

### Step 3: Создать bucket

1. R2 dashboard → нажми **Create bucket**
2. **Bucket name:** `salutem-bundle-factory` (или любое имя без пробелов, lowercase)
3. **Location:** Automatic (Cloudflare выберет ближайший data center)
4. Click **Create**

Готово — bucket создан.

### Step 4: Сгенерировать API token

Нужны 3 значения чтобы Bundle Factory мог загружать картинки в bucket.

1. R2 dashboard → справа **Manage R2 API Tokens** (или **Account Settings → R2 Tokens**)
2. Click **Create API Token**
3. **Token name:** `bundle-factory-uploader`
4. **Permissions:** **Object Read & Write** (это позволит загружать + читать картинки)
5. **TTL (validity):** *Forever* (или max период, обычно дольше — better)
6. **Specify bucket(s):** выбери `salutem-bundle-factory` (тот что только что создал)
7. Click **Create API Token**

После создания Cloudflare покажет **3 критически важных значения** — **СКОПИРУЙ ИХ СРАЗУ** (после закрытия страницы их больше не показывают):

```
Token value:                pBjK7nX...                       (~40 chars)
Access Key ID:              7c8d9e0f1a2b3c4d5e6f7g8h9i0j     (~32 chars)
Secret Access Key:          (длинная строка)                  (~64 chars)
```

**ВАЖНО:** Сохрани эти значения в безопасном месте (1Password, Notes, что угодно). Они нужны для подключения Bundle Factory к R2.

### Step 5: Найти Account ID

В правом нижнем углу R2 dashboard есть **Account ID** (~32 chars hex). Скопируй его тоже.

ИЛИ: top-right corner → нажми на аватар → **My Profile** → Account ID видно справа.

### Step 6 (опционально): Настроить custom domain

Без custom domain картинки будут грузиться с URL вида `https://pub-xxxxx.r2.dev/main/sku.jpg`. Это работает, но не "брендовый" URL.

Чтобы получить `https://images.salutemsolutions.info/main/sku.jpg`:

**Если у тебя уже есть `salutemsolutions.info` в Cloudflare DNS:**
1. R2 dashboard → bucket `salutem-bundle-factory` → tab **Settings**
2. Section **Public Access** → **Custom Domains** → **Connect Domain**
3. Type `images.salutemsolutions.info` (или другой subdomain на твой выбор)
4. Cloudflare auto-создаст DNS CNAME запись
5. SSL provisioning ~5-15 минут
6. После — URLs работают на твоём домене

**Если домен не в Cloudflare DNS:**
- Лучше пропустить этот шаг и использовать default `r2.dev` URLs
- Setup custom domain потом, когда будет время (5 минут через Cloudflare nameservers migration)

### Step 7: Передать credentials в Bundle Factory

После всех steps у тебя есть 4 значения:

| Variable | Например |
|---|---|
| `R2_ACCOUNT_ID` | `7c8d9e0f1a2b3c4d5e6f7g8h9i0j` |
| `R2_ACCESS_KEY_ID` | `pBjK7nX...` |
| `R2_SECRET_ACCESS_KEY` | (длинная строка) |
| `R2_BUCKET_NAME` | `salutem-bundle-factory` |
| `R2_PUBLIC_URL` | `https://images.salutemsolutions.info` или `https://pub-xxxxx.r2.dev` |

Передай эти 5 значений мне (Claude в чате), я добавлю их в:
1. Vercel env vars (Production + Preview + Development)
2. Locales `.env` для local development

ИЛИ передай Claude Code в VS Code в новом промпте: "Add Cloudflare R2 credentials to Bundle Factory: [значения]" — он сам настроит env vars и сделает test upload.

---

## 🔍 Verification

После setup Bundle Factory должна уметь:

```bash
# Test upload через CLI (Claude Code сможет проверить)
curl -X PUT \
  -H "Authorization: Bearer $R2_TOKEN" \
  --data-binary @test.jpg \
  https://$ACCOUNT_ID.r2.cloudflarestorage.com/$BUCKET/test/hello.jpg

# Verify public read
curl https://images.salutemsolutions.info/test/hello.jpg
# Should return image binary
```

Если оба работают — R2 ready для Bundle Factory.

---

## 💰 Cost monitoring

Cloudflare R2 dashboard показывает usage в real-time:
- **R2 → Bucket → Metrics**
- Storage used (GB)
- Class A operations (uploads, $4.50/1M)
- Class B operations (downloads, $0.36/1M)
- Egress: **always free** ($0 regardless of volume)

**Ожидаемый usage at 1000 bundles/mo:**
- Storage growth: +3 GB/mo (cumulative)
- Uploads: ~4000/mo (1 main + 3 secondary per bundle × 1000)
- Downloads: ~400K/mo (assuming 100 views per listing × 4 images × 1000 listings)

**Bill projection:**
- Year 1 month 12 (36 GB cumulative): $0.54 storage + $0.14 reads = **$0.68/mo**
- Year 1 month 12 at 5000/mo (180 GB cumulative): $2.70 + $0.72 = **$3.42/mo**

---

## 🚨 Troubleshooting

### "I don't have access to dashboard.cloudflare.com"
- Email reset → https://dash.cloudflare.com/forgot-password
- Если account создан давно и email потерян — create new account (легче чем recovery)

### "I see existing bucket с другим именем"
- Можно использовать existing bucket → просто skip Step 3
- Если bucket принадлежит другому проекту (e.g. shipping labels archive) → создай отдельный для Bundle Factory чтобы изолировать

### "Custom domain setup fails"
- Skip и используй default `pub-xxxxx.r2.dev` URL для MVP
- Amazon/Walmart принимают любой HTTPS URL — это работает

### "API token не работает после создания"
- Wait 30-60 seconds — Cloudflare propagation delay
- Если still не работает после 5 минут — создай новый token

---

## 🔗 Связанные документы

- `docs/marketplace-rules/amazon/image-requirements.md` — почему Amazon отклоняет Google Drive URLs (and similar)
- `docs/BUNDLE_FACTORY_COST_ANALYSIS.md` — full cost breakdown
- `docs/CLAUDE_CODE_PROMPT_BUNDLE_FACTORY_PHASE_2_1.md` — где R2 fits в pipeline (Stage 2.5 — Image Mirror)
- `docs/wiki/bundle-factory.md` — overall Bundle Factory architecture

---

## 📚 References

- Cloudflare R2 docs: https://developers.cloudflare.com/r2/
- R2 pricing: https://developers.cloudflare.com/r2/pricing/
- R2 vs S3 comparison: https://blog.cloudflare.com/r2-ga/

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
