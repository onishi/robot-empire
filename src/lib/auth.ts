/**
 * Google OAuth（Authorization Code フロー）と署名付きセッション Cookie。
 * Workers で動くよう Web Crypto と fetch だけで実装している。
 */
import { cookies } from "next/headers";
import { env, first } from "./db";

export const SESSION_COOKIE = "re_session";
export const STATE_COOKIE = "re_oauth_state";
const SESSION_DAYS = 30;

export type SessionUser = { id: number; name: string | null; email: string; image: string | null };

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey() {
  const secret = (await env()).SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET が設定されていません");
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign(payload: object): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

async function verify<T>(token: string | undefined): Promise<T | null> {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(), fromB64url(sig), enc.encode(body));
  if (!ok) return null;
  const data = JSON.parse(new TextDecoder().decode(fromB64url(body))) as T & { exp: number };
  return data.exp > Date.now() ? data : null;
}

export function randomToken() {
  return b64url(crypto.getRandomValues(new Uint8Array(24)));
}

export async function createSession(user: SessionUser) {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  return { value: await sign({ ...user, exp }), maxAge: SESSION_DAYS * 86400 };
}

export async function currentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return verify<SessionUser>(token);
}

// ---------------------------------------------------------------- Google

export async function googleAuthUrl(origin: string, state: string) {
  const e = await env();
  const params = new URLSearchParams({
    client_id: e.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/api/auth/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeGoogleCode(origin: string, code: string): Promise<SessionUser> {
  const e = await env();
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: e.GOOGLE_CLIENT_ID,
      client_secret: e.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${origin}/api/auth/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${access_token}` },
  });
  if (!infoRes.ok) throw new Error(`userinfo failed: ${infoRes.status}`);
  const info = (await infoRes.json()) as { email?: string; email_verified?: boolean; name?: string; picture?: string };
  if (!info.email || info.email_verified === false) throw new Error("メールアドレスが確認できません");

  const row = await first<{ id: number }>(
    `INSERT INTO users (email, name, image) VALUES (?, ?, ?)
     ON CONFLICT (email) DO UPDATE SET name = excluded.name, image = excluded.image
     RETURNING id`,
    info.email,
    info.name ?? null,
    info.picture ?? null,
  );
  return { id: row!.id, email: info.email, name: info.name ?? null, image: info.picture ?? null };
}
