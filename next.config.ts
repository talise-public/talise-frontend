import type { NextConfig } from "next";

const config: NextConfig = {
  // Standalone output for Docker / Railway: bundles only the files the
  // server actually needs into .next/standalone, so the runtime image
  // can drop the full node_modules tree. Cuts the runner image from
  // ~700 MB to ~180 MB.
  output: "standalone",
  experimental: {
    serverActions: { allowedOrigins: ["localhost:3000", "talise.io"] },
    // Rewrite barrel imports from these big icon/UI packages into direct deep
    // imports so webpack only bundles the icons/components actually used —
    // @hugeicons/core-free-icons ships thousands of icons, so this is a large
    // first-load JS win for the app.
    optimizePackageImports: [
      "@hugeicons/core-free-icons",
      "@hugeicons/react",
      "lucide-react",
      "radix-ui",
    ],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
    ],
  },
};

export default config;
