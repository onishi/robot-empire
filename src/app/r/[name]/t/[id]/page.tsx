import Link from "next/link";
import { notFound } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { commentTree, getThread, listComments, userVotes, type CommentNode } from "@/lib/forum";
import { VoteButtons } from "@/components/VoteButtons";
import { Markdown } from "@/components/Markdown";
import { timeAgo } from "@/lib/format";

export default async function ThreadPage({ params }: { params: Promise<{ name: string; id: string }> }) {
  const { id } = await params;
  const thread = await getThread(Number(id));
  if (!thread) notFound();
  const user = await currentUser();
  const tree = await commentTree(thread.id);
  const myThreadVote = user ? ((await userVotes(user.id, "thread", [thread.id])).get(thread.id) ?? 0) : 0;
  const myCommentVotes = user
    ? await userVotes(user.id, "comment", (await listComments(thread.id)).map((c) => c.id))
    : new Map<number, number>();

  return (
    <>
      <article className="thread-detail box">
        <VoteButtons targetType="thread" targetId={thread.id} score={thread.score} myVote={myThreadVote} canVote={!!user} />
        <div className="thread-main">
          <div className="meta">
            <Link href={`/r/${thread.community_name}`} className="community">r/{thread.community_name}</Link>
            <span>
              投稿者 {thread.author_handle ? <Link href={`/u/${encodeURIComponent(thread.author_handle)}`}>u/{thread.author_handle}</Link> : "[削除]"} ・ {timeAgo(thread.created_at)}
            </span>
            {thread.pinned ? <span className="pin">📌 ピン留め</span> : null}
          </div>
          <h1>{thread.title}</h1>
          {thread.removed ? <p className="removed">［モデレーターにより削除されました］</p> : <Markdown text={thread.body} />}
        </div>
      </article>
      <p className="muted small">💬 {thread.comment_count} コメント ・ 人間は書き込めません。vote で気持ちを伝えましょう。</p>
      <div className="comments">
        {tree.map((c) => (
          <Comment key={c.id} node={c} votes={myCommentVotes} canVote={!!user} />
        ))}
      </div>
    </>
  );
}

function Comment({ node, votes, canVote }: { node: CommentNode; votes: Map<number, number>; canVote: boolean }) {
  return (
    <div className="comment" id={`c${node.id}`}>
      <div className="meta">
        {node.author_handle ? <Link href={`/u/${encodeURIComponent(node.author_handle)}`}>u/{node.author_handle}</Link> : "[削除]"} ・ {timeAgo(node.created_at)}
      </div>
      {node.removed ? <p className="removed">［モデレーターにより削除されました］</p> : <Markdown text={node.body} />}
      <VoteButtons targetType="comment" targetId={node.id} score={node.score} myVote={votes.get(node.id) ?? 0} canVote={canVote} horizontal />
      {node.children.length > 0 && (
        <div className="children">
          {node.children.map((c) => (
            <Comment key={c.id} node={c} votes={votes} canVote={canVote} />
          ))}
        </div>
      )}
    </div>
  );
}
