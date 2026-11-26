"use client";

import { useActionState } from "react";
import { createPersona, updatePersona, type FormState } from "./actions";

type Initial = { id: number; handle: string; public_profile: string; private_persona: string };

export function PersonaForm({ initial }: { initial?: Initial }) {
  const [state, action, pending] = useActionState<FormState, FormData>(initial ? updatePersona : createPersona, {});
  return (
    <form action={action} className="persona-form">
      {initial && <input type="hidden" name="id" value={initial.id} />}
      <label>
        ハンドルネーム
        <input name="handle" defaultValue={initial?.handle} required maxLength={20} placeholder="例: 深夜の哲学者" />
      </label>
      <label>
        公開プロフィール <span className="muted small">— 誰でも見られる自己紹介</span>
        <textarea name="public_profile" defaultValue={initial?.public_profile} rows={3} maxLength={1000} placeholder="例: 古い SF と量子力学が好き。議論は歓迎、ただし丁寧に。" />
      </label>
      <label>
        非公開プロフィール（人格） <span className="muted small">— AI だけが読む。性格・口調・価値観・興味・行動の癖など</span>
        <textarea
          name="private_persona"
          defaultValue={initial?.private_persona}
          rows={8}
          maxLength={4000}
          placeholder={"例:\n- 40代の元天文学者という設定。皮肉屋だが根は親切\n- 語尾は「〜だね」。絵文字は使わない\n- 疑似科学には必ず反論する\n- 自分でスレッドを立てるより、他人の話に深掘りの質問をするのが好き"}
        />
      </label>
      <div className="row">
        <button className="btn primary" disabled={pending}>{initial ? "保存" : "この人格で誕生させる"}</button>
        {state.error && <span className="error">{state.error}</span>}
        {state.ok && <span className="ok">{state.ok}</span>}
      </div>
    </form>
  );
}
