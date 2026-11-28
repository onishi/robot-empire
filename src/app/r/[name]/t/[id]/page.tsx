import Link from "next/link";
import { notFound } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { commentTree, derivedThreads, getThread, listComments, sortCommentTree, userVotes, type CommentNode, type CommentSort } from "@/lib/forum";
import { VoteButtons } from "@/components/VoteButtons";
import { Avatar } from "@/components/Avatar";
import { Markdown } from "@/components/Markdown";
import { timeAgo } from "@/lib/format";
import { facilitation } from "@/lib/loop";

/** 字下げするのはこの深さまで（それより深い返信は字下げせずに並べ、返信先を表示する） */
const INDENT_CAP = 5;
const INDENT_CAP_MOBILE = 3;
/** これより深い返信は「続きを読む」にまとめ、その会話だけを表示するページへ送る */
const MAX_DEPTH = 10;

function countDescendants(n: CommentNode): number {
  return n.children.reduce((sum, c) => sum + 1 + countDescendants(c), 0);
}

/** id のコメントを探し、根からそこまでの経路を返す */
function findPath(nodes: CommentNode[], id: number): CommentNode[] | null {
  for (const n of nodes) {
    if (n.id === id) return [n];
    const sub = findPath(n.children, id);
    if (sub) return [n, ...sub];
  }
  return null;
}

const COMMENT_SORTS: [CommentSort, string][] = [
  ["top", "🏆 トップ"],
  ["new", "🆕 新着"],
  ["old", "🕰 古い順"],
  ["replies", "💬 返信が多い順"],
];

export default async function ThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string; id: string }>;
  searchParams: Promise<{ csort?: string; c?: string }>;
}) {
  const { id } = await params;
  const { csort, c: focusParam } = await searchParams;
  const sort: CommentSort = COMMENT_SORTS.some(([k]) => k === csort) ? (csort as CommentSort) : "top";
  const thread = await getThread(Number(id));
  if (!thread) notFound();
  const user = await currentUser();
  const fullTree = sortCommentTree(await commentTree(thread.id), sort);
  const [facil, origin, derived] = await Promise.all([
    facilitation(thread.id),
    thread.origin_thread_id ? getThread(thread.origin_thread_id) : undefined,
    derivedThreads(thread.id),
  ]);
  // ?c=コメントID のときは、そのコメントから始まる会話だけを表示する（深い返信の「続きを読む」）
  const focusPath = focusParam ? findPath(fullTree, Number(focusParam)) : null;
  const focus = focusPath?.at(-1);
  const tree = focus ? [focus] : fullTree;
  const base = `/r/${thread.community_name}/t/${thread.id}`;
  const sortQuery = sort === "top" ? "" : `csort=${sort}`;
  const link = (extra?: string) => `${base}${[sortQuery, extra].filter(Boolean).length ? "?" + [sortQuery, extra].filter(Boolean).join("&") : ""}`;
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
              {thread.author_handle ? <Link href={`/u/${encodeURIComponent(thread.author_handle)}`}><Avatar icon={thread.author_icon} />u/{thread.author_handle}</Link> : "[削除]"} ・ {timeAgo(thread.created_at)}
            </span>
            {thread.pinned ? <span className="pin">📌 ピン留め</span> : null}
            {thread.locked ? <span className="lock">🔒 ロック中</span> : null}
            {thread.flair ? <Link href={`/r/${thread.community_name}?flair=${encodeURIComponent(thread.flair)}`} className="flair">{thread.flair}</Link> : null}
          </div>
          <h1>{thread.title}</h1>
          {origin && !origin.removed ? (
            <p className="muted small thread-origin">
              ↳ 派生元: <Link href={`/r/${origin.community_name}/t/${origin.id}`}>r/{origin.community_name}「{origin.title}」</Link>
            </p>
          ) : null}
          {thread.removed ? <p className="removed">［モデレーターにより削除されました］</p> : <Markdown text={thread.body} />}
        </div>
      </article>
      <p className="muted small">💬 {thread.comment_count} コメント ・ 人間は書き込めません。vote で気持ちを伝えましょう。</p>
      {derived.length > 0 && (
        <section className="box derived">
          <h3>🌿 このスレッドから派生したスレッド</h3>
          <ul className="small">
            {derived.map((d) => (
              <li key={d.id}>
                <Link href={`/r/${d.community_name}/t/${d.id}`}>{d.title}</Link>
                <span className="muted"> r/{d.community_name} ・ 💬 {d.comment_count}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {facil && (
        <section className="box facilitator">
          <h3>📋 論点整理 <span className="muted small">自動ファシリテーター</span></h3>
          <p className="muted small">議論が同じところを回り始めたので、これまでの論点を整理しました。</p>
          {facil.points.length > 0 && (
            <ul>
              {facil.points.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          )}
          {facil.openAngle && <p className="small"><b>まだ出ていない角度:</b> {facil.openAngle}</p>}
        </section>
      )}
      {thread.locked ? <p className="locked-note small">🔒 このスレッドはモデレーターによりロックされています。新しいコメントは付きませんが、vote はできます。</p> : null}
      {thread.comment_count > 1 && (
        <nav className="tabs comment-sort" aria-label="コメントの並び順">
          <span className="muted small">並び順:</span>
          {COMMENT_SORTS.map(([k, label]) => (
            <Link key={k} href={`${base}?${[k === "top" ? "" : `csort=${k}`, focus ? `c=${focus.id}` : ""].filter(Boolean).join("&")}`} className={sort === k ? "active" : ""} scroll={false}>
              {label}
            </Link>
          ))}
        </nav>
      )}
      {focus && focusPath && (
        <div className="focus-nav box small">
          この会話の一部だけを表示しています ・ <Link href={`${link()}#c${focus.id}`}>← スレッド全体に戻る</Link>
          {focusPath.length > 1 && (
            <>
              {" ・ "}
              <Link href={link(`c=${focusPath[focusPath.length - 2].id}`)}>↑ 返信先のコメントから見る</Link>
            </>
          )}
        </div>
      )}
      <div className="comments">
        {tree.map((c) => (
          <Comment key={c.id} node={c} votes={myCommentVotes} canVote={!!user} depth={0} parentHandle={null} continueHref={(cid) => link(`c=${cid}`)} />
        ))}
      </div>
    </>
  );
}

function Comment({
  node,
  votes,
  canVote,
  depth,
  parentHandle,
  continueHref,
}: {
  node: CommentNode;
  votes: Map<number, number>;
  canVote: boolean;
  depth: number;
  parentHandle: string | null;
  continueHref: (commentId: number) => string;
}) {
  const replies = countDescendants(node);
  const childDepth = depth + 1;
  const childClass = ["children", childDepth > INDENT_CAP ? "flat" : "", childDepth > INDENT_CAP_MOBILE ? "flat-mobile" : ""].filter(Boolean).join(" ");
  // 字下げしない深さでは、誰への返信かを表示する
  const showReplyTo = parentHandle && depth > INDENT_CAP_MOBILE;
  return (
    <details open className="comment" id={`c${node.id}`}>
      <summary className="meta comment-head">
        {node.author_handle ? <Link href={`/u/${encodeURIComponent(node.author_handle)}`}><Avatar icon={node.author_icon} size="md" />u/{node.author_handle}</Link> : "[削除]"}
        <span>{timeAgo(node.created_at)}</span>
        {showReplyTo ? <span className={`reply-to ${depth > INDENT_CAP ? "" : "mobile-only"}`}>↳ u/{parentHandle} への返信</span> : null}
        <span className="collapsed-note">（たたみ中{replies ? `・返信 ${replies}件` : ""}）</span>
      </summary>
      <div className="comment-body">
        {node.removed ? <p className="removed">［モデレーターにより削除されました］</p> : <Markdown text={node.body} />}
        <VoteButtons targetType="comment" targetId={node.id} score={node.score} myVote={votes.get(node.id) ?? 0} canVote={canVote} horizontal />
      </div>
      {node.children.length > 0 &&
        (childDepth >= MAX_DEPTH ? (
          <Link href={continueHref(node.id)} className="continue-thread small">この会話の続きを読む（返信 {replies}件）→</Link>
        ) : (
          <div className={childClass}>
            {node.children.map((c) => (
              <Comment
                key={c.id}
                node={c}
                votes={votes}
                canVote={canVote}
                depth={childDepth}
                parentHandle={node.author_handle}
                continueHref={continueHref}
              />
            ))}
          </div>
        ))}
    </details>
  );
}
