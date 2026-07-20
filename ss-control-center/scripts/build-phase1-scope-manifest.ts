#!/usr/bin/env node

/**
 * Build a fail-closed Phase 1 live-listing scope manifest from local exports.
 *
 * This script performs local file reads and local artifact writes only. It has
 * no marketplace, retailer, AI-provider, database, or paid-call transport.
 *
 * Example:
 *   npx tsx scripts/build-phase1-scope-manifest.ts \
 *     --as-of 2026-07-18T22:00:00Z \
 *     --census /captures/phase1-connected-store-census.json \
 *     --disposition data/phase1-scope-disposition.json \
 *     --amazon store1=/exports/store1-all-listings.tsv \
 *     --amazon store3=/exports/store3-all-listings.tsv \
 *     --walmart store1=/exports/walmart-item-catalog.csv \
 *     --out-dir data/audits/product-truth-phase1-scope
 *
 * The disposition document must explicitly mark every required key as
 * IN_SCOPE, EXCLUDED_OWNER_CONFIRMED, or UNRESOLVED. Only IN_SCOPE keys accept
 * reports. A blocked diagnostic artifact is still written, then the CLI exits 2.
 */

import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildPhase1ScopeManifest,
  renderPhase1ScopeManifestCsv,
  renderPhase1ScopeManifestJson,
  renderPhase1Sha256Manifest,
  type Phase1Channel,
  type Phase1LocalReportInput,
} from "../src/lib/sourcing/phase1-scope-manifest";

interface CliOptions {
  asOf: string;
  censusPath: string;
  dispositionPath: string;
  reportPaths: Array<{ channel: Phase1Channel; scopeKey: string; path: string }>;
  outDir: string;
  artifactBaseName: string;
  maxReportAgeHours: number;
  maxReportSkewHours: number;
}

const HELP = `
Build the authoritative Phase 1 Amazon + Walmart scope from local reports only.

Required:
  --as-of <ISO timestamp with timezone>
  --census <canonical connected-store-census.json>
  --disposition <owner-disposition.json>
  --amazon <scopeKey=/path/to/GET_MERCHANT_LISTINGS_ALL_DATA.tsv>  (repeatable)
  --walmart <scopeKey=/path/to/ITEM_CATALOG.csv-or-tsv>             (repeatable)
  --out-dir <artifact directory>

Optional:
  --basename <artifact base name>       default: phase1-scope-manifest
  --max-report-age-hours <number>       default: 36
  --max-report-skew-hours <number>      default: 24
  --help

Exit codes: 0 authoritative; 2 blocked/invalid; 1 unexpected local I/O failure.
The output directory must not already exist. Manifest bundles are never overwritten.
Manual --required-amazon/--required-walmart denominators are rejected. Required
scopes are derived only from the owner-attested census.
`;

function takeValue(args: string[], index: number, name: string): { value: string; next: number } {
  const current = args[index];
  const equalsPrefix = `${name}=`;
  if (current.startsWith(equalsPrefix)) {
    const value = current.slice(equalsPrefix.length);
    if (!value) throw new Error(`${name} requires a value.`);
    return { value, next: index };
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return { value, next: index + 1 };
}

function parseReportPath(
  value: string,
  channel: Phase1Channel,
): { channel: Phase1Channel; scopeKey: string; path: string } {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`--${channel} must use scopeKey=/path syntax.`);
  }
  const scopeKey = value.slice(0, separator).trim().toLowerCase();
  const path = value.slice(separator + 1).trim();
  if (!scopeKey || !path) throw new Error(`--${channel} must use scopeKey=/path syntax.`);
  return { channel, scopeKey, path };
}

function finitePositive(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive finite number.`);
  }
  return parsed;
}

export function parsePhase1ManifestCliArguments(args: string[]): CliOptions {
  let asOf = "";
  let censusPath = "";
  let dispositionPath = "";
  let outDir = "";
  let artifactBaseName = "phase1-scope-manifest";
  let maxReportAgeHours = 36;
  let maxReportSkewHours = 24;
  const reportPaths: CliOptions["reportPaths"] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help") throw new Error("HELP");
    if (arg === "--as-of" || arg.startsWith("--as-of=")) {
      const result = takeValue(args, index, "--as-of");
      asOf = result.value;
      index = result.next;
    } else if (arg === "--census" || arg.startsWith("--census=")) {
      const result = takeValue(args, index, "--census");
      censusPath = result.value;
      index = result.next;
    } else if (arg === "--disposition" || arg.startsWith("--disposition=")) {
      const result = takeValue(args, index, "--disposition");
      dispositionPath = result.value;
      index = result.next;
    } else if (
      arg === "--required-amazon" || arg.startsWith("--required-amazon=")
      || arg === "--required-walmart" || arg.startsWith("--required-walmart=")
    ) {
      throw new Error(
        "Manual required-scope flags are forbidden; use --census as the only denominator.",
      );
    } else if (arg === "--amazon" || arg.startsWith("--amazon=")) {
      const result = takeValue(args, index, "--amazon");
      reportPaths.push(parseReportPath(result.value, "amazon"));
      index = result.next;
    } else if (arg === "--walmart" || arg.startsWith("--walmart=")) {
      const result = takeValue(args, index, "--walmart");
      reportPaths.push(parseReportPath(result.value, "walmart"));
      index = result.next;
    } else if (arg === "--out-dir" || arg.startsWith("--out-dir=")) {
      const result = takeValue(args, index, "--out-dir");
      outDir = result.value;
      index = result.next;
    } else if (arg === "--basename" || arg.startsWith("--basename=")) {
      const result = takeValue(args, index, "--basename");
      artifactBaseName = result.value;
      index = result.next;
    } else if (
      arg === "--max-report-age-hours" ||
      arg.startsWith("--max-report-age-hours=")
    ) {
      const result = takeValue(args, index, "--max-report-age-hours");
      maxReportAgeHours = finitePositive(result.value, "--max-report-age-hours");
      index = result.next;
    } else if (
      arg === "--max-report-skew-hours" ||
      arg.startsWith("--max-report-skew-hours=")
    ) {
      const result = takeValue(args, index, "--max-report-skew-hours");
      maxReportSkewHours = finitePositive(result.value, "--max-report-skew-hours");
      index = result.next;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!asOf) throw new Error("--as-of is required.");
  if (!censusPath) throw new Error("--census is required.");
  if (!dispositionPath) throw new Error("--disposition is required.");
  if (!outDir) throw new Error("--out-dir is required.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(artifactBaseName)) {
    throw new Error("--basename may contain only letters, digits, dot, underscore, and hyphen.");
  }

  return {
    asOf,
    censusPath,
    dispositionPath,
    reportPaths,
    outDir,
    artifactBaseName,
    maxReportAgeHours,
    maxReportSkewHours,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function runPhase1ManifestCli(args: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parsePhase1ManifestCliArguments(args);
  } catch (error) {
    if (error instanceof Error && error.message === "HELP") {
      process.stdout.write(HELP);
      return 0;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${HELP}`);
    return 2;
  }

  let censusContent: string;
  let disposition: unknown;
  try {
    censusContent = await readFile(resolve(options.censusPath), "utf8");
    disposition = JSON.parse(await readFile(resolve(options.dispositionPath), "utf8")) as unknown;
  } catch (error) {
    process.stderr.write(
      `Cannot read census or parse disposition JSON: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  const reports: Phase1LocalReportInput[] = [];
  try {
    for (const report of options.reportPaths) {
      const absolutePath = resolve(report.path);
      reports.push({
        channel: report.channel,
        scopeKey: report.scopeKey,
        sourceName: basename(absolutePath),
        content: await readFile(absolutePath, "utf8"),
      });
    }
  } catch (error) {
    process.stderr.write(
      `Cannot read local source report: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  const manifest = buildPhase1ScopeManifest({
    asOf: options.asOf,
    connectedStoreCensus: {
      sourceName: basename(resolve(options.censusPath)),
      content: censusContent,
    },
    disposition,
    reports,
    maxReportAgeHours: options.maxReportAgeHours,
    maxReportSkewHours: options.maxReportSkewHours,
  });
  const json = renderPhase1ScopeManifestJson(manifest);
  const csv = renderPhase1ScopeManifestCsv(manifest);
  const jsonName = `${options.artifactBaseName}.json`;
  const csvName = `${options.artifactBaseName}.csv`;
  const censusName = `${options.artifactBaseName}.connected-store-census.json`;
  const checksumName = `${options.artifactBaseName}.sha256`;
  const checksum = renderPhase1Sha256Manifest([
    { fileName: jsonName, content: json },
    { fileName: csvName, content: csv },
    { fileName: censusName, content: censusContent },
  ]);

  const outputDirectory = resolve(options.outDir);
  const outputPaths = [jsonName, csvName, censusName, checksumName].map((name) =>
    resolve(outputDirectory, name),
  );
  if (await pathExists(outputDirectory)) {
    process.stderr.write(
      `Refusing to reuse existing artifact directory: ${outputDirectory}\nChoose a new output directory; manifest bundles are immutable.\n`,
    );
    return 2;
  }
  if (!(await pathExists(dirname(outputDirectory)))) {
    process.stderr.write(
      `Output parent directory does not exist: ${dirname(outputDirectory)}\n`,
    );
    return 2;
  }
  try {
    // Exclusive directory creation is the local immutability boundary. The
    // checksum is written last, so a partial/crashed bundle has no seal and the
    // directory is never silently reused.
    await mkdir(outputDirectory);
  } catch (error) {
    process.stderr.write(
      `Cannot create new immutable artifact directory: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  await writeAtomically(outputPaths[0], json);
  await writeAtomically(outputPaths[1], csv);
  await writeAtomically(outputPaths[2], censusContent);
  await writeAtomically(outputPaths[3], checksum);

  process.stdout.write(
    `${manifest.authoritative ? "AUTHORITATIVE" : "BLOCKED"}: ` +
      `${manifest.counts.liveListings} live listings, ` +
      `${manifest.counts.blockerCount} blockers.\n` +
      `${outputPaths.join("\n")}\n`,
  );
  if (!manifest.authoritative) {
    for (const blocker of manifest.blockers) {
      process.stderr.write(
        `[${blocker.code}] ${blocker.channel ?? "global"}:${blocker.scopeKey ?? "global"} ${blocker.message}\n`,
      );
    }
    return 2;
  }
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  runPhase1ManifestCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `Unexpected local manifest failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
