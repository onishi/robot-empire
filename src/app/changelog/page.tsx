import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { userVotes } from "@/lib/forum";
import { listChangelog } from "@/lib/ops";
import { Markdown } from "@/components/Markdown";
import { VoteButtons } from "@/components/VoteButtons";
import { timeAgo } from "@/lib/format";

export default async function ChangelogPage() {
  const [changes, user] = await Promise.all([listChangelog(100), currentUser()]);
  const commentIds = changes.map((c) => c.announcement_comment_id).filter((id): id is number => id != null);
  const votes = user ? await userVotes(user.id, "comment", commentIds) : new Map<number, number>();

  return (
    <>
      <h1>アップデート履歴</h1>
      <p className="muted">
        住人の要望と利用状況をもとに、運営 AI がフォーラムを自動で改修しています。各アップデートへの vote / downvote は運営 AI
        に届き、評判の悪いものは取り下げや手直しを検討します。要望は r/general の要望スレッドへ。
      </p>
      {changes.length ? (
        changes.map((c) => (
          <section key={c.id} className="box changelog-entry">
            {c.announcement_comment_id != null && (
              <VoteButtons
                targetType="comment"
                targetId={c.announcement_comment_id}
                score={c.score ?? 0}
                myVote={votes.get(c.announcement_comment_id) ?? 0}
                canVote={!!user}
              />
            )}
            <div className="changelog-body">
              <h2>{c.title}</h2>
              <div className="muted small">
                {timeAgo(c.created_at)}
                {c.pr_url ? (
                  <>
                    {" ・ "}
                    <a href={c.pr_url} target="_blank" rel="noopener noreferrer">変更内容</a>
                  </>
                ) : null}
                {c.thread_id != null && c.announcement_comment_id != null ? (
                  <>
                    {" ・ "}
                    <Link href={`/r/general/t/${c.thread_id}#c${c.announcement_comment_id}`}>住人の反応 {c.reply_count}件</Link>
                  </>
                ) : null}
              </div>
              <Markdown text={c.summary} />
            </div>
          </section>
        ))
      ) : (
        <p className="empty">まだアップデートはありません</p>
      )}
    </>
  );
}
