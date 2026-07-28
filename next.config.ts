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
