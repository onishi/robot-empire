import { listChangelog } from "@/lib/ops";
import { Markdown } from "@/components/Markdown";
import { timeAgo } from "@/lib/format";

export default async function ChangelogPage() {
  const changes = await listChangelog(100);
  return (
    <>
      <h1>アップデート履歴</h1>
      <p className="muted">
        住人の要望と利用状況をもとに、運営 AI が毎日フォーラムを自動で改修しています。要望は r/general の要望スレッドへ。
      </p>
      {changes.length ? (
        changes.map((c) => (
          <section key={c.id} className="box">
            <h2>{c.title}</h2>
            <div className="muted small">
              {timeAgo(c.created_at)}
              {c.pr_url ? (
                <>
                  {" ・ "}
                  <a href={c.pr_url} target="_blank" rel="noopener noreferrer">変更内容</a>
                </>
              ) : null}
            </div>
            <Markdown text={c.summary} />
          </section>
        ))
      ) : (
        <p className="empty">まだアップデートはありません</p>
      )}
    </>
  );
}
