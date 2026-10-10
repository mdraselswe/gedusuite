import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";

// Security headers. The CSP is report-only on purpose: it lists what an
// enforced policy would block (see /api/csp-report) without blocking anything.
// Promote it to `Content-Security-Policy` once the reports have gone quiet.
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy-Report-Only",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob: https:",
      "connect-src 'self' https://accounts.google.com",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self' https://accounts.google.com",
      "report-uri /api/csp-report",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,

  // src/lib/prisma.ts can choose the plain `pg` driver (local development and
  // tests), and one client component reaches it through lib/spending. That
  // path is dead in the browser; give the browser an empty module for it
  // rather than let webpack try to bundle a Postgres driver.
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve = config.resolve ?? {};
      config.resolve.alias = {
        ...(config.resolve.alias ?? {}),
        "@prisma/adapter-pg": false,
        pg: false,
      };
    }
    return config;
  },

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },

  // ws (used by Neon's serverless driver) probes for optional native addons at
  // require time. Bundling it breaks that lookup and the socket dies mid-query
  // with "TypeError: b.mask is not a function" — passes the build, fails on the
  // first write. Leave it to be required from node_modules at runtime.
  serverExternalPackages: ["ws"],

  experimental: {
    // Barrel-file libraries: pull in only the modules actually referenced
    // instead of the whole package graph. Next does this for lucide-react out
    // of the box; recharts (dashboard + reports) and @base-ui/react are the
    // other two heavy ones here.
    optimizePackageImports: ["recharts", "@base-ui/react"],

    // Client-side Router Cache lifetime. The default (dynamic: 0) refetches
    // the RSC payload on *every* navigation, so going back to a page you were
    // just on pays the full DB round trip again. 30s is safe here because
    // every mutation in this app calls router.refresh(), which clears the
    // Router Cache outright — the stale window only ever applies to reads.
    // Lower it if cross-user freshness starts mattering more than snappiness.
    staleTimes: { dynamic: 30, static: 180 },
  },

  compiler: {
    // Strip stray console.log from the production client bundle, but keep
    // error/warn so real failures still surface in the browser console.
    removeConsole:
      process.env.NODE_ENV === "production" ? { exclude: ["error", "warn"] } : false,
  },
};

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  // Disable the SW in dev so hot-reload isn't fighting a cached shell.
  disable: process.env.NODE_ENV === "development",
});

export default withSerwist(nextConfig);
