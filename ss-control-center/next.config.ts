import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // sharp ships a native libvips binary. It's an external package (loaded from
  // node_modules at runtime, not bundled), but Next's file tracing leaves the
  // sibling libvips .so out of the serverless function — so the remediation
  // worker 500'd with ERR_DLOPEN_FAILED (libvips-cpp.so missing). Explicitly
  // trace the linux-x64 sharp + libvips binaries into that function's bundle.
  serverExternalPackages: ["sharp", "@aws-sdk/client-s3"],
  outputFileTracingIncludes: {
    "/api/cron/walmart-remediation-worker": [
      "./node_modules/@img/sharp-linux-x64/**/*",
      "./node_modules/@img/sharp-libvips-linux-x64/**/*",
    ],
    // libsql resolves its native binding by platform string at runtime, so a
    // build traced on macOS ships only darwin binaries and every Turso-backed
    // API route 500s on Vercel ("Cannot find module '@libsql/linux-arm64-gnu'").
    // Same class as the sharp/libvips gotcha above. The patterns are no-ops
    // when a platform package is absent locally.
    "*": [
      "./node_modules/@libsql/linux-arm64-gnu/**/*",
      "./node_modules/@libsql/linux-x64-gnu/**/*",
      // sharp resolves its native binding by platform at runtime as well, and
      // Vercel runs arm64 here — a macOS-traced build shipped only darwin and
      // x64, so every image-touching route 500'd.
      "./node_modules/@img/sharp-linux-arm64/**/*",
      "./node_modules/@img/sharp-libvips-linux-arm64/**/*",
    ],
  },
  // The repo carries ~3.6GB of local audit/evidence artifacts under data/.
  // listing-integrity-shadow.server reads them via process.cwd() paths, which
  // makes Next's file tracing pull the entire tree into the walmart-growth
  // function (2.23GB > the 250MB limit) and fail every production deploy.
  // These artifacts are operator-local; serverless reads fall back gracefully.
  outputFileTracingExcludes: {
    "*": ["./data/**"],
  },
};

export default nextConfig;
