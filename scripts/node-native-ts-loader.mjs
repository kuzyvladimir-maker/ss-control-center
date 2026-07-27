// Minimal local-only loader for running this repository's TypeScript tests with
// Node 25's built-in type transform. It resolves the tsconfig `@/*` alias,
// extensionless local imports, and JSON modules without downloading a runner.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function existingFile(base) {
  const candidates = path.extname(base)
    ? [base]
    : [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next deterministic candidate.
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  let candidate = null;
  if (specifier.startsWith("@/")) {
    candidate = existingFile(path.resolve(process.cwd(), "src", specifier.slice(2)));
  } else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    candidate = existingFile(
      path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier),
    );
  }
  if (candidate) {
    return { url: pathToFileURL(candidate).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".json")) {
    const source = readFileSync(fileURLToPath(url), "utf8");
    return {
      format: "module",
      source: `export default ${source};`,
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
