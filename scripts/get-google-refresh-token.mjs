#!/usr/bin/env node
// Получает свежий Google OAuth refresh_token для Drive scope,
// привязанный к нашему OAuth client (GOOGLE_OAUTH_CLIENT_ID/SECRET в Vercel).
//
// Usage:
//   1. В Google Cloud Console добавь http://localhost:8080/callback
//      в Authorized redirect URIs нашего OAuth client.
//   2. node scripts/get-google-refresh-token.mjs
//   3. Откроется браузер → нажми Allow.
//   4. Скрипт сам обновит Vercel env и триггернёт redeploy.

import http from "node:http";
import { exec } from "node:child_process";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";

const PORT = 8080;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE = "https://www.googleapis.com/auth/drive";

function readClientCredsFromVercel() {
  const tmpFile = ".env.refresh-token-tmp";
  try {
    execSync(
      `vercel env pull ${tmpFile} --environment=production --yes`,
      { stdio: "pipe" },
    );
    const content = readFileSync(tmpFile, "utf8");
    unlinkSync(tmpFile);
    const idMatch = content.match(/^GOOGLE_OAUTH_CLIENT_ID="?([^"\n]+)"?/m);
    const secretMatch = content.match(
      /^GOOGLE_OAUTH_CLIENT_SECRET="?([^"\n]+)"?/m,
    );
    if (!idMatch || !secretMatch) {
      throw new Error(
        "Не нашёл GOOGLE_OAUTH_CLIENT_ID / _SECRET в Vercel env",
      );
    }
    return { clientId: idMatch[1], clientSecret: secretMatch[1] };
  } catch (e) {
    if (existsSync(tmpFile)) unlinkSync(tmpFile);
    throw e;
  }
}

function buildAuthUrl(clientId) {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  return u.toString();
}

function waitForCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<h1>❌ Ошибка</h1><p>${error}</p><p>Закрой вкладку и вернись в терминал.</p>`,
        );
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      if (code) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<h1>✅ Готово</h1><p>Код получен. Можно закрыть эту вкладку и смотреть терминал.</p>`,
        );
        server.close();
        resolve(code);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.on("error", reject);
    server.listen(PORT);
  });
}

async function exchangeCodeForTokens({ code, clientId, clientSecret }) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (!res.ok || !json.refresh_token) {
    throw new Error(
      `Token exchange failed: ${res.status} ${JSON.stringify(json)}`,
    );
  }
  return json;
}

async function verifyToken({ refreshToken, clientId, clientSecret }) {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`Verify failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json.access_token;
}

function updateVercelEnv(refreshToken) {
  console.log("\n→ Обновляю GOOGLE_OAUTH_REFRESH_TOKEN на Vercel...");
  // Remove old value
  try {
    execSync("vercel env rm GOOGLE_OAUTH_REFRESH_TOKEN production --yes", {
      stdio: "pipe",
    });
  } catch {
    // already absent — ok
  }
  // Add new value via stdin
  execSync("vercel env add GOOGLE_OAUTH_REFRESH_TOKEN production", {
    input: refreshToken + "\n",
    stdio: ["pipe", "inherit", "inherit"],
  });
}

function triggerRedeploy() {
  console.log("\n→ Триггерю redeploy (empty commit + push)...");
  execSync('git commit --allow-empty -m "chore: refresh google oauth token"', {
    stdio: "inherit",
  });
  execSync("git push origin main", { stdio: "inherit" });
}

async function main() {
  console.log("→ Беру CLIENT_ID/SECRET из Vercel...");
  const { clientId, clientSecret } = readClientCredsFromVercel();
  console.log(`  client_id: ${clientId.slice(0, 30)}...`);

  const authUrl = buildAuthUrl(clientId);
  console.log("\n→ Открываю браузер на Google consent screen...");
  console.log("  Если не открылся сам, скопируй URL:");
  console.log("  " + authUrl + "\n");
  exec(`open "${authUrl}"`);

  console.log(`→ Жду редирект на ${REDIRECT_URI} ...`);
  const code = await waitForCode();
  console.log("✅ Код получен, обмениваю на токены...");

  const tokens = await exchangeCodeForTokens({
    code,
    clientId,
    clientSecret,
  });
  console.log("✅ refresh_token получен");
  console.log("  scope: " + tokens.scope);

  console.log("\n→ Проверяю что токен действительно работает...");
  await verifyToken({
    refreshToken: tokens.refresh_token,
    clientId,
    clientSecret,
  });
  console.log("✅ Verify passed — токен валидный, привязан к нашему client");

  updateVercelEnv(tokens.refresh_token);
  console.log("✅ Vercel env обновлён");

  triggerRedeploy();
  console.log("\n🎉 ГОТОВО. Vercel пересоберётся за ~1-2 минуты.");
  console.log(
    "   Купи новую этикетку и проверь, что в модалке PDF: saved to Drive.",
  );
}

main().catch((e) => {
  console.error("\n❌ FAIL:", e.message);
  process.exit(1);
});
