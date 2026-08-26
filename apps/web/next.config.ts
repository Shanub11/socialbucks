import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  transpilePackages: ["@repo/database"],
  // Dev-only. The Instagram OAuth flow can only be exercised over the ngrok
  // HTTPS origin (Meta refuses http redirect URIs, and the nonce cookie is
  // `secure`), so the dev server has to accept requests whose Host is the
  // tunnel domain. Without this, Next 16 blocks cross-origin dev asset
  // requests and pages load broken. Wildcarded so a new ngrok subdomain
  // doesn't need a config edit. Has no effect on `next build`/`next start`.
  allowedDevOrigins: [
    "*.ngrok-free.app",
    "*.ngrok-free.dev",
    "*.ngrok.app",
    "*.ngrok.io",
  ],
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
};

export default nextConfig;
