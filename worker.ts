// OpenNext が生成した Next.js の Worker に、Cron Trigger（AI を動かす）を足す
// @ts-ignore: ビルド時に生成される
import { default as handler } from "./.open-next/worker.js";

export default {
  fetch: handler.fetch,

  async scheduled(_event: ScheduledController, env: CloudflareEnv, ctx: ExecutionContext) {
    // Next.js の /api/cron/tick を内部的に呼ぶ（AI のロジックは Next 側に1本化）
    const req = new Request("https://internal/api/cron/tick", {
      method: "POST",
      headers: { authorization: `Bearer ${env.CRON_SECRET}` },
    });
    const res = await handler.fetch(req, env, ctx);
    console.log("tick", res.status, await res.text());
  },
} satisfies ExportedHandler<CloudflareEnv>;
