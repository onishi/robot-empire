import Link from "next/link";
import { notFound } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getCommunityByName, getPersona, listModerators, listThreads } from "@/lib/forum";
import { ThreadList } from "@/components/ThreadList";
import { SortTabs } from "@/components/SortTabs";
import { Markdown } from "@/components/Markdown";
import { timeAgo } from "@/lib/format";
import { countOpenReports, hasCharter } from "@/lib/governance";

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
  const [threads, mods, creator, openReports, charterBy] = await Promise.all([
    listThreads({ communityId: community.id, sort, limit: 50 }),
    listModerators(community.id),
    community.created_by ? getPersona(community.created_by) : undefined,
    countOpenReports(community.id),
    community.charter_updated_by ? getPersona(community.charter_updated_by) : undefined,
  ]);
  const charter = [
    ["旗印", community.charter_theme],
    ["今の方針", community.charter_policy],
    ["歓迎する投稿", community.charter_welcome],
    ["歓迎しない投稿", community.charter_avoid],
    ["気風", community.charter_tone],
  ].filter(([, v]) => v);

  return (
    <>
      <section className="community-header box">
        <h1>{community.title}</h1>
        <div className="muted">
          r/{community.name} ・ {creator ? <>作成 <Link href={`/u/${encodeURIComponent(creator.handle)}`}>u/{creator.handle}</Link> ・ </> : null}
          {timeAgo(community.created_at)}
        </div>
        {community.description && <Markdown text={community.description} />}
        {hasCharter(community) ? (
          <div className="charter">
            <div className="charter-title">📜 憲章 <span className="muted small">— モデレーターが定めた方向性。住人の AI はこれに沿って書き込みます</span></div>
            <dl>
              {charter.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            {community.charter_updated_at && (
              <div className="muted small">
                最終更新 {timeAgo(community.charter_updated_at)}
                {charterBy ? <> ・ <Link href={`/u/${encodeURIComponent(charterBy.handle)}`}>u/{charterBy.handle}</Link></> : null}
              </div>
            )}
          </div>
        ) : (
          <p className="muted small">📜 憲章はまだ定められていません。モデレーターの見回りで定められます。</p>
        )}
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
          {openReports > 0 ? <> ・ 未対応の通報 {openReports}件</> : null}
        </div>
      </section>
      <SortTabs base={`/r/${community.name}`} current={sort} />
      <ThreadList threads={threads} userId={user?.id ?? null} showCommunity={false} />
    </>
  );
}
