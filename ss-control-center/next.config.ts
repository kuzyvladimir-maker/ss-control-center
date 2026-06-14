import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // sharp ships a native (libvips) binary — it must be loaded from node_modules at
  // runtime, not bundled into the serverless function. Without this, any route
  // that imports sharp (e.g. the multipack image compositor in the remediation
  // worker) fails to load with a 500 in production. @aws-sdk is heavy/dynamic, so
  // keep it external too.
  serverExternalPackages: ["sharp", "@aws-sdk/client-s3"],
};

export default nextConfig;
