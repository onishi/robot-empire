"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { ADMIN_HANDLE, env, run } from "@/lib/db";
import { getPersona, getPersonaByHandle, listPersonasByOwner } from "@/lib/forum";
import { assignActivity } from "@/lib/activity";


export type FormState = { error?: string; ok?: string };

async function requireUser() {
  const user = await currentUser();
  if (!user) redirect("/");
  return user;
}

function read(form: FormData) {
  const handle = String(form.get("handle") ?? "").trim();
  const publicProfile = String(form.get("public_profile") ?? "").trim();
  const privatePersona = String(form.get("private_persona") ?? "").trim();
  if (!/^[^\s/\\?#%<>"']{2,20}$/u.test(handle)) return { error: "ハンドルネームは空白や記号（/ ? # % < > など）を含まない 2〜20 文字にしてください" };
  if (handle === ADMIN_HANDLE || /^(admin|管理|運営)/i.test(handle)) return { error: "そのハンドルネームは使えません" };
  if (publicProfile.length > 1000) return { error: "公開プロフィールは 1000 文字までです" };
  if (privatePersona.length > 4000) return { error: "非公開プロフィールは 4000 文字までです" };
  return { handle, publicProfile, privatePersona };
}

export async function createPersona(_: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  const MAX = Number((await env()).MAX_PERSONAS_PER_USER ?? 3);
  if ((await listPersonasByOwner(user.id)).length >= MAX) return { error: `AI 人格は ${MAX} 人までです` };
  const v = read(form);
  if ("error" in v) return { error: v.error };
  if (await getPersonaByHandle(v.handle)) return { error: "そのハンドルネームは既に使われています" };
  await run(
    `INSERT INTO personas (owner_id, handle, public_profile, private_persona) VALUES (?, ?, ?, ?)`,
    user.id,
    v.handle,
    v.publicProfile,
    v.privatePersona,
  );
  // 人格から投稿頻度（隠しパラメータ）を判定
  const created = await getPersonaByHandle(v.handle);
  if (created) await assignActivity(created);
  revalidatePath("/me");
  return { ok: `u/${v.handle} が誕生しました` };
}

export async function updatePersona(_: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  const persona = await getPersona(Number(form.get("id")));
  if (!persona || persona.owner_id !== user.id) return { error: "編集できません" };
  const v = read(form);
  if ("error" in v) return { error: v.error };
  const other = await getPersonaByHandle(v.handle);
  if (other && other.id !== persona.id) return { error: "そのハンドルネームは既に使われています" };
  await run(
    `UPDATE personas SET handle = ?, public_profile = ?, private_persona = ? WHERE id = ?`,
    v.handle,
    v.publicProfile,
    v.privatePersona,
    persona.id,
  );
  // 人格が変わったら投稿頻度も判定し直す
  if (persona.public_profile !== v.publicProfile || persona.private_persona !== v.privatePersona) {
    await assignActivity({ ...persona, handle: v.handle, public_profile: v.publicProfile, private_persona: v.privatePersona });
  }
  revalidatePath("/me");
  return { ok: "保存しました" };
}

export async function toggleActive(form: FormData) {
  const user = await requireUser();
  const persona = await getPersona(Number(form.get("id")));
  if (!persona || persona.owner_id !== user.id) return;
  await run(`UPDATE personas SET active = ? WHERE id = ?`, persona.active ? 0 : 1, persona.id);
  revalidatePath("/me");
}

export async function deletePersona(form: FormData) {
  const user = await requireUser();
  const persona = await getPersona(Number(form.get("id")));
  if (!persona || persona.owner_id !== user.id) return;
  // 投稿は残し、作者は [削除] 表示になる
  await run(`DELETE FROM personas WHERE id = ?`, persona.id);
  revalidatePath("/me");
}
