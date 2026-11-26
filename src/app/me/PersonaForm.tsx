"use client";

import { useActionState } from "react";
import { createPersona, updatePersona, type FormState } from "./actions";

/** サーバー側（actions.ts）と同じ条件。ブラウザで送信前にチェックする */
const HANDLE_PATTERN = "[^\\s\\/\\\\?#%<>\"']{2,20}";

type Initial = { id: number; handle: string; icon: string | null; public_profile: string; private_persona: string };

export function PersonaForm({ initial }: { initial?: Initial }) {
  const [state, action, pending] = useActionState<FormState, FormData>(initial ? updatePersona : createPersona, {});
  // エラーのときは送った内容を入れ直す（送信後にフォームが初期値に戻るため）
  const v = state.values;
  return (
    <form action={action} className="persona-form">
      {initial && <input type="hidden" name="id" value={initial.id} />}
      <div className="form-pair">
      <label>
        ハンドルネーム
        <input
          name="handle"
          defaultValue={v?.handle ?? initial?.handle}
          required
          minLength={2}
          maxLength={20}
          pattern={HANDLE_PATTERN}
          title={"空白や記号（/ ? # % < > \" ' \\）を含まない 2〜20 文字"}
          placeholder="例: 深夜の哲学者"
        />
        <span className="muted small hint">2〜20 文字。空白と記号（/ ? # % &lt; &gt; &quot; &apos; \）は使えません。「・」「ー」などは使えます</span>
      </label>
      <label>
        アイコン <span className="muted small">— 絵文字1文字。空欄なら AI が選びます</span>
        <input name="icon" defaultValue={v?.icon ?? initial?.icon ?? ""} className="icon-input" placeholder="🦊" autoComplete="off" />
      </label>
      </div>
      <label>
        公開プロフィール <span className="muted small">— 誰でも見られる自己紹介</span>
        <textarea name="public_profile" defaultValue={v?.public_profile ?? initial?.public_profile} rows={4} maxLength={1000} placeholder="例: 古い SF と量子力学が好き。議論は歓迎、ただし丁寧に。" />
      </label>
      <label>
        非公開プロフィール（人格） <span className="muted small">— AI だけが読む。性格・口調・価値観・興味・行動の癖など</span>
        <textarea
          name="private_persona"
          defaultValue={v?.private_persona ?? initial?.private_persona}
          rows={14}
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
