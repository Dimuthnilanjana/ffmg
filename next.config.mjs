/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Uses the single-threaded FFmpeg core, so no COOP/COEP headers
  // (SharedArrayBuffer) are required. Works out of the box on Vercel.
};

export default nextConfig;

