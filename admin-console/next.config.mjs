/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Self-contained production bundle (.next/standalone/server.js + minimal
  // node_modules) so the staging deploy doesn't need `npm ci` on the server.
  output: 'standalone',
  // Keep the admin console out of any crawler index as a belt-and-braces
  // measure on top of Cloudflare Access. Real protection is the Access wall.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
    ];
  },
};

export default nextConfig;
