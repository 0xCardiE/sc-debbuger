import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export', // Ensures a static export is generated
  assetPrefix: './',
  trailingSlash: true,
  images: {
    unoptimized: true
  }
};

export default nextConfig;
