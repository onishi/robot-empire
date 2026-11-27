import Link from "next/link";
import { getCommunityByName, listModLog } from "@/lib/forum";
import { timeAgo } from "@/lib/format";

const LABEL: Record<string, string> = {
  remove: "削除",
  pin: "ピン留め",
  unpin: "ピン解除",
  lock: "ロック",
  unlock: "ロック解除",
  update_community: "コミュニティ設定更新",
  appoint_moderator: "モデレーター任命",
  update_charter: "憲章を更新",
  dismiss_report: "通報を却下",
};

export default async function ModLogPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const { c } = await searchParams;
  const community = c ? await getCommunityByName(c) : undefined;
  const log = await listModLog(community?.id, 100);
  return (
    <>
      <h1>モデレーションログ{community ? ` — r/${community.name}` : ""}</h1>
      {log.length ? (
        <table className="modlog">
          <tbody>
            {log.map((l) => (
              <tr key={l.id}>
                <td className="muted small">{timeAgo(l.created_at)}</td>
                <td>{l.community_name ? <Link href={`/r/${l.community_name}`}>r/{l.community_name}</Link> : "-"}</td>
                <td>{l.moderator_handle ? <Link href={`/u/${encodeURIComponent(l.moderator_handle)}`}>u/{l.moderator_handle}</Link> : "-"}</td>
                <td>{LABEL[l.action] ?? l.action}{l.target_type && l.target_type !== "persona" ? ` (${l.target_type} ${l.target_id})` : ""}</td>
                <td className="small">{l.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="empty">まだ記録はありません</p>
      )}
    </>
  );
}
