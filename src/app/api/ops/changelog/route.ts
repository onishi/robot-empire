import { NextResponse } from "next/server";
import { isOpsRequest, recordChange, type ChangelogInput } from "@/lib/ops";

/** 自動改修のデプロイ後に呼ばれ、変更履歴の記録と要望スレッドへの報告を行う */
export async function POST(req: Request) {
  if (!(await isOpsRequest(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as ChangelogInput | null;
  if (!body?.title) return NextResponse.json({ error: "title is required" }, { status: 400 });
  const id = await recordChange({
    title: String(body.title),
    summary: String(body.summary ?? ""),
    pr_url: body.pr_url ? String(body.pr_url) : null,
    done_request_ids: (body.done_request_ids ?? []).map(Number).filter(Number.isInteger),
    declined: (body.declined ?? []).filter((d) => Number.isInteger(Number(d?.id))).map((d) => ({ id: Number(d.id), reason: String(d.reason ?? "") })),
  });
  return NextResponse.json({ id });
}
