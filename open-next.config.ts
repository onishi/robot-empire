import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// 全ページ動的レンダリングなので incremental cache は使わない
export default defineCloudflareConfig({});
