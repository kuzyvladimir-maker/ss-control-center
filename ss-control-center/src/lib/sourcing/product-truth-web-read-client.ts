import { createClient, type Client } from "@libsql/client";

function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.trim().replace(/^['"]|['"]$/g, "") || undefined;
}
/**
 * Opens the same Product Truth database used by the Command Center. Callers
 * own the returned client and must close it. This helper authorizes reads only;
 * it does not expose an enrichment or catalog-write path.
 */
export function openProductTruthWebReadClient(): Client {
  const tursoUrl = cleanEnv(process.env.TURSO_DATABASE_URL);
  const tursoToken = cleanEnv(process.env.TURSO_AUTH_TOKEN);
  const databaseUrl = cleanEnv(process.env.DATABASE_URL);
  const url = tursoUrl && tursoToken ? tursoUrl : databaseUrl;
  if (!url) throw new Error("Product Truth database is not configured");
  return createClient({
    url,
    ...(tursoUrl && tursoToken ? { authToken: tursoToken } : {}),
  });
}
