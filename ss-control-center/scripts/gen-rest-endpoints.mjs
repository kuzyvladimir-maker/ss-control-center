// Regenerates src/lib/jackie-mcp/rest-endpoints.generated.ts — a snapshot of
// the REST API surface served by GET /api/sscc/manifest?full=1 for agent
// (Jackie) endpoint discovery. Serverless can't scan source files at runtime,
// so we bake the list in at build time.
//
//   node scripts/gen-rest-endpoints.mjs
//
// Run after adding/removing/renaming routes under src/app/api.

import fs from "fs";
import path from "path";

const root = "src/app/api";
const rows = [];

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.startsWith("route.")) {
      const rel =
        "/" + path.relative("src/app", path.dirname(p)).split(path.sep).join("/");
      const src = fs.readFileSync(p, "utf8");
      const methods = [
        ...src.matchAll(
          /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)/g
        ),
      ].map((m) => m[1]);
      const all = [...new Set(methods)];
      if (all.length) rows.push({ path: rel, methods: all });
    }
  }
}

walk(root);
rows.sort((a, b) => a.path.localeCompare(b.path));

const out = `// AUTO-GENERATED — do not edit by hand.
// Snapshot of the REST API surface for Jackie/agent discovery via
// GET /api/sscc/manifest?full=1. Regenerate with scripts/gen-rest-endpoints.mjs
// after adding/removing routes.

export interface RestEndpoint { path: string; methods: string[] }

export const REST_ENDPOINTS: RestEndpoint[] = ${JSON.stringify(rows, null, 2)};

export const REST_ENDPOINTS_COUNT = ${rows.length};
`;

fs.writeFileSync("src/lib/jackie-mcp/rest-endpoints.generated.ts", out);
console.log(`wrote rest-endpoints.generated.ts with ${rows.length} endpoints`);
