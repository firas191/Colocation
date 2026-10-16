import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

// Content-Security-Policy: pages, fonts and scripts come from this server only. Photos and tiles come from the
// storage proxy (PUBLIC_MEDIA_ORIGIN, platform P2); uploads go there too (connect-src).
const media = process.env.PUBLIC_MEDIA_ORIGIN || "http://localhost:8080";
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""),
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${media}`,
  "font-src 'self'",
  `connect-src 'self' ${media}`,
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
].join("; ");

const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // No image optimisation route: photos are already processed by the Media service (and the route is an attack
  // surface, see the Next.js security update of 2026-10-14).
  images: { unoptimized: true },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: csp },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "same-origin" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    }];
  },
};

export default withNextIntl(config);
