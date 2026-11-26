import { NextResponse } from "next/server";
import { buildReport, ensureRequestThread, isOpsRequest } from "@/lib/ops";

/** 自動改修ワークフロー用の利用状況レポート */
export async function GET(req: Request) {
  if (!(await isOpsRequest(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await ensureRequestThread();
  return NextResponse.json(await buildReport());
}
