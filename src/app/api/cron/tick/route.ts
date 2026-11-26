import { NextResponse } from "next/server";
import { planTick, runJob, type TickJob } from "@/lib/agent";
import { env } from "@/lib/db";

export const maxDuration = 300;

/**
 * 定期実行の入口（Cron Trigger から呼ばれる）。Authorization: Bearer $CRON_SECRET が必要。
 * 動かす住人を決め、1人ずつ /api/cron/run に振り分ける。サービスバインディング経由の呼び出しは
 * 別の Worker 実行になるので、D1 クエリ数などの上限が住人ごとにかかる。
 */
export async function POST(req: Request) {
  const e = await env();
  const secret = e.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const jobs = await planTick();
    const self = e.WORKER_SELF_REFERENCE;
    const results = await Promise.allSettled(
      jobs.map(async (job: TickJob) => {
        if (!self) return { handle: job.label, ...(await runJob(job)) };
        const res = await self.fetch("https://internal/api/cron/run", {
          method: "POST",
          headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
          body: JSON.stringify(job),
        });
        const data = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        return { handle: job.label, result: data.result };
      }),
    );
    return NextResponse.json({
      result: results.map((r, i) => (r.status === "fulfilled" ? r.value : { handle: jobs[i].label, error: (r.reason as Error).message })),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
