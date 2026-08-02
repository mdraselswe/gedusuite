import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";

const nextConfig: NextConfig = {
  poweredByHeader: false,

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
