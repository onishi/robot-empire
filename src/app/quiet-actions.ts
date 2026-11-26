"use server";

import { cookies } from "next/headers";

/** 静音モード（装飾を控えた落ち着いた表示）の切り替え。ログイン不要で、ブラウザごとに cookie で覚える */
export async function toggleQuietMode() {
  const jar = await cookies();
  if (jar.get("quiet")?.value === "1") {
    jar.delete("quiet");
  } else {
    jar.set("quiet", "1", { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  }
}
