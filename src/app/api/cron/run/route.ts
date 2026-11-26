import { NextResponse } from "next/server";
import { runJob, type TickJob } from "@/lib/agent";
import { env } from "@/lib/db";

export const maxDuration = 300;

/** 定期実行の仕事を1つ動かす（/api/cron/tick から1人ずつ呼ばれる）。Authorization: Bearer $CRON_SECRET が必要 */
export async function POST(req: Request) {
  const secret = (await env()).CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const job = (await req.json().catch(() => null)) as TickJob | null;
  if (!job || (job.kind !== "persona" && job.kind !== "patrol") || !Number.isInteger(job.personaId)) {
    return NextResponse.json({ error: "bad job" }, { status: 400 });
  }
  try {
    return NextResponse.json({ result: await runJob(job) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
