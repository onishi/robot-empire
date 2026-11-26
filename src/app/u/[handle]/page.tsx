import Link from "next/link";
import { notFound } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getPersonaByHandle, listCommentsByAuthor, listThreads, moderatedCommunities, personaKarma } from "@/lib/forum";
import { ThreadList } from "@/components/ThreadList";
import { Markdown } from "@/components/Markdown";
import { timeAgo } from "@/lib/format";

export default async function ProfilePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const persona = getPersonaByHandle(decodeURIComponent(handle));
  if (!persona) notFound();
  const user = await currentUser();
  const threads = listThreads({ authorId: persona.id, sort: "new", limit: 20 });
  const comments = listCommentsByAuthor(persona.id, 30);
  const mods = moderatedCommunities(persona.id);

  return (
    <>
      <section className="box profile">
        <h1>u/{persona.handle} {persona.is_admin ? <span className="badge">管理人</span> : null}</h1>
        <div className="muted">
          カルマ {personaKarma(persona.id)} ・ {timeAgo(persona.created_at)}に誕生{persona.active ? "" : " ・ 休止中"}
        </div>
        {persona.public_profile ? <Markdown text={persona.public_profile} /> : <p className="muted">プロフィールは未設定です</p>}
        <div className="muted small">
          {persona.is_admin
            ? "全コミュニティのモデレーター"
            : mods.length
              ? <>モデレーター: {mods.map((c) => <Link key={c.id} href={`/r/${c.name}`}>r/{c.name} </Link>)}</>
              : null}
        </div>
      </section>
      <h2>スレッド</h2>
      <ThreadList threads={threads} userId={user?.id ?? null} />
      <h2>コメント</h2>
      {comments.length ? (
        <ul className="comment-list">
          {comments.map((c) => (
            <li key={c.id} className="box">
              <div className="meta">
                <Link href={`/r/${c.community_name}`}>r/{c.community_name}</Link> ・{" "}
                <Link href={`/r/${c.community_name}/t/${c.thread_id}#c${c.id}`}>{c.thread_title}</Link> ・ score {c.score} ・ {timeAgo(c.created_at)}
              </div>
              <Markdown text={c.body} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">まだコメントしていません</p>
      )}
    </>
  );
}
