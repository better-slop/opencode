import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  serverExternalPackages: ["typescript", "twoslash"],
  async redirects() {
    return [
      {
        source: "/docs",
        destination: "/docs/ocx/introduction",
        permanent: false,
      },
      {
        source: "/docs/ocx",
        destination: "/docs/ocx/introduction",
        permanent: false,
      },
      {
        source: "/docs/registries",
        destination: "/docs/registries/introduction",
        permanent: false,
      },
    ];
  },
};

export default withMDX(config);

initOpenNextCloudflareForDev();
