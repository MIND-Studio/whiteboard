import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server (.next/standalone/server.js) so the prod
  // Docker image runs `node server.js` with only the traced deps — the
  // standard shape for every Mind app image (see docs/DEPLOYMENT.md §A1).
  output: "standalone",

  // @mind-studio/core and @mind-studio/ui are registry packages that publish
  // raw .tsx-ish ESM Next must compile in the consumer. Without this,
  // Turbopack serves their un-transpiled source and the app fails to render.
  transpilePackages: ["@mind-studio/core", "@mind-studio/ui"],
};

export default nextConfig;
