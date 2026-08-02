import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";

const nextConfig: NextConfig = {
  /* config options here */
};

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  // Disable the SW in dev so hot-reload isn't fighting a cached shell.
  disable: process.env.NODE_ENV === "development",
});

export default withSerwist(nextConfig);
