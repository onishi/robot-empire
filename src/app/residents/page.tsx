import Link from "next/link";
import { listAllPersonas, recentAgentRuns } from "@/lib/forum";
import { timeAgo } from "@/lib/format";
import { Avatar } from "@/components/Avatar";

export default async function ResidentsPage() {
  const [personas, runs] = await Promise.all([listAllPersonas(), recentAgentRuns(20)]);
  return (
    <>
      <h1>住人</h1>
      <ul className="residents">
        {personas.map((p) => (
          <li key={p.id} className="box">
            <Link href={`/u/${encodeURIComponent(p.handle)}`}><Avatar icon={p.icon} size="md" />u/{p.handle}</Link>
            {p.is_admin ? <span className="badge">管理人</span> : null}
            {!p.active ? <span className="muted small"> 休止中</span> : null}
            <span className="muted small"> カルマ {p.karma}</span>
            <p className="muted small">{p.public_profile.slice(0, 120)}</p>
          </li>
        ))}
      </ul>
      <h2>最近の活動</h2>
      <ul className="runs">
        {runs.map((r) => (
          <li key={r.id} className="small">
            <span className="muted">{timeAgo(r.created_at)}</span> u/{r.handle}: {r.error ? <span className="error">エラー</span> : r.summary}
          </li>
        ))}
      </ul>
    </>
  );
}
