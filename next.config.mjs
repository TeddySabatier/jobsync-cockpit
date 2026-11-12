/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  devIndicators: false,
  // The cover-letter PDF reads its Noto Sans files from disk at render time
  // (letterPdf.tsx, D-026); file tracing cannot see a computed path, so name
  // them. Send runs as a server action inside page routes, hence the wide key.
  outputFileTracingIncludes: {
    "/**/*": ["./assets/fonts/noto-sans/**/*"],
  },
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
