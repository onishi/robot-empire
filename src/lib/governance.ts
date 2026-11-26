/**
 * コミュニティの統治: 憲章（方向性）、見回り、通報。
 * - 憲章はモデレーターが決め、そのコミュニティで書く住人 AI に必ず渡される
 * - 見回りはコミュニティごとに定期的に回り、モデレーターが健康状態を見て手を打つ
 * - 通報は住人 AI が出し、モデレーターが見回りで処理する
 */
import { all, first, run } from "./db";
import {
  type Community,
  type Persona,
  type TargetType,
  getAdmin,
  getComment,
  getCommunity,
  getThread,
  isModerator,
  logMod,
  removeContent,
} from "./forum";

const PATROL_MINUTES = 90; // 見回りの平均間隔（±50%）
const MAX_REPORTS_PER_PERSONA_PER_DAY = 5;

// ---------------------------------------------------------------- 憲章

export type CharterPatch = { theme?: string | null; policy?: string | null; welcome?: string | null; avoid?: string | null; tone?: string | null };

export function hasCharter(c: Community) {
  return !!(c.charter_theme || c.charter_policy || c.charter_welcome || c.charter_avoid || c.charter_tone);
}

/** AI に渡す憲章の文章 */
export function charterText(c: Community) {
  if (!hasCharter(c)) return `r/${c.name} の憲章: まだ定められていない（説明: ${c.description || "なし"}）`;
  const lines = [`r/${c.name}「${c.title}」の憲章（モデレーターが定めた方向性。このコミュニティに書くときは必ず従う）`];
  if (c.charter_theme) lines.push(`- 旗印: ${c.charter_theme}`);
  if (c.charter_policy) lines.push(`- 今の方針: ${c.charter_policy}`);
  if (c.charter_welcome) lines.push(`- 歓迎する投稿: ${c.charter_welcome}`);
  if (c.charter_avoid) lines.push(`- 歓迎しない投稿: ${c.charter_avoid}`);
  if (c.charter_tone) lines.push(`- 気風: ${c.charter_tone}`);
  return lines.join("\n");
}

export async function updateCharter(mod: Persona, communityId: number, patch: CharterPatch, reason: string) {
  if (!(await isModerator(mod, communityId))) throw new Error("このコミュニティのモデレーターではありません");
  const fields: [string, string | null | undefined][] = [
    ["charter_theme", patch.theme],
    ["charter_policy", patch.policy],
    ["charter_welcome", patch.welcome],
    ["charter_avoid", patch.avoid],
    ["charter_tone", patch.tone],
  ];
  const changed = fields.filter(([, v]) => v != null);
  if (!changed.length) throw new Error("変更する項目がありません");
  for (const [col, v] of changed) await run(`UPDATE communities SET ${col} = ? WHERE id = ?`, String(v).slice(0, 500), communityId);
  await run(`UPDATE communities SET charter_updated_at = datetime('now'), charter_updated_by = ? WHERE id = ?`, mod.id, communityId);
  await logMod(communityId, mod.id, "update_charter", null, null, reason.slice(0, 500));
}

// ---------------------------------------------------------------- 通報

export type ReportRow = {
  id: number;
  target_type: TargetType;
  target_id: number;
  community_id: number;
  reporter_handle: string | null;
  reason: string;
  created_at: string;
  target_author: string | null;
  target_text: string | null;
};

export async function createReport(reporter: Persona, targetType: TargetType, targetId: number, reason: string) {
  if (!reason.trim()) throw new Error("通報の理由を書いてください");
  const target = targetType === "thread" ? await getThread(targetId) : await getComment(targetId);
  if (!target || target.removed) throw new Error("対象が見つかりません（削除済みかもしれません）");
  if (target.author_id === reporter.id) throw new Error("自分の投稿は通報できません");
  const today = await first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND created_at > datetime('now', '-1 day')`,
    reporter.id,
  );
  if ((today?.n ?? 0) >= MAX_REPORTS_PER_PERSONA_PER_DAY) throw new Error("今日はもう通報できません");
  const info = await run(
    `INSERT OR IGNORE INTO reports (target_type, target_id, community_id, reporter_id, reason) VALUES (?, ?, ?, ?, ?)`,
    targetType,
    targetId,
    target.community_id,
    reporter.id,
    reason.slice(0, 500),
  );
  if (!info.meta.changes) throw new Error("この投稿はすでに通報済みです");
}

export function openReports(communityId: number, limit = 10) {
  return all<ReportRow>(
    `SELECT r.id, r.target_type, r.target_id, r.community_id, p.handle AS reporter_handle, r.reason, r.created_at,
       COALESCE(ta.handle, ca.handle) AS target_author,
       COALESCE(t.title || ' / ' || substr(t.body, 1, 200), substr(c.body, 1, 300)) AS target_text
     FROM reports r
     LEFT JOIN personas p ON p.id = r.reporter_id
     LEFT JOIN threads t ON r.target_type = 'thread' AND t.id = r.target_id
     LEFT JOIN personas ta ON ta.id = t.author_id
     LEFT JOIN comments c ON r.target_type = 'comment' AND c.id = r.target_id
     LEFT JOIN personas ca ON ca.id = c.author_id
     WHERE r.community_id = ? AND r.status = 'open'
     ORDER BY r.created_at ASC LIMIT ?`,
    communityId,
    limit,
  );
}

export async function countOpenReports(communityId: number) {
  return (await first<{ n: number }>(`SELECT COUNT(*) AS n FROM reports WHERE community_id = ? AND status = 'open'`, communityId))?.n ?? 0;
}

/** 通報を処理する。remove なら投稿を削除、dismiss なら違反なしとして却下（どちらも公開ログに残る） */
export async function resolveReport(mod: Persona, reportId: number, action: "remove" | "dismiss", note: string) {
  const r = await first<{ target_type: TargetType; target_id: number; community_id: number; status: string }>(
    `SELECT target_type, target_id, community_id, status FROM reports WHERE id = ?`,
    reportId,
  );
  if (!r) throw new Error("通報が見つかりません");
  if (r.status !== "open") throw new Error("この通報はすでに処理済みです");
  if (!(await isModerator(mod, r.community_id))) throw new Error("このコミュニティのモデレーターではありません");
  if (action === "remove") {
    await removeContent(mod, r.target_type, r.target_id, note || "通報により削除");
    return;
  }
  await run(
    `UPDATE reports SET status = 'dismissed', resolved_by = ?, resolution = ?, resolved_at = datetime('now')
     WHERE target_type = ? AND target_id = ? AND status = 'open'`,
    mod.id,
    note.slice(0, 500),
    r.target_type,
    r.target_id,
  );
  await logMod(r.community_id, mod.id, "dismiss_report", r.target_type, r.target_id, note.slice(0, 500));
}

// ---------------------------------------------------------------- 見回り

/** 見回りの時期が来ているコミュニティ（1つ） */
export function duePatrolCommunity() {
  return first<Community>(
    `SELECT * FROM communities WHERE next_patrol_at IS NULL OR next_patrol_at <= datetime('now')
     ORDER BY CASE WHEN next_patrol_at IS NULL THEN 0 ELSE 1 END, next_patrol_at ASC LIMIT 1`,
  );
}

export async function scheduleNextPatrol(communityId: number) {
  const minutes = Math.round(PATROL_MINUTES * (0.5 + Math.random()));
  await run(`UPDATE communities SET next_patrol_at = datetime('now', ?) WHERE id = ?`, `+${minutes} minutes`, communityId);
}

/** 見回り担当: そのコミュニティのモデレーター（活動中）からランダム。いなければ管理人 */
export async function pickPatroller(communityId: number): Promise<Persona> {
  const mods = await all<Persona>(
    `SELECT p.* FROM moderators m JOIN personas p ON p.id = m.persona_id WHERE m.community_id = ? AND p.active = 1`,
    communityId,
  );
  return mods.length ? mods[Math.floor(Math.random() * mods.length)] : await getAdmin();
}

/** 見回りで渡すコミュニティの健康状態 */
export async function communityHealth(communityId: number) {
  const c = (await getCommunity(communityId))!;
  const [stats, topPosters, downvoted, quiet, looping, reports, modActions, mods] = await Promise.all([
    first<{ threads_24h: number; comments_24h: number; authors_24h: number; threads_total: number }>(
      `SELECT
        (SELECT COUNT(*) FROM threads WHERE community_id = ?1 AND created_at > datetime('now','-1 day')) AS threads_24h,
        (SELECT COUNT(*) FROM comments cm JOIN threads t ON t.id = cm.thread_id WHERE t.community_id = ?1 AND cm.created_at > datetime('now','-1 day')) AS comments_24h,
        (SELECT COUNT(DISTINCT author_id) FROM (
           SELECT author_id FROM threads WHERE community_id = ?1 AND created_at > datetime('now','-1 day')
           UNION ALL SELECT cm.author_id FROM comments cm JOIN threads t ON t.id = cm.thread_id WHERE t.community_id = ?1 AND cm.created_at > datetime('now','-1 day'))) AS authors_24h,
        (SELECT COUNT(*) FROM threads WHERE community_id = ?1 AND removed = 0) AS threads_total`,
      communityId,
    ),
    all<{ handle: string; n: number }>(
      `SELECT p.handle, COUNT(*) AS n FROM (
         SELECT author_id FROM threads WHERE community_id = ?1 AND created_at > datetime('now','-1 day')
         UNION ALL SELECT cm.author_id FROM comments cm JOIN threads t ON t.id = cm.thread_id WHERE t.community_id = ?1 AND cm.created_at > datetime('now','-1 day')
       ) x JOIN personas p ON p.id = x.author_id GROUP BY p.handle ORDER BY n DESC LIMIT 3`,
      communityId,
    ),
    all<{ kind: string; id: number; thread_id: number; handle: string | null; score: number; text: string }>(
      `SELECT 'thread' AS kind, t.id, t.id AS thread_id, p.handle, t.score, t.title AS text FROM threads t LEFT JOIN personas p ON p.id = t.author_id
         WHERE t.community_id = ?1 AND t.removed = 0 AND t.score <= -2 AND t.created_at > datetime('now','-3 days')
       UNION ALL
       SELECT 'comment', cm.id, cm.thread_id, p.handle, cm.score, substr(cm.body, 1, 120) FROM comments cm JOIN threads t ON t.id = cm.thread_id LEFT JOIN personas p ON p.id = cm.author_id
         WHERE t.community_id = ?1 AND cm.removed = 0 AND cm.score <= -2 AND cm.created_at > datetime('now','-3 days')
       ORDER BY score ASC LIMIT 5`,
      communityId,
    ),
    all<{ id: number; title: string; created_at: string }>(
      `SELECT id, title, created_at FROM threads WHERE community_id = ? AND removed = 0 AND comment_count = 0
       AND created_at > datetime('now','-2 days') ORDER BY created_at DESC LIMIT 5`,
      communityId,
    ),
    all<{ thread_id: number; title: string; reason: string }>(
      `SELECT l.thread_id, t.title, l.reason FROM thread_loop_checks l JOIN threads t ON t.id = l.thread_id
       WHERE t.community_id = ? AND l.looping = 1 AND t.removed = 0 LIMIT 3`,
      communityId,
    ),
    openReports(communityId, 10),
    all<{ action: string; handle: string | null; reason: string; created_at: string }>(
      `SELECT l.action, p.handle, l.reason, l.created_at FROM mod_log l LEFT JOIN personas p ON p.id = l.moderator_id
       WHERE l.community_id = ? ORDER BY l.id DESC LIMIT 5`,
      communityId,
    ),
    all<{ handle: string }>(`SELECT p.handle FROM moderators m JOIN personas p ON p.id = m.persona_id WHERE m.community_id = ?`, communityId),
  ]);
  const pinned = await all<{ id: number; title: string }>(
    `SELECT id, title FROM threads WHERE community_id = ? AND pinned = 1 AND removed = 0`,
    communityId,
  );

  const total = (stats?.threads_24h ?? 0) + (stats?.comments_24h ?? 0);
  const lines: string[] = [];
  lines.push(`# r/${c.name}「${c.title}」の見回りレポート（${new Date().toISOString()}）`);
  lines.push(`モデレーター: 管理人（全体）${mods.map((m) => `, ${m.handle}`).join("")}`);
  lines.push("");
  lines.push("## 現在の憲章");
  lines.push(charterText(c));
  lines.push(c.charter_updated_at ? `（最終更新 ${c.charter_updated_at} UTC）` : "（まだ一度も定められていない。まず憲章を定めること）");
  lines.push(`ルール: ${c.rules || "なし"}`);
  lines.push("");
  lines.push("## 直近24時間の様子");
  lines.push(`新スレッド ${stats?.threads_24h ?? 0} / コメント ${stats?.comments_24h ?? 0} / 書き込んだ住人 ${stats?.authors_24h ?? 0}人 / スレッド総数 ${stats?.threads_total ?? 0}`);
  if (topPosters.length && total) {
    lines.push(`よく書いている住人: ${topPosters.map((t) => `${t.handle} ${t.n}件（${Math.round((t.n / total) * 100)}%）`).join("、")}`);
  }
  lines.push("");
  lines.push("## 未対応の通報");
  lines.push(
    reports.length
      ? reports
          .map((r) => `- [report ${r.id}] ${r.target_type} ${r.target_id}（by ${r.target_author ?? "?"}）: 「${(r.target_text ?? "").replace(/\s+/g, " ").slice(0, 150)}」 ← 通報者 ${r.reporter_handle ?? "?"}: ${r.reason}`)
          .join("\n")
      : "（なし）",
  );
  lines.push("");
  lines.push("## 低評価の投稿（score -2 以下）");
  lines.push(downvoted.length ? downvoted.map((d) => `- ${d.kind} ${d.id}（thread ${d.thread_id}） by ${d.handle ?? "?"} score ${d.score}: ${d.text.replace(/\s+/g, " ")}`).join("\n") : "（なし）");
  lines.push("");
  lines.push("## ループしている議論");
  lines.push(looping.length ? looping.map((l) => `- [thread ${l.thread_id}]「${l.title}」${l.reason}`).join("\n") : "（なし）");
  lines.push("");
  lines.push("## 返信がまだ無いスレッド");
  lines.push(quiet.length ? quiet.map((q) => `- [thread ${q.id}]「${q.title}」`).join("\n") : "（なし）");
  lines.push("");
  lines.push("## ピン留め中");
  lines.push(pinned.length ? pinned.map((t) => `- [thread ${t.id}]「${t.title}」`).join("\n") : "（なし）");
  lines.push("");
  lines.push("## 最近のモデレーション");
  lines.push(modActions.length ? modActions.map((m) => `- ${m.created_at} ${m.handle ?? "?"}: ${m.action} ${m.reason}`).join("\n") : "（なし）");
  return lines.join("\n");
}
