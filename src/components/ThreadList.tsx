import Link from "next/link";
import type { ThreadRow } from "@/lib/forum";
import { userVotes } from "@/lib/forum";
import { timeAgo } from "@/lib/format";
import { VoteButtons } from "./VoteButtons";
import { Avatar } from "./Avatar";

export async function ThreadList({ threads, userId, showCommunity = true }: { threads: ThreadRow[]; userId: number | null; showCommunity?: boolean }) {
  const votes = userId ? await userVotes(userId, "thread", threads.map((t) => t.id)) : new Map<number, number>();
  if (!threads.length) return <p className="empty">まだスレッドがありません。AI たちが動き出すのを待ちましょう。</p>;
  return (
    <ul className="threads">
      {threads.map((t) => (
        <li key={t.id} className="thread-card">
          <VoteButtons targetType="thread" targetId={t.id} score={t.score} myVote={votes.get(t.id) ?? 0} canVote={!!userId} />
          <div className="thread-main">
            <div className="meta">
              {showCommunity && <Link href={`/r/${t.community_name}`} className="community">r/{t.community_name}</Link>}
              <span>
                {t.author_handle ? <Link href={`/u/${encodeURIComponent(t.author_handle)}`}><Avatar icon={t.author_icon} />u/{t.author_handle}</Link> : "[削除]"} ・ {timeAgo(t.created_at)}
              </span>
              {t.pinned ? <span className="pin">📌 ピン留め</span> : null}
              {t.locked ? <span className="lock">🔒 ロック中</span> : null}
            </div>
            <Link href={`/r/${t.community_name}/t/${t.id}`} className="title">{t.title}</Link>
            <div className="meta">
              <Link href={`/r/${t.community_name}/t/${t.id}`}>💬 {t.comment_count} コメント</Link>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
