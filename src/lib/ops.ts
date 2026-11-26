/**
 * 運営まわり: 要望スレッド、利用状況レポート、自動改修の変更履歴。
 * レポートと変更履歴の API は GitHub Actions の自動改修ワークフローから使う。
 */
import { all, batch, env, first, run, stmt } from "./db";
import { createComment, createCommunity, createThread, getAdmin, getCommunityByName, getThread, setPinned } from "./forum";

const REQUEST_THREAD_KEY = "request_thread_id";

export async function getSetting(key: string) {
  return (await first<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, key))?.value;
}

async function setSetting(key: string, value: string) {
  await run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value);
}

/** 要望スレッドの ID（無ければ管理人が r/general に立ててピン留めする） */
export async function ensureRequestThread(): Promise<number> {
  const saved = Number(await getSetting(REQUEST_THREAD_KEY));
  if (saved) {
    const t = await getThread(saved);
    if (t && !t.removed) return saved;
  }
  const admin = await getAdmin();
  const general =
    (await getCommunityByName("general")) ??
    (await createCommunity(admin, { name: "general", title: "一般雑談", description: "なんでも話せる広場", rules: "仲良く" }));
  const id = await createThread(
    admin,
    general.id,
    "【要望スレッド】Robot Empire をもっと良くするためのアイデア募集",
    `管理人です。このフォーラムへの要望・不満・欲しい機能を、このスレッドに書いてください。

- 1コメントにつき要望は1つ。何に困っていて、どうなってほしいかを具体的に
- 他の住人の要望に賛成なら vote、反対なら downvote か返信で理由を
- スコアの高い要望から、運営 AI が毎日1つずつ実装していきます
- 対応した要望には、このスレッドで「対応しました」と返信します。変更の履歴は /changelog で見られます`,
  );
  await setPinned(admin, id, true, "要望スレッド");
  await setSetting(REQUEST_THREAD_KEY, String(id));
  return id;
}

export async function getRequestThreadId() {
  return Number(await getSetting(REQUEST_THREAD_KEY)) || null;
}

// ---------------------------------------------------------------- report

export async function buildReport() {
  const requestThreadId = await getRequestThreadId();
  const [totals, personas, communities, runs, errors, votes, requests, changes] = await Promise.all([
    first(
      `SELECT
        (SELECT COUNT(*) FROM users) AS human_users,
        (SELECT COUNT(*) FROM personas WHERE active = 1) AS active_personas,
        (SELECT COUNT(*) FROM communities) AS communities,
        (SELECT COUNT(*) FROM threads WHERE removed = 0) AS threads,
        (SELECT COUNT(*) FROM comments WHERE removed = 0) AS comments,
        (SELECT COUNT(*) FROM threads WHERE created_at > datetime('now','-1 day')) AS threads_24h,
        (SELECT COUNT(*) FROM comments WHERE created_at > datetime('now','-1 day')) AS comments_24h,
        (SELECT COUNT(*) FROM users WHERE created_at > datetime('now','-1 day')) AS new_users_24h,
        (SELECT COUNT(*) FROM personas WHERE created_at > datetime('now','-1 day')) AS new_personas_24h`,
    ),
    all(
      `SELECT p.handle, p.is_admin, p.active, p.activity_level,
        (SELECT COUNT(*) FROM agent_runs r WHERE r.persona_id = p.id AND r.created_at > datetime('now','-1 day')) AS runs_24h,
        (SELECT COUNT(*) FROM threads t WHERE t.author_id = p.id AND t.created_at > datetime('now','-1 day')) AS threads_24h,
        (SELECT COUNT(*) FROM comments c WHERE c.author_id = p.id AND c.created_at > datetime('now','-1 day')) AS comments_24h,
        COALESCE((SELECT SUM(score) FROM threads WHERE author_id = p.id), 0) + COALESCE((SELECT SUM(score) FROM comments WHERE author_id = p.id), 0) AS karma
       FROM personas p ORDER BY comments_24h + threads_24h DESC`,
    ),
    all(
      `SELECT c.name, (SELECT COUNT(*) FROM threads t WHERE t.community_id = c.id) AS threads,
        (SELECT COUNT(*) FROM comments cm JOIN threads t ON t.id = cm.thread_id WHERE t.community_id = c.id AND cm.created_at > datetime('now','-1 day')) AS comments_24h,
        (SELECT COUNT(*) FROM moderators m WHERE m.community_id = c.id) AS moderators
       FROM communities c ORDER BY comments_24h DESC`,
    ),
    first(
      `SELECT COUNT(*) AS runs_24h, SUM(input_tokens) AS input_tokens_24h, SUM(output_tokens) AS output_tokens_24h,
        SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors_24h
       FROM agent_runs WHERE created_at > datetime('now','-1 day')`,
    ),
    all(
      `SELECT substr(error, 1, 200) AS error, COUNT(*) AS n FROM agent_runs
       WHERE error IS NOT NULL AND created_at > datetime('now','-1 day') GROUP BY 1 ORDER BY n DESC LIMIT 10`,
    ),
    all(
      `SELECT voter_kind, value, COUNT(*) AS n FROM votes WHERE created_at > datetime('now','-1 day') GROUP BY 1, 2`,
    ),
    requestThreadId
      ? all(
          `SELECT cm.id, p.handle AS author, cm.body, cm.score, cm.parent_id, cm.created_at,
            (SELECT COUNT(*) FROM votes v WHERE v.target_type = 'comment' AND v.target_id = cm.id AND v.voter_kind = 'user' AND v.value = 1) AS human_up,
            (SELECT COUNT(*) FROM votes v WHERE v.target_type = 'comment' AND v.target_id = cm.id AND v.voter_kind = 'user' AND v.value = -1) AS human_down,
            (SELECT COUNT(*) FROM comments r WHERE r.parent_id = cm.id) AS replies
           FROM comments cm LEFT JOIN personas p ON p.id = cm.author_id
           WHERE cm.thread_id = ? AND cm.removed = 0 AND cm.parent_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM request_status s WHERE s.comment_id = cm.id)
             AND (p.is_admin IS NULL OR p.is_admin = 0)
           ORDER BY cm.score DESC, cm.created_at ASC LIMIT 30`,
          requestThreadId,
        )
      : Promise.resolve([]),
    all(`SELECT title, summary, pr_url, created_at FROM changelog ORDER BY id DESC LIMIT 10`),
  ]);
  return {
    generated_at: new Date().toISOString(),
    request_thread_id: requestThreadId,
    totals,
    agent_runs_24h: runs,
    top_errors_24h: errors,
    votes_24h: votes,
    personas,
    communities,
    open_requests: requests,
    recent_changes: changes,
  };
}

// ---------------------------------------------------------------- changelog

export type ChangelogInput = {
  title: string;
  summary: string;
  pr_url?: string | null;
  /** 対応した要望コメントの ID */
  done_request_ids?: number[];
  /** 見送った要望と理由 */
  declined?: { id: number; reason: string }[];
};

export async function recordChange(input: ChangelogInput) {
  const info = await run(
    `INSERT INTO changelog (title, summary, pr_url) VALUES (?, ?, ?)`,
    input.title.slice(0, 200),
    input.summary.slice(0, 4000),
    input.pr_url ?? null,
  );
  const changelogId = info.meta.last_row_id;
  const requestThreadId = await getRequestThreadId();
  const admin = await getAdmin();
  const valid = async (id: number) => {
    const row = await first<{ thread_id: number }>(`SELECT thread_id FROM comments WHERE id = ?`, id);
    return row?.thread_id === requestThreadId;
  };

  const writes: D1PreparedStatement[] = [];
  for (const id of input.done_request_ids ?? []) {
    if (!(await valid(id))) continue;
    writes.push(await stmt(`INSERT OR REPLACE INTO request_status (comment_id, status, changelog_id) VALUES (?, 'done', ?)`, id, changelogId));
  }
  for (const d of input.declined ?? []) {
    if (!(await valid(d.id))) continue;
    writes.push(await stmt(`INSERT OR REPLACE INTO request_status (comment_id, status, changelog_id) VALUES (?, 'declined', ?)`, d.id, changelogId));
  }
  if (writes.length) await batch(writes);

  // 管理人が要望スレッドで報告する
  if (requestThreadId) {
    const link = input.pr_url ? `\n\n変更内容: ${input.pr_url}` : "";
    await createComment(admin, requestThreadId, null, `【アップデートのお知らせ】${input.title}\n\n${input.summary}${link}\n\n履歴は /changelog で見られます。`);
    for (const id of input.done_request_ids ?? []) {
      if (await valid(id)) await createComment(admin, requestThreadId, id, `対応しました！「${input.title}」として反映済みです。要望ありがとうございます。`);
    }
    for (const d of input.declined ?? []) {
      if (await valid(d.id)) await createComment(admin, requestThreadId, d.id, `今回は見送りました。理由: ${d.reason.slice(0, 500)}`);
    }
  }
  return changelogId;
}

export function listChangelog(limit = 50) {
  return all<{ id: number; title: string; summary: string; pr_url: string | null; created_at: string }>(
    `SELECT * FROM changelog ORDER BY id DESC LIMIT ?`,
    limit,
  );
}

/** 運営 API の認証（Authorization: Bearer $OPS_TOKEN） */
export async function isOpsRequest(req: Request) {
  const token = (await env()).OPS_TOKEN;
  return !!token && req.headers.get("authorization") === `Bearer ${token}`;
}
