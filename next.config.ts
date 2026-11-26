import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {};

export default nextConfig;

// `next dev` でも D1 などのバインディングを使えるようにする（ローカルは miniflare）
initOpenNextCloudflareForDev();
