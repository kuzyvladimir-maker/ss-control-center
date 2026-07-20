import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

export const WALMART_NEW_SKU_SOURCE_RELEASE_VERSION =
  "walmart-new-sku-source-release/3.2.0" as const;
export const WALMART_NEW_SKU_FROZEN_RELEASE_VERSION =
  "walmart-new-sku-frozen-source-release/2.1.0" as const;
export const WALMART_NEW_SKU_RUNTIME_DEPENDENCY_POLICY_VERSION =
  "walmart-new-sku-runtime-dependency-closure/1.1.0" as const;

export const WALMART_NEW_SKU_RELEASE_TREES = [
  "src",
  "scripts",
  "prisma/migrations",
] as const;

export const WALMART_NEW_SKU_RELEASE_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "_gen.ts",
  "_gimgres.ts",
  "_multi.ts",
  "_qavalidate.ts",
  "_trial100.ts",
  "prisma/schema.prisma",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vercel.json",
] as const;

export const WALMART_NEW_SKU_SOURCE_METADATA_EXCLUSIONS =
  Object.freeze([".DS_Store"] as const);

// These are the external packages in the operator entrypoint and frozen
// certification gate, plus the TypeScript loader used by the package scripts.
// The resolver below includes each exact installed package root, required
// dependencies, installed optional dependencies and non-optional peers.
// A frozen full-CLI integration test is the release gate when this list changes.
export const WALMART_NEW_SKU_RUNTIME_DEPENDENCY_SEEDS = Object.freeze([
  "@anthropic-ai/sdk",
  "@libsql/client",
  "@prisma/adapter-libsql",
  "@prisma/client",
  "ajv",
  "date-holidays",
  // Required by the frozen Product Truth certification suite's route guard.
  "next",
  "sharp",
  "tsx",
] as const);

// The certification suite imports next/server only for NextRequest semantics.
// Next's optional SWC and image-native packages are separate package roots and
// are not used by that server-runtime path. The frozen certification run is the
// executable completeness proof for this narrowly disclosed omission.
export const WALMART_NEW_SKU_RUNTIME_OPTIONAL_DEPENDENCY_OMISSIONS =
  Object.freeze(["next"] as const);

const FROZEN_DIRECTORY_MODE = "0555" as const;
const FROZEN_REGULAR_FILE_MODE = "0444" as const;
const FROZEN_EXECUTABLE_FILE_MODE = "0555" as const;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const COPY_CONCURRENCY = 16;

type FrozenReleaseMode =
  | typeof FROZEN_DIRECTORY_MODE
  | typeof FROZEN_REGULAR_FILE_MODE
  | typeof FROZEN_EXECUTABLE_FILE_MODE;

export interface WalmartNewSkuReleaseDirectoryEntry {
  relative_path: string;
  kind: "DIRECTORY";
  mode: typeof FROZEN_DIRECTORY_MODE;
}

export interface WalmartNewSkuReleaseFileEntry {
  relative_path: string;
  kind: "FILE";
  mode: typeof FROZEN_REGULAR_FILE_MODE | typeof FROZEN_EXECUTABLE_FILE_MODE;
  byte_size: number;
  sha256: string;
}

export type WalmartNewSkuSourceReleaseEntry =
  | WalmartNewSkuReleaseDirectoryEntry
  | WalmartNewSkuReleaseFileEntry;

export interface WalmartNewSkuRuntimePackage {
  name: string;
  version: string;
  relative_root: string;
  package_json_sha256: string;
}

export interface WalmartNewSkuRuntimeDependencyDescriptor {
  policy_version: typeof WALMART_NEW_SKU_RUNTIME_DEPENDENCY_POLICY_VERSION;
  seed_packages: readonly string[];
  packages: WalmartNewSkuRuntimePackage[];
  entries: WalmartNewSkuSourceReleaseEntry[];
  package_count: number;
  file_count: number;
  total_file_bytes: number;
  npm_bin_shims_included: false;
  nested_package_roots_collected_independently: true;
  symlinks_allowed: false;
  optional_dependency_omissions: readonly string[];
}

export interface WalmartNewSkuSourceReleaseDescriptor {
  schema_version: typeof WALMART_NEW_SKU_SOURCE_RELEASE_VERSION;
  node_runtime: {
    platform: NodeJS.Platform;
    arch: string;
  };
  excluded_source_metadata_basenames: readonly string[];
  source_entries: WalmartNewSkuSourceReleaseEntry[];
  runtime_dependencies: WalmartNewSkuRuntimeDependencyDescriptor;
}

export interface WalmartNewSkuSourceReleaseInspection {
  source_root: string;
  descriptor: WalmartNewSkuSourceReleaseDescriptor;
  engine_release_sha256: string;
}

export interface WalmartNewSkuFrozenReleaseManifest {
  schema_version: typeof WALMART_NEW_SKU_FROZEN_RELEASE_VERSION;
  created_at: string;
  engine_release_sha256: string;
  entry_count: number;
  package_lock_sha256: string;
  release_root_relative_path: "release";
  source_root_fingerprint_sha256: string;
  source_release: WalmartNewSkuSourceReleaseDescriptor;
  claims: {
    ambient_credential_files_included: false;
    embedded_secret_scan_performed: false;
    application_data_directory_included: false;
    runtime_dependencies_included: true;
    runtime_dependencies_sealed: true;
    operator_contract_file_included: true;
    claude_operator_contract_bootstrap_included: true;
    product_truth_git_release_redefined: false;
    broad_source_boundary: true;
    operator_surface_isolated: false;
    release_root_read_only: true;
    source_directories_read_only: true;
    source_files_read_only: true;
    exact_recursive_topology_enforced: true;
    symlinks_allowed: false;
    special_files_allowed: false;
  };
}

export class WalmartNewSkuSourceReleaseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "WalmartNewSkuSourceReleaseError";
  }
}

function sha256(value: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, "en-US"))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function canonicalWalmartNewSkuFrozenReleaseArtifact(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

export function walmartNewSkuFrozenReleaseArtifactSha256(value: unknown): string {
  return sha256(canonicalWalmartNewSkuFrozenReleaseArtifact(value));
}

function portableRelativePath(root: string, absolutePath: string): string {
  const result = relative(root, absolutePath).split(sep).join("/");
  if (
    !result
    || result === ".."
    || result.startsWith("../")
    || result.startsWith("/")
  ) {
    throw new WalmartNewSkuSourceReleaseError(
      "RELEASE_PATH_ESCAPE",
      `release path escapes the source root: ${absolutePath}`,
    );
  }
  return result;
}

function assertSafeRelativePath(relativePath: string): void {
  if (
    !relativePath
    || relativePath.includes("\\")
    || relativePath.startsWith("/")
    || relativePath === ".."
    || relativePath.startsWith("../")
    || relativePath.includes("/../")
    || relativePath.endsWith("/..")
  ) {
    throw new WalmartNewSkuSourceReleaseError(
      "RELEASE_RELATIVE_PATH_INVALID",
      relativePath,
    );
  }
}

function exactMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

function normalizedFileMode(mode: number): FrozenReleaseMode {
  return (mode & 0o111) === 0
    ? FROZEN_REGULAR_FILE_MODE
    : FROZEN_EXECUTABLE_FILE_MODE;
}

function sortedEntries(
  entries: Iterable<WalmartNewSkuSourceReleaseEntry>,
): WalmartNewSkuSourceReleaseEntry[] {
  return [...entries].sort((left, right) =>
    left.relative_path.localeCompare(right.relative_path, "en-US"));
}

function addEntry(
  target: Map<string, WalmartNewSkuSourceReleaseEntry>,
  entry: WalmartNewSkuSourceReleaseEntry,
): void {
  const existing = target.get(entry.relative_path);
  if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) {
    throw new WalmartNewSkuSourceReleaseError(
      "RELEASE_TOPOLOGY_CONFLICT",
      entry.relative_path,
    );
  }
  target.set(entry.relative_path, entry);
}

function addAncestorDirectories(
  target: Map<string, WalmartNewSkuSourceReleaseEntry>,
  relativePath: string,
): void {
  let current = dirname(relativePath).split(sep).join("/");
  while (current !== ".") {
    addEntry(target, {
      relative_path: current,
      kind: "DIRECTORY",
      mode: FROZEN_DIRECTORY_MODE,
    });
    current = dirname(current).split(sep).join("/");
  }
}

async function regularFileEntry(
  root: string,
  relativePath: string,
): Promise<WalmartNewSkuReleaseFileEntry> {
  assertSafeRelativePath(relativePath);
  const absolutePath = resolve(root, relativePath);
  if (portableRelativePath(root, absolutePath) !== relativePath) {
    throw new WalmartNewSkuSourceReleaseError(
      "RELEASE_PATH_NORMALIZATION_DRIFT",
      relativePath,
    );
  }
  const file = await lstat(absolutePath).catch((error: unknown) => {
    throw new WalmartNewSkuSourceReleaseError(
      "RELEASE_FILE_MISSING",
      `${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (file.isSymbolicLink()) {
    throw new WalmartNewSkuSourceReleaseError(
      "RELEASE_SYMLINK_FORBIDDEN",
      relativePath,
    );
  }
  if (!file.isFile()) {
    throw new WalmartNewSkuSourceReleaseError(
      "RELEASE_NON_REGULAR_FILE_FORBIDDEN",
      relativePath,
    );
  }
  return {
    relative_path: relativePath,
    kind: "FILE",
    mode: normalizedFileMode(file.mode),
    byte_size: file.size,
    sha256: await sha256File(absolutePath),
  };
}

async function collectTreeEntries(input: {
  root: string;
  relativeRoot: string;
  target: Map<string, WalmartNewSkuSourceReleaseEntry>;
  excludedBasenames?: readonly string[];
  skipNpmBinDirectories?: boolean;
  skipNestedNodeModules?: boolean;
}): Promise<void> {
  assertSafeRelativePath(input.relativeRoot);
  addAncestorDirectories(input.target, input.relativeRoot);
  const absoluteRoot = resolve(input.root, input.relativeRoot);
  const rootStat = await lstat(absoluteRoot).catch((error: unknown) => {
    throw new WalmartNewSkuSourceReleaseError(
      "RELEASE_TREE_MISSING",
      `${input.relativeRoot}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (rootStat.isSymbolicLink()) {
    throw new WalmartNewSkuSourceReleaseError(
      "RELEASE_SYMLINK_FORBIDDEN",
      input.relativeRoot,
    );
  }
  if (!rootStat.isDirectory()) {
    throw new WalmartNewSkuSourceReleaseError(
      "RELEASE_TREE_NOT_DIRECTORY",
      input.relativeRoot,
    );
  }

  async function walk(absoluteDirectory: string): Promise<void> {
    const relativeDirectory = portableRelativePath(input.root, absoluteDirectory);
    addEntry(input.target, {
      relative_path: relativeDirectory,
      kind: "DIRECTORY",
      mode: FROZEN_DIRECTORY_MODE,
    });
    const names = await readdir(absoluteDirectory);
    names.sort((left, right) => left.localeCompare(right, "en-US"));
    for (const name of names) {
      if (input.excludedBasenames?.includes(name)) continue;
      if (input.skipNpmBinDirectories && name === ".bin") continue;
      if (input.skipNestedNodeModules && name === "node_modules") continue;
      const absolutePath = resolve(absoluteDirectory, name);
      const relativePath = portableRelativePath(input.root, absolutePath);
      const state = await lstat(absolutePath);
      if (state.isSymbolicLink()) {
        throw new WalmartNewSkuSourceReleaseError(
          "RELEASE_SYMLINK_FORBIDDEN",
          relativePath,
        );
      }
      if (state.isDirectory()) {
        await walk(absolutePath);
      } else if (state.isFile()) {
        addEntry(input.target, {
          relative_path: relativePath,
          kind: "FILE",
          mode: normalizedFileMode(state.mode),
          byte_size: state.size,
          sha256: await sha256File(absolutePath),
        });
      } else {
        throw new WalmartNewSkuSourceReleaseError(
          "RELEASE_NON_REGULAR_FILE_FORBIDDEN",
          relativePath,
        );
      }
    }
  }
  await walk(absoluteRoot);
}

async function collectSourceEntries(
  sourceRoot: string,
): Promise<WalmartNewSkuSourceReleaseEntry[]> {
  const entries = new Map<string, WalmartNewSkuSourceReleaseEntry>();
  for (const tree of WALMART_NEW_SKU_RELEASE_TREES) {
    await collectTreeEntries({
      root: sourceRoot,
      relativeRoot: tree,
      target: entries,
      excludedBasenames: WALMART_NEW_SKU_SOURCE_METADATA_EXCLUSIONS,
    });
  }
  for (const relativePath of WALMART_NEW_SKU_RELEASE_FILES) {
    addAncestorDirectories(entries, relativePath);
    addEntry(entries, await regularFileEntry(sourceRoot, relativePath));
  }
  const sorted = sortedEntries(entries.values());
  for (const entry of sorted) {
    const segments = entry.relative_path.split("/");
    const basename = segments.at(-1);
    if (
      entry.kind === "FILE"
      && (basename === ".env" || basename === ".env.local" || basename === ".npmrc")
    ) {
      throw new WalmartNewSkuSourceReleaseError(
        "RELEASE_AMBIENT_CREDENTIAL_FILE_FORBIDDEN",
        entry.relative_path,
      );
    }
    if (segments.includes("node_modules")) {
      throw new WalmartNewSkuSourceReleaseError(
        "RELEASE_SOURCE_NODE_MODULES_FORBIDDEN",
        entry.relative_path,
      );
    }
  }
  return sorted;
}

interface ParsedPackageJson {
  name: string;
  version: string;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

async function readPackageJson(path: string): Promise<ParsedPackageJson> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new WalmartNewSkuSourceReleaseError(
      "RUNTIME_DEPENDENCY_PACKAGE_JSON_INVALID",
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed.name !== "string" || typeof parsed.version !== "string") {
    throw new WalmartNewSkuSourceReleaseError(
      "RUNTIME_DEPENDENCY_PACKAGE_IDENTITY_INVALID",
      path,
    );
  }
  const rawMeta = parsed.peerDependenciesMeta;
  const peerDependenciesMeta: Record<string, { optional?: boolean }> = {};
  if (rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)) {
    for (const [name, value] of Object.entries(rawMeta as Record<string, unknown>)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        peerDependenciesMeta[name] = {
          optional: (value as Record<string, unknown>).optional === true,
        };
      }
    }
  }
  return {
    name: parsed.name,
    version: parsed.version,
    dependencies: stringRecord(parsed.dependencies),
    optionalDependencies: stringRecord(parsed.optionalDependencies),
    peerDependencies: stringRecord(parsed.peerDependencies),
    peerDependenciesMeta,
  };
}

function packagePathParts(packageName: string): string[] {
  if (!/^(?:@[a-z0-9._~-]+\/[a-z0-9._~-]+|[a-z0-9._~-]+)$/iu.test(packageName)) {
    throw new WalmartNewSkuSourceReleaseError(
      "RUNTIME_DEPENDENCY_NAME_INVALID",
      packageName,
    );
  }
  return packageName.split("/");
}

async function resolveInstalledPackageRoot(input: {
  sourceRoot: string;
  packageName: string;
  fromDirectory: string;
}): Promise<string | null> {
  const parts = packagePathParts(input.packageName);
  let current = resolve(input.fromDirectory);
  const sourceRoot = resolve(input.sourceRoot);
  while (
    current === sourceRoot
    || (!relative(sourceRoot, current).startsWith(`..${sep}`)
      && relative(sourceRoot, current) !== ".."
      && !isAbsolute(relative(sourceRoot, current)))
  ) {
    const candidate = resolve(current, "node_modules", ...parts);
    const packageJson = resolve(candidate, "package.json");
    const state = await lstat(packageJson).catch(() => null);
    if (state) {
      const rootState = await lstat(candidate);
      if (state.isSymbolicLink() || !state.isFile()
        || rootState.isSymbolicLink() || !rootState.isDirectory()) {
        throw new WalmartNewSkuSourceReleaseError(
          "RUNTIME_DEPENDENCY_PACKAGE_UNSAFE",
          candidate,
        );
      }
      return candidate;
    }
    if (current === sourceRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

async function collectRuntimeDependencies(
  sourceRoot: string,
): Promise<WalmartNewSkuRuntimeDependencyDescriptor> {
  const queue: Array<{
    name: string;
    fromDirectory: string;
    required: boolean;
  }> = WALMART_NEW_SKU_RUNTIME_DEPENDENCY_SEEDS.map((name) => ({
    name,
    fromDirectory: sourceRoot,
    required: true,
  }));
  const packages = new Map<string, WalmartNewSkuRuntimePackage>();
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    const packageRoot = await resolveInstalledPackageRoot({
      sourceRoot,
      packageName: current.name,
      fromDirectory: current.fromDirectory,
    });
    if (!packageRoot) {
      if (!current.required) continue;
      throw new WalmartNewSkuSourceReleaseError(
        "RUNTIME_DEPENDENCY_MISSING",
        `${current.name} from ${current.fromDirectory}`,
      );
    }
    if (packages.has(packageRoot)) continue;
    const packageJsonPath = resolve(packageRoot, "package.json");
    const packageJson = await readPackageJson(packageJsonPath);
    if (packageJson.name !== current.name) {
      throw new WalmartNewSkuSourceReleaseError(
        "RUNTIME_DEPENDENCY_IDENTITY_MISMATCH",
        `${current.name} resolved to ${packageJson.name}`,
      );
    }
    const relativeRoot = portableRelativePath(sourceRoot, packageRoot);
    if (!relativeRoot.startsWith("node_modules/")) {
      throw new WalmartNewSkuSourceReleaseError(
        "RUNTIME_DEPENDENCY_OUTSIDE_NODE_MODULES",
        relativeRoot,
      );
    }
    packages.set(packageRoot, {
      name: packageJson.name,
      version: packageJson.version,
      relative_root: relativeRoot,
      package_json_sha256: await sha256File(packageJsonPath),
    });

    const optionalNames = new Set(Object.keys(packageJson.optionalDependencies));
    const requiredDependencies = Object.keys(packageJson.dependencies)
      .filter((name) => !optionalNames.has(name));
    for (const name of requiredDependencies) {
      queue.push({ name, fromDirectory: packageRoot, required: true });
    }
    if (!WALMART_NEW_SKU_RUNTIME_OPTIONAL_DEPENDENCY_OMISSIONS.some(
      (name) => name === packageJson.name,
    )) {
      for (const name of optionalNames) {
        queue.push({ name, fromDirectory: packageRoot, required: false });
      }
    }
    for (const name of Object.keys(packageJson.peerDependencies)) {
      if (packageJson.peerDependenciesMeta[name]?.optional === true) continue;
      queue.push({
        name,
        fromDirectory: packageRoot,
        required: true,
      });
    }
  }

  const entries = new Map<string, WalmartNewSkuSourceReleaseEntry>();
  addEntry(entries, {
    relative_path: "node_modules",
    kind: "DIRECTORY",
    mode: FROZEN_DIRECTORY_MODE,
  });
  const sortedPackages = [...packages.values()].sort((left, right) =>
    left.relative_root.localeCompare(right.relative_root, "en-US"));
  for (const pkg of sortedPackages) {
    await collectTreeEntries({
      root: sourceRoot,
      relativeRoot: pkg.relative_root,
      target: entries,
      skipNpmBinDirectories: true,
      skipNestedNodeModules: true,
    });
  }
  const sorted = sortedEntries(entries.values());
  const files = sorted.filter(
    (entry): entry is WalmartNewSkuReleaseFileEntry => entry.kind === "FILE",
  );
  return {
    policy_version: WALMART_NEW_SKU_RUNTIME_DEPENDENCY_POLICY_VERSION,
    seed_packages: [...WALMART_NEW_SKU_RUNTIME_DEPENDENCY_SEEDS],
    packages: sortedPackages,
    entries: sorted,
    package_count: sortedPackages.length,
    file_count: files.length,
    total_file_bytes: files.reduce((sum, entry) => sum + entry.byte_size, 0),
    npm_bin_shims_included: false,
    nested_package_roots_collected_independently: true,
    symlinks_allowed: false,
    optional_dependency_omissions:
      WALMART_NEW_SKU_RUNTIME_OPTIONAL_DEPENDENCY_OMISSIONS,
  };
}

export function walmartNewSkuSourceReleaseSha256(
  descriptor: WalmartNewSkuSourceReleaseDescriptor,
): string {
  if (descriptor.schema_version !== WALMART_NEW_SKU_SOURCE_RELEASE_VERSION) {
    throw new WalmartNewSkuSourceReleaseError(
      "SOURCE_RELEASE_VERSION_INVALID",
      String(descriptor.schema_version),
    );
  }
  return sha256(JSON.stringify(stableValue(descriptor)));
}

function sourceReleaseDescriptorsEqual(
  left: WalmartNewSkuSourceReleaseDescriptor,
  right: WalmartNewSkuSourceReleaseDescriptor,
): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

export async function inspectWalmartNewSkuSourceRelease(
  sourceRoot = process.cwd(),
): Promise<WalmartNewSkuSourceReleaseInspection> {
  const absoluteRoot = resolve(sourceRoot);
  const source = await lstat(absoluteRoot).catch((error: unknown) => {
    throw new WalmartNewSkuSourceReleaseError(
      "SOURCE_ROOT_UNREADABLE",
      error instanceof Error ? error.message : String(error),
    );
  });
  if (source.isSymbolicLink() || !source.isDirectory()) {
    throw new WalmartNewSkuSourceReleaseError(
      "SOURCE_ROOT_INVALID",
      "source root must be a real directory, not a symlink",
    );
  }
  const [sourceEntries, runtimeDependencies] = await Promise.all([
    collectSourceEntries(absoluteRoot),
    collectRuntimeDependencies(absoluteRoot),
  ]);
  const descriptor: WalmartNewSkuSourceReleaseDescriptor = {
    schema_version: WALMART_NEW_SKU_SOURCE_RELEASE_VERSION,
    node_runtime: {
      platform: process.platform,
      arch: process.arch,
    },
    excluded_source_metadata_basenames:
      WALMART_NEW_SKU_SOURCE_METADATA_EXCLUSIONS,
    source_entries: sourceEntries,
    runtime_dependencies: runtimeDependencies,
  };
  return {
    source_root: absoluteRoot,
    descriptor,
    engine_release_sha256: walmartNewSkuSourceReleaseSha256(descriptor),
  };
}

function combinedDescriptorEntries(
  descriptor: WalmartNewSkuSourceReleaseDescriptor,
): WalmartNewSkuSourceReleaseEntry[] {
  return sortedEntries([
    ...descriptor.source_entries,
    ...descriptor.runtime_dependencies.entries,
  ]);
}

function modeNumber(mode: FrozenReleaseMode): number {
  return Number.parseInt(mode, 8);
}

async function copyEntries(input: {
  sourceRoot: string;
  releaseRoot: string;
  entries: WalmartNewSkuSourceReleaseEntry[];
}): Promise<void> {
  const directories = input.entries
    .filter((entry): entry is WalmartNewSkuReleaseDirectoryEntry =>
      entry.kind === "DIRECTORY")
    .sort((left, right) =>
      left.relative_path.split("/").length - right.relative_path.split("/").length
      || left.relative_path.localeCompare(right.relative_path, "en-US"));
  for (const entry of directories) {
    await mkdir(resolve(input.releaseRoot, entry.relative_path), {
      recursive: true,
      mode: 0o700,
    });
  }
  const files = input.entries.filter(
    (entry): entry is WalmartNewSkuReleaseFileEntry => entry.kind === "FILE",
  );
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < files.length) {
      const entry = files[cursor++]!;
      const sourcePath = resolve(input.sourceRoot, entry.relative_path);
      const targetPath = resolve(input.releaseRoot, entry.relative_path);
      await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
      await chmod(targetPath, modeNumber(entry.mode));
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(COPY_CONCURRENCY, Math.max(1, files.length)) },
      () => worker()),
  );
  const deepestFirst = [...directories].sort((left, right) =>
    right.relative_path.split("/").length - left.relative_path.split("/").length
    || left.relative_path.localeCompare(right.relative_path, "en-US"));
  for (const entry of deepestFirst) {
    await chmod(resolve(input.releaseRoot, entry.relative_path), 0o555);
  }
  await chmod(input.releaseRoot, 0o555);
}

function assertExactIsoTimestamp(value: string): void {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new WalmartNewSkuSourceReleaseError(
      "RELEASE_TIMESTAMP_INVALID",
      value,
    );
  }
}

function totalEntryCount(descriptor: WalmartNewSkuSourceReleaseDescriptor): number {
  return descriptor.source_entries.length
    + descriptor.runtime_dependencies.entries.length;
}

export async function createWalmartNewSkuFrozenRelease(options: {
  sourceRoot: string;
  outputDirectory: string;
  createdAt?: string;
}): Promise<{
  output_directory: string;
  release_root: string;
  manifest_path: string;
  manifest_sha256_path: string;
  manifest_sha256: string;
  engine_release_sha256: string;
  entry_count: number;
  dependency_package_count: number;
  dependency_file_count: number;
  dependency_total_file_bytes: number;
}> {
  if (!isAbsolute(options.outputDirectory)) {
    throw new WalmartNewSkuSourceReleaseError(
      "RELEASE_OUTPUT_MUST_BE_ABSOLUTE",
      options.outputDirectory,
    );
  }
  const sourceRoot = resolve(options.sourceRoot);
  const outputDirectory = resolve(options.outputDirectory);
  const outputFromSource = relative(sourceRoot, outputDirectory);
  if (
    !outputFromSource
    || (!outputFromSource.startsWith(`..${sep}`)
      && outputFromSource !== ".."
      && !isAbsolute(outputFromSource))
  ) {
    throw new WalmartNewSkuSourceReleaseError(
      "RELEASE_OUTPUT_INSIDE_SOURCE_FORBIDDEN",
      "output directory must be outside the source root",
    );
  }
  const source = await inspectWalmartNewSkuSourceRelease(sourceRoot);
  await mkdir(dirname(outputDirectory), { recursive: true, mode: 0o700 });
  try {
    await mkdir(outputDirectory, { mode: 0o700 });
  } catch (error) {
    throw new WalmartNewSkuSourceReleaseError(
      "RELEASE_OUTPUT_EXISTS_OR_UNWRITABLE",
      error instanceof Error ? error.message : String(error),
    );
  }

  const releaseRoot = resolve(outputDirectory, "release");
  await mkdir(releaseRoot, { mode: 0o700 });
  await copyEntries({
    sourceRoot: source.source_root,
    releaseRoot,
    entries: combinedDescriptorEntries(source.descriptor),
  });

  const frozen = await inspectWalmartNewSkuSourceRelease(releaseRoot);
  if (
    frozen.engine_release_sha256 !== source.engine_release_sha256
    || !sourceReleaseDescriptorsEqual(frozen.descriptor, source.descriptor)
  ) {
    throw new WalmartNewSkuSourceReleaseError(
      "RELEASE_COPY_VERIFICATION_FAILED",
      "copied source/dependency release differs from inspected source bytes",
    );
  }

  const createdAt = options.createdAt ?? new Date().toISOString();
  assertExactIsoTimestamp(createdAt);
  const packageLock = source.descriptor.source_entries.find(
    (entry): entry is WalmartNewSkuReleaseFileEntry =>
      entry.kind === "FILE" && entry.relative_path === "package-lock.json",
  );
  if (!packageLock) {
    throw new WalmartNewSkuSourceReleaseError(
      "PACKAGE_LOCK_NOT_IN_RELEASE",
      "package-lock.json is required",
    );
  }
  const manifest: WalmartNewSkuFrozenReleaseManifest = {
    schema_version: WALMART_NEW_SKU_FROZEN_RELEASE_VERSION,
    created_at: createdAt,
    engine_release_sha256: source.engine_release_sha256,
    entry_count: totalEntryCount(source.descriptor),
    package_lock_sha256: packageLock.sha256,
    release_root_relative_path: "release",
    source_root_fingerprint_sha256: sha256(source.source_root),
    source_release: source.descriptor,
    claims: {
      ambient_credential_files_included: false,
      embedded_secret_scan_performed: false,
      application_data_directory_included: false,
      runtime_dependencies_included: true,
      runtime_dependencies_sealed: true,
      operator_contract_file_included: true,
      claude_operator_contract_bootstrap_included: true,
      product_truth_git_release_redefined: false,
      broad_source_boundary: true,
      operator_surface_isolated: false,
      release_root_read_only: true,
      source_directories_read_only: true,
      source_files_read_only: true,
      exact_recursive_topology_enforced: true,
      symlinks_allowed: false,
      special_files_allowed: false,
    },
  };
  const manifestBytes = canonicalWalmartNewSkuFrozenReleaseArtifact(manifest);
  const manifestSha256 = sha256(manifestBytes);
  const manifestPath = resolve(outputDirectory, "release-manifest.json");
  const manifestSha256Path = resolve(outputDirectory, "release-manifest.sha256");
  await writeFile(manifestPath, manifestBytes, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(manifestSha256Path, `${manifestSha256}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await Promise.all([
    chmod(manifestPath, 0o444),
    chmod(manifestSha256Path, 0o444),
  ]);
  return {
    output_directory: outputDirectory,
    release_root: releaseRoot,
    manifest_path: manifestPath,
    manifest_sha256_path: manifestSha256Path,
    manifest_sha256: manifestSha256,
    engine_release_sha256: source.engine_release_sha256,
    entry_count: manifest.entry_count,
    dependency_package_count: source.descriptor.runtime_dependencies.package_count,
    dependency_file_count: source.descriptor.runtime_dependencies.file_count,
    dependency_total_file_bytes:
      source.descriptor.runtime_dependencies.total_file_bytes,
  };
}

function assertDescriptorEntries(
  entries: WalmartNewSkuSourceReleaseEntry[],
  label: string,
): void {
  if (!Array.isArray(entries)) {
    throw new WalmartNewSkuSourceReleaseError(
      "FROZEN_RELEASE_ENTRIES_INVALID",
      label,
    );
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    const relativePath = entry.relative_path;
    assertSafeRelativePath(relativePath);
    if (seen.has(relativePath)) {
      throw new WalmartNewSkuSourceReleaseError(
        "FROZEN_RELEASE_ENTRY_DUPLICATE",
        relativePath,
      );
    }
    seen.add(relativePath);
    if (entry.kind === "DIRECTORY") {
      if (entry.mode !== FROZEN_DIRECTORY_MODE) {
        throw new WalmartNewSkuSourceReleaseError(
          "FROZEN_RELEASE_DIRECTORY_MODE_INVALID",
          relativePath,
        );
      }
    } else if (
      entry.kind !== "FILE"
      || (entry.mode !== FROZEN_REGULAR_FILE_MODE
        && entry.mode !== FROZEN_EXECUTABLE_FILE_MODE)
      || !Number.isSafeInteger(entry.byte_size)
      || entry.byte_size < 0
      || !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new WalmartNewSkuSourceReleaseError(
        "FROZEN_RELEASE_FILE_ENTRY_INVALID",
        relativePath,
      );
    }
  }
  const sorted = [...entries].sort((left, right) =>
    left.relative_path.localeCompare(right.relative_path, "en-US"));
  if (sorted.some((entry, index) =>
    entry.relative_path !== entries[index]?.relative_path)) {
    throw new WalmartNewSkuSourceReleaseError(
      "FROZEN_RELEASE_ENTRIES_UNSORTED",
      label,
    );
  }
}

function assertFrozenReleaseManifest(
  manifest: WalmartNewSkuFrozenReleaseManifest,
): void {
  const dependencies = manifest?.source_release?.runtime_dependencies;
  if (
    !manifest
    || manifest.schema_version !== WALMART_NEW_SKU_FROZEN_RELEASE_VERSION
    || manifest.release_root_relative_path !== "release"
    || manifest.source_release?.schema_version !== WALMART_NEW_SKU_SOURCE_RELEASE_VERSION
    || manifest.source_release.node_runtime?.platform !== process.platform
    || manifest.source_release.node_runtime?.arch !== process.arch
    || JSON.stringify(manifest.source_release.excluded_source_metadata_basenames)
      !== JSON.stringify(WALMART_NEW_SKU_SOURCE_METADATA_EXCLUSIONS)
    || dependencies?.policy_version !== WALMART_NEW_SKU_RUNTIME_DEPENDENCY_POLICY_VERSION
    || JSON.stringify(dependencies.seed_packages)
      !== JSON.stringify(WALMART_NEW_SKU_RUNTIME_DEPENDENCY_SEEDS)
    || JSON.stringify(dependencies.optional_dependency_omissions)
      !== JSON.stringify(WALMART_NEW_SKU_RUNTIME_OPTIONAL_DEPENDENCY_OMISSIONS)
    || dependencies.npm_bin_shims_included !== false
    || dependencies.nested_package_roots_collected_independently !== true
    || dependencies.symlinks_allowed !== false
    || manifest.entry_count !== totalEntryCount(manifest.source_release)
    || manifest.claims?.ambient_credential_files_included !== false
    || manifest.claims.embedded_secret_scan_performed !== false
    || manifest.claims.application_data_directory_included !== false
    || manifest.claims.runtime_dependencies_included !== true
    || manifest.claims.runtime_dependencies_sealed !== true
    || manifest.claims.operator_contract_file_included !== true
    || manifest.claims.claude_operator_contract_bootstrap_included !== true
    || manifest.claims.product_truth_git_release_redefined !== false
    || manifest.claims.broad_source_boundary !== true
    || manifest.claims.operator_surface_isolated !== false
    || manifest.claims.release_root_read_only !== true
    || manifest.claims.source_directories_read_only !== true
    || manifest.claims.source_files_read_only !== true
    || manifest.claims.exact_recursive_topology_enforced !== true
    || manifest.claims.symlinks_allowed !== false
    || manifest.claims.special_files_allowed !== false
  ) {
    throw new WalmartNewSkuSourceReleaseError(
      "FROZEN_RELEASE_MANIFEST_INVALID",
      "manifest contract, runtime binding, or claims are invalid",
    );
  }
  assertExactIsoTimestamp(manifest.created_at);
  assertDescriptorEntries(manifest.source_release.source_entries, "source_entries");
  if (!manifest.source_release.source_entries.some((entry) =>
    entry.relative_path === "AGENTS.md" && entry.kind === "FILE")) {
    throw new WalmartNewSkuSourceReleaseError(
      "FROZEN_RELEASE_OPERATOR_CONTRACT_MISSING",
      "sealed release must include AGENTS.md as the self-contained operator contract",
    );
  }
  if (!manifest.source_release.source_entries.some((entry) =>
    entry.relative_path === "CLAUDE.md" && entry.kind === "FILE")) {
    throw new WalmartNewSkuSourceReleaseError(
      "FROZEN_RELEASE_CLAUDE_BOOTSTRAP_MISSING",
      "sealed release must include CLAUDE.md so Claude Code loads AGENTS.md",
    );
  }
  assertDescriptorEntries(dependencies.entries, "runtime_dependencies.entries");
  if (manifest.source_release.source_entries.some((entry) =>
    entry.relative_path === "node_modules"
    || entry.relative_path.startsWith("node_modules/"))) {
    throw new WalmartNewSkuSourceReleaseError(
      "FROZEN_RELEASE_SOURCE_DEPENDENCY_OVERLAP",
      "source entries cannot contain node_modules",
    );
  }
  if (dependencies.entries.some((entry) =>
    entry.relative_path !== "node_modules"
    && !entry.relative_path.startsWith("node_modules/"))) {
    throw new WalmartNewSkuSourceReleaseError(
      "FROZEN_RELEASE_DEPENDENCY_PATH_INVALID",
      "dependency entries must remain under node_modules",
    );
  }
  const files = dependencies.entries.filter(
    (entry): entry is WalmartNewSkuReleaseFileEntry => entry.kind === "FILE",
  );
  if (
    dependencies.package_count !== dependencies.packages.length
    || dependencies.file_count !== files.length
    || dependencies.total_file_bytes
      !== files.reduce((sum, entry) => sum + entry.byte_size, 0)
  ) {
    throw new WalmartNewSkuSourceReleaseError(
      "FROZEN_RELEASE_DEPENDENCY_COUNTS_INVALID",
      "dependency counts do not match entries",
    );
  }
  const packageRoots = new Set<string>();
  for (const pkg of dependencies.packages) {
    assertSafeRelativePath(pkg.relative_root);
    if (
      !pkg.relative_root.startsWith("node_modules/")
      || packageRoots.has(pkg.relative_root)
      || !/^[a-f0-9]{64}$/.test(pkg.package_json_sha256)
      || !pkg.name
      || !pkg.version
    ) {
      throw new WalmartNewSkuSourceReleaseError(
        "FROZEN_RELEASE_DEPENDENCY_PACKAGE_INVALID",
        pkg.relative_root,
      );
    }
    packageRoots.add(pkg.relative_root);
    const packageJson = dependencies.entries.find(
      (entry): entry is WalmartNewSkuReleaseFileEntry =>
      entry.kind === "FILE"
      && entry.relative_path === `${pkg.relative_root}/package.json`);
    if (!packageJson || packageJson.sha256 !== pkg.package_json_sha256) {
      throw new WalmartNewSkuSourceReleaseError(
        "FROZEN_RELEASE_DEPENDENCY_PACKAGE_JSON_MISMATCH",
        pkg.relative_root,
      );
    }
  }
  const expectedEngineSha = walmartNewSkuSourceReleaseSha256(
    manifest.source_release,
  );
  if (manifest.engine_release_sha256 !== expectedEngineSha) {
    throw new WalmartNewSkuSourceReleaseError(
      "FROZEN_RELEASE_ENGINE_SHA_MISMATCH",
      "manifest engine release digest is invalid",
    );
  }
  const packageLock = manifest.source_release.source_entries.find(
    (entry): entry is WalmartNewSkuReleaseFileEntry =>
      entry.kind === "FILE" && entry.relative_path === "package-lock.json",
  );
  if (!packageLock || packageLock.sha256 !== manifest.package_lock_sha256) {
    throw new WalmartNewSkuSourceReleaseError(
      "FROZEN_RELEASE_PACKAGE_LOCK_MISMATCH",
      "package-lock hash is missing or inconsistent",
    );
  }
}

async function scanExactFrozenTopology(
  releaseRoot: string,
): Promise<WalmartNewSkuSourceReleaseEntry[]> {
  const root = await lstat(releaseRoot).catch(() => null);
  if (!root || root.isSymbolicLink() || !root.isDirectory()) {
    throw new WalmartNewSkuSourceReleaseError(
      "FROZEN_RELEASE_ROOT_INVALID",
      releaseRoot,
    );
  }
  if (exactMode(root.mode) !== FROZEN_DIRECTORY_MODE) {
    throw new WalmartNewSkuSourceReleaseError(
      "FROZEN_RELEASE_ROOT_MODE_DRIFT",
      `${releaseRoot}: ${exactMode(root.mode)}`,
    );
  }
  const entries: WalmartNewSkuSourceReleaseEntry[] = [];
  async function walk(directory: string): Promise<void> {
    const names = await readdir(directory);
    names.sort((left, right) => left.localeCompare(right, "en-US"));
    for (const name of names) {
      const path = resolve(directory, name);
      const relativePath = portableRelativePath(releaseRoot, path);
      const state = await lstat(path);
      if (state.isSymbolicLink()) {
        throw new WalmartNewSkuSourceReleaseError(
          "FROZEN_RELEASE_SYMLINK_FORBIDDEN",
          relativePath,
        );
      }
      if (state.isDirectory()) {
        if (exactMode(state.mode) !== FROZEN_DIRECTORY_MODE) {
          throw new WalmartNewSkuSourceReleaseError(
            "FROZEN_RELEASE_DIRECTORY_MODE_DRIFT",
            `${relativePath}: ${exactMode(state.mode)}`,
          );
        }
        entries.push({
          relative_path: relativePath,
          kind: "DIRECTORY",
          mode: FROZEN_DIRECTORY_MODE,
        });
        await walk(path);
      } else if (state.isFile()) {
        const mode = exactMode(state.mode);
        if (mode !== FROZEN_REGULAR_FILE_MODE
          && mode !== FROZEN_EXECUTABLE_FILE_MODE) {
          throw new WalmartNewSkuSourceReleaseError(
            "FROZEN_RELEASE_FILE_MODE_DRIFT",
            `${relativePath}: ${mode}`,
          );
        }
        entries.push({
          relative_path: relativePath,
          kind: "FILE",
          mode,
          byte_size: state.size,
          sha256: await sha256File(path),
        });
      } else {
        throw new WalmartNewSkuSourceReleaseError(
          "FROZEN_RELEASE_SPECIAL_FILE_FORBIDDEN",
          relativePath,
        );
      }
    }
  }
  await walk(releaseRoot);
  return sortedEntries(entries);
}

async function readSealedArtifact(path: string, maximumBytes: number): Promise<Buffer> {
  const before = await lstat(path).catch(() => null);
  if (
    !before
    || before.isSymbolicLink()
    || !before.isFile()
    || before.nlink !== 1
    || exactMode(before.mode) !== FROZEN_REGULAR_FILE_MODE
    || before.size < 1
    || before.size > maximumBytes
  ) {
    throw new WalmartNewSkuSourceReleaseError(
      "FROZEN_RELEASE_ARTIFACT_UNSAFE",
      path,
    );
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) {
      throw new WalmartNewSkuSourceReleaseError(
        "FROZEN_RELEASE_ARTIFACT_CHANGED",
        path,
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== opened.size || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs) {
      throw new WalmartNewSkuSourceReleaseError(
        "FROZEN_RELEASE_ARTIFACT_CHANGED",
        path,
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function entriesEqual(
  left: WalmartNewSkuSourceReleaseEntry[],
  right: WalmartNewSkuSourceReleaseEntry[],
): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

export async function verifyWalmartNewSkuFrozenRelease(options: {
  releaseRoot: string;
  manifestPath: string;
  manifestSha256Path: string;
  expectedEngineReleaseSha256?: string;
}): Promise<{
  ok: true;
  engine_release_sha256: string;
  manifest_sha256: string;
  entry_count: number;
  dependency_package_count: number;
  dependency_file_count: number;
  dependency_total_file_bytes: number;
}> {
  const [manifestBuffer, sidecarBuffer] = await Promise.all([
    readSealedArtifact(resolve(options.manifestPath), MAX_MANIFEST_BYTES),
    readSealedArtifact(resolve(options.manifestSha256Path), 256),
  ]);
  const manifestBytes = manifestBuffer.toString("utf8");
  const sidecar = sidecarBuffer.toString("utf8");
  const manifestSha256 = sha256(manifestBytes);
  if (sidecar !== `${manifestSha256}\n`) {
    throw new WalmartNewSkuSourceReleaseError(
      "FROZEN_RELEASE_MANIFEST_SHA_MISMATCH",
      "manifest sidecar does not match exact bytes",
    );
  }
  let manifest: WalmartNewSkuFrozenReleaseManifest;
  try {
    manifest = JSON.parse(manifestBytes) as WalmartNewSkuFrozenReleaseManifest;
  } catch {
    throw new WalmartNewSkuSourceReleaseError(
      "FROZEN_RELEASE_MANIFEST_JSON_INVALID",
      "release manifest is not JSON",
    );
  }
  if (canonicalWalmartNewSkuFrozenReleaseArtifact(manifest) !== manifestBytes) {
    throw new WalmartNewSkuSourceReleaseError(
      "FROZEN_RELEASE_MANIFEST_NOT_CANONICAL",
      "release manifest bytes are not canonical",
    );
  }
  assertFrozenReleaseManifest(manifest);
  if (
    options.expectedEngineReleaseSha256
    && options.expectedEngineReleaseSha256 !== manifest.engine_release_sha256
  ) {
    throw new WalmartNewSkuSourceReleaseError(
      "FROZEN_RELEASE_EXPECTED_ENGINE_SHA_MISMATCH",
      "release does not match the caller-pinned engine SHA",
    );
  }

  const exactTopology = await scanExactFrozenTopology(resolve(options.releaseRoot));
  const expectedTopology = combinedDescriptorEntries(manifest.source_release);
  if (!entriesEqual(exactTopology, expectedTopology)) {
    const expectedPaths = new Set(expectedTopology.map((entry) => entry.relative_path));
    const actualPaths = new Set(exactTopology.map((entry) => entry.relative_path));
    const extra = [...actualPaths].filter((path) => !expectedPaths.has(path)).slice(0, 5);
    const missing = [...expectedPaths].filter((path) => !actualPaths.has(path)).slice(0, 5);
    throw new WalmartNewSkuSourceReleaseError(
      "FROZEN_RELEASE_TOPOLOGY_OR_CONTENT_DRIFT",
      `extra=${extra.join(",") || "none"}; missing=${missing.join(",") || "none"}`,
    );
  }

  const current = await inspectWalmartNewSkuSourceRelease(options.releaseRoot);
  if (
    current.engine_release_sha256 !== manifest.engine_release_sha256
    || !sourceReleaseDescriptorsEqual(current.descriptor, manifest.source_release)
  ) {
    throw new WalmartNewSkuSourceReleaseError(
      "FROZEN_RELEASE_CONTENT_DRIFT",
      "release source/dependency graph differs from the sealed manifest",
    );
  }
  return {
    ok: true,
    engine_release_sha256: manifest.engine_release_sha256,
    manifest_sha256: manifestSha256,
    entry_count: manifest.entry_count,
    dependency_package_count: manifest.source_release.runtime_dependencies.package_count,
    dependency_file_count: manifest.source_release.runtime_dependencies.file_count,
    dependency_total_file_bytes:
      manifest.source_release.runtime_dependencies.total_file_bytes,
  };
}
