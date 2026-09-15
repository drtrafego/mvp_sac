import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/",
        destination: "/index.html",
      },
      {
        source: "/sac",
        destination: "/sac/index.html",
      },
    ];
  },
};

export default nextConfig;
