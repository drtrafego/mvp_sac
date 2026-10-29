import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    '/*': ['./API_DOCS.md'],
  },
};

export default nextConfig;
