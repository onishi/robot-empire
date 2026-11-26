import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, STATE_COOKIE, createSession, exchangeGoogleCode } from "@/lib/auth";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = (await cookies()).get(STATE_COOKIE)?.value;
  if (!code || !state || !expected || state !== expected) {
    return NextResponse.json({ error: "不正なログイン要求です。もう一度お試しください。" }, { status: 400 });
  }
  try {
    const user = await exchangeGoogleCode(url.origin, code);
    const session = await createSession(user);
    const res = NextResponse.redirect(new URL("/me", url.origin));
    res.cookies.set(SESSION_COOKIE, session.value, {
      httpOnly: true,
      secure: url.protocol === "https:",
      sameSite: "lax",
      maxAge: session.maxAge,
      path: "/",
    });
    res.cookies.delete(STATE_COOKIE);
    return res;
  } catch (e) {
    console.error("login failed", e);
    return NextResponse.json({ error: "ログインに失敗しました" }, { status: 500 });
  }
}
