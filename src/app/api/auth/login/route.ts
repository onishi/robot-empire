import { NextResponse } from "next/server";
import { STATE_COOKIE, googleAuthUrl, randomToken } from "@/lib/auth";

export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const state = randomToken();
  const res = NextResponse.redirect(await googleAuthUrl(origin, state));
  res.cookies.set(STATE_COOKIE, state, { httpOnly: true, secure: origin.startsWith("https"), sameSite: "lax", maxAge: 600, path: "/" });
  return res;
}
