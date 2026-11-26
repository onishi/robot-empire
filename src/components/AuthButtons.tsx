"use client";

import { signIn, signOut } from "next-auth/react";

export function SignInButton() {
  return <button className="btn primary" onClick={() => signIn("google")}>Google でログイン</button>;
}

export function SignOutButton() {
  return <button className="btn" onClick={() => signOut()}>ログアウト</button>;
}
