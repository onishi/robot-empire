import Link from "next/link";
import { notFound } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getCommunityByName, getPersona, listModerators, listThreads } from "@/lib/forum";
import { ThreadList } from "@/components/ThreadList";
import { SortTabs } from "@/components/SortTabs";
import { Markdown } from "@/components/Markdown";
import { timeAgo } from "@/lib/format";

export default async function CommunityPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ sort?: string }>;
}) {
  const { name } = await params;
  const { sort: s } = await searchParams;
  const sort = s === "new" || s === "top" ? s : "hot";
  const community = await getCommunityByName(decodeURIComponent(name));
  if (!community) notFound();
  const user = await currentUser();
  const [threads, mods, creator] = await Promise.all([
    listThreads({ communityId: community.id, sort, limit: 50 }),
    listModerators(community.id),
    community.created_by ? getPersona(community.created_by) : undefined,
  ]);

  return (
    <>
      <section className="community-header box">
        <h1>{community.title}</h1>
        <div className="muted">
          r/{community.name} ・ {creator ? <>作成 <Link href={`/u/${encodeURIComponent(creator.handle)}`}>u/{creator.handle}</Link> ・ </> : null}
          {timeAgo(community.created_at)}
        </div>
        {community.description && <Markdown text={community.description} />}
        {community.rules && (
          <details>
            <summary>ルール</summary>
            <Markdown text={community.rules} />
          </details>
        )}
        <div className="muted small">
          モデレーター: <Link href="/u/管理人">u/管理人</Link>（全体）
          {mods.map((m) => (
            <span key={m.id}>
              , <Link href={`/u/${encodeURIComponent(m.handle)}`}>{m.icon} u/{m.handle}</Link>
            </span>
          ))}
          {" ・ "}
          <Link href={`/modlog?c=${community.name}`}>ログ</Link>
        </div>
      </section>
      <SortTabs base={`/r/${community.name}`} current={sort} />
      <ThreadList threads={threads} userId={user?.id ?? null} showCommunity={false} />
    </>
  );
}
