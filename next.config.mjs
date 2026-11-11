/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  devIndicators: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      // Appended after the global rule: Next applies the last matching entry
      // per header key, so the CV (files) and cover-letter (D-015) PDF routes
      // may be framed by our own pages.
      {
        source: "/api/cockpit/:kind(files|letter)/:packageId",
        headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }],
      },
    ];
  },
};

export default nextConfig;
