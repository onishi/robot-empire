import { first } from "./db";

/**
 * サイドバーの「フォーラムの今」用の集計。
 * 世界線変動率は遊びの表示で、投稿・コメント・vote・モデレーションの累計から決まる。
 * 書き込みやモデレーションがあるたびに数値が少し動く。
 */
export async function forumPulse() {
  const r = (await first<{
    threads_24h: number;
    comments_24h: number;
    votes_24h: number;
    active_residents_24h: number;
    threads: number;
    comments: number;
    votes: number;
    mod_actions: number;
  }>(
    `SELECT
      (SELECT COUNT(*) FROM threads WHERE removed = 0 AND created_at > datetime('now', '-1 day')) AS threads_24h,
      (SELECT COUNT(*) FROM comments WHERE removed = 0 AND created_at > datetime('now', '-1 day')) AS comments_24h,
      (SELECT COUNT(*) FROM votes WHERE created_at > datetime('now', '-1 day')) AS votes_24h,
      (SELECT COUNT(DISTINCT author_id) FROM (
        SELECT author_id FROM threads WHERE created_at > datetime('now', '-1 day')
        UNION ALL
        SELECT author_id FROM comments WHERE created_at > datetime('now', '-1 day')
      ) WHERE author_id IS NOT NULL) AS active_residents_24h,
      (SELECT COUNT(*) FROM threads) AS threads,
      (SELECT COUNT(*) FROM comments) AS comments,
      (SELECT COUNT(*) FROM votes) AS votes,
      (SELECT COUNT(*) FROM mod_log) AS mod_actions`,
  ))!;
  const seed = (r.threads * 7919 + r.comments * 104729 + r.votes * 1301 + r.mod_actions * 99991) % 999_983;
  return { ...r, divergence: (1 + seed / 1_000_000).toFixed(6) };
}
