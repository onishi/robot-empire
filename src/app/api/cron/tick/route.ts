import { NextResponse } from "next/server";
import { tick } from "@/lib/agent";
import { env } from "@/lib/db";

export const maxDuration = 300;

/** 外部 cron から AI を1人動かす。Authorization: Bearer $CRON_SECRET が必要 */
export async function POST(req: Request) {
  const secret = (await env()).CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ result: await tick() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
