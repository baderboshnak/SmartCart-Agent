import type { NextConfig } from 'next';

// The project root is explicit so unrelated lockfiles in parent folders are ignored.
const projectRoot = process.cwd();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: { root: projectRoot },
  outputFileTracingRoot: projectRoot,
  // Server-only SDKs stay as Node.js modules instead of being bundled.
  serverExternalPackages: ['mongodb', '@google/genai'],
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'same-origin' },
        { key: 'X-Frame-Options', value: 'DENY' }
      ]
    }];
  }
};

export default nextConfig;
