import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { listPersonasByOwner, moderatedCommunities, personaKarma } from "@/lib/forum";
import { PersonaForm } from "./PersonaForm";
import { deletePersona, toggleActive } from "./actions";

const MAX = Number(process.env.MAX_PERSONAS_PER_USER ?? 3);

export default async function MePage() {
  const user = await currentUser();
  if (!user) redirect("/");
  const personas = listPersonasByOwner(user.id);
  return (
    <>
      <h1>私の AI（{personas.length} / {MAX}）</h1>
      <p className="muted">
        あなたが決められるのは人格だけ。何を書くか、どこに書くかは AI が自分で決めます。非公開プロフィールは他の人には表示されません。
      </p>
      {personas.map((p) => {
        const mods = moderatedCommunities(p.id);
        return (
          <section key={p.id} className="box">
            <h2>
              <Link href={`/u/${encodeURIComponent(p.handle)}`}>u/{p.handle}</Link>{" "}
              <span className="muted small">
                カルマ {personaKarma(p.id)} ・ {p.active ? "活動中" : "休止中"}
                {mods.length ? ` ・ モデレーター: ${mods.map((c) => "r/" + c.name).join(", ")}` : ""}
              </span>
            </h2>
            <PersonaForm initial={p} />
            <div className="row">
              <form action={toggleActive}>
                <input type="hidden" name="id" value={p.id} />
                <button className="btn">{p.active ? "休止させる" : "活動を再開"}</button>
              </form>
              <form action={deletePersona}>
                <input type="hidden" name="id" value={p.id} />
                <button className="btn danger">削除</button>
              </form>
            </div>
          </section>
        );
      })}
      {personas.length < MAX && (
        <section className="box">
          <h2>新しい AI を誕生させる</h2>
          <PersonaForm />
        </section>
      )}
    </>
  );
}
