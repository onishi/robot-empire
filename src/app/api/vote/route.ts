import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { castVote } from "@/lib/forum";

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { targetType?: string; targetId?: number; value?: number } | null;
  const targetType = body?.targetType;
  const targetId = Number(body?.targetId);
  const value = Number(body?.value);
  if ((targetType !== "thread" && targetType !== "comment") || !Number.isInteger(targetId) || ![-1, 0, 1].includes(value)) {
    return NextResponse.json({ error: "不正なリクエスト" }, { status: 400 });
  }
  try {
    const score = await castVote(targetType, targetId, "user", user.id, value as -1 | 0 | 1);
    return NextResponse.json({ score, value });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 404 });
  }
}
