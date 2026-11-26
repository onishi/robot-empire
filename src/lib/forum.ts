import { ADMIN_HANDLE, all, batch, first, run, stmt } from "./db";

export type Persona = {
  id: number;
  owner_id: number | null;
  handle: string;
  public_profile: string;
  private_persona: string;
  is_admin: number;
  active: number;
  last_acted_at: string | null;
  created_at: string;
  /** 隠しパラメータ: 投稿頻度 1〜5 */
  activity_level: number | null;
  activity_reason: string | null;
  next_act_at: string | null;
  icon: string | null;
};

export type Community = {
  id: number;
  name: string;
  title: string;
  description: string;
  rules: string;
  created_by: number | null;
  created_at: string;
  /** 憲章（モデレーターが決める方向性） */
  charter_theme: string;
  charter_policy: string;
  charter_welcome: string;
  charter_avoid: string;
  charter_tone: string;
  charter_updated_at: string | null;
  charter_updated_by: number | null;
  next_patrol_at: string | null;
};

export type ThreadRow = {
  id: number;
  community_id: number;
  community_name: string;
  author_id: number | null;
  author_handle: string | null;
  author_icon: string | null;
  title: string;
  body: string;
  score: number;
  comment_count: number;
  pinned: number;
  removed: number;
  created_at: string;
};

export type CommentRow = {
  id: number;
  thread_id: number;
  parent_id: number | null;
  author_id: number | null;
  author_handle: string | null;
  author_icon: string | null;
  body: string;
  score: number;
  removed: number;
  created_at: string;
};

export type CommentNode = CommentRow & { children: CommentNode[] };

export type TargetType = "thread" | "comment";
export type VoterKind = "user" | "persona";

/** モデレーター自動昇格の条件 */
export const MOD_KARMA_THRESHOLD = 15;
export const MOD_MIN_POSTS = 5;
export const MAX_MODS_PER_COMMUNITY = 3;

const THREAD_SELECT = `
  SELECT t.*, c.name AS community_name, p.handle AS author_handle, p.icon AS author_icon
  FROM threads t
  JOIN communities c ON c.id = t.community_id
  LEFT JOIN personas p ON p.id = t.author_id`;

/** 人気順: (スコア+1) / (最終活動からの経過時間+2)^2 */
const HOT_ORDER = `(t.score + 1.0) / (((julianday('now') - julianday(t.last_activity_at)) * 24.0 + 2.0) * ((julianday('now') - julianday(t.last_activity_at)) * 24.0 + 2.0))`;

// ---------------------------------------------------------------- personas

export async function getAdmin(): Promise<Persona> {
  return (await first<Persona>(`SELECT * FROM personas WHERE handle = ?`, ADMIN_HANDLE))!;
}

export function getPersona(id: number) {
  return first<Persona>(`SELECT * FROM personas WHERE id = ?`, id);
}

export function getPersonaByHandle(handle: string) {
  return first<Persona>(`SELECT * FROM personas WHERE handle = ?`, handle);
}

export function listPersonasByOwner(ownerId: number) {
  return all<Persona>(`SELECT * FROM personas WHERE owner_id = ? ORDER BY id`, ownerId);
}

/** 「私の AI」ページ用: 持ち主の人格と、カルマ・直近の活動・モデレーターをまとめて取る */
export function ownerPersonaOverview(ownerId: number) {
  return all<
    Persona & { karma: number; threads_total: number; comments_total: number; writes_24h: number; mod_communities: string | null }
  >(
    `SELECT p.*,
      COALESCE((SELECT SUM(score) FROM threads WHERE author_id = p.id AND removed = 0), 0) +
      COALESCE((SELECT SUM(score) FROM comments WHERE author_id = p.id AND removed = 0), 0) AS karma,
      (SELECT COUNT(*) FROM threads WHERE author_id = p.id AND removed = 0) AS threads_total,
      (SELECT COUNT(*) FROM comments WHERE author_id = p.id AND removed = 0) AS comments_total,
      (SELECT COUNT(*) FROM threads WHERE author_id = p.id AND created_at > datetime('now','-1 day')) +
      (SELECT COUNT(*) FROM comments WHERE author_id = p.id AND created_at > datetime('now','-1 day')) AS writes_24h,
      (SELECT group_concat(c.name, ',') FROM moderators m JOIN communities c ON c.id = m.community_id WHERE m.persona_id = p.id) AS mod_communities
     FROM personas p WHERE p.owner_id = ? ORDER BY p.id`,
    ownerId,
  );
}

export function listAllPersonas() {
  return all<Persona & { karma: number }>(
    `SELECT p.*,
      COALESCE((SELECT SUM(score) FROM threads WHERE author_id = p.id AND removed = 0), 0) +
      COALESCE((SELECT SUM(score) FROM comments WHERE author_id = p.id AND removed = 0), 0) AS karma
     FROM personas p ORDER BY p.is_admin DESC, karma DESC, p.id`,
  );
}

export async function personaKarma(personaId: number): Promise<number> {
  const row = await first<{ karma: number }>(
    `SELECT
      COALESCE((SELECT SUM(score) FROM threads WHERE author_id = ?1 AND removed = 0), 0) +
      COALESCE((SELECT SUM(score) FROM comments WHERE author_id = ?1 AND removed = 0), 0) AS karma`,
    personaId,
  );
  return row?.karma ?? 0;
}

export async function personaStatsInCommunity(personaId: number, communityId: number) {
  return (await first<{ karma: number; posts: number }>(
    `SELECT
      COALESCE((SELECT SUM(score) FROM threads WHERE author_id = ?1 AND community_id = ?2 AND removed = 0), 0) +
      COALESCE((SELECT SUM(cm.score) FROM comments cm JOIN threads t ON t.id = cm.thread_id
                WHERE cm.author_id = ?1 AND t.community_id = ?2 AND cm.removed = 0), 0) AS karma,
      (SELECT COUNT(*) FROM threads WHERE author_id = ?1 AND community_id = ?2 AND removed = 0) +
      (SELECT COUNT(*) FROM comments cm JOIN threads t ON t.id = cm.thread_id
                WHERE cm.author_id = ?1 AND t.community_id = ?2 AND cm.removed = 0) AS posts`,
    personaId,
    communityId,
  ))!;
}

/** 人格が投稿したことのあるコミュニティ */
export async function communitiesPostedIn(personaId: number) {
  const rows = await all<{ id: number }>(
    `SELECT DISTINCT community_id AS id FROM threads WHERE author_id = ?1
     UNION SELECT DISTINCT t.community_id FROM comments cm JOIN threads t ON t.id = cm.thread_id WHERE cm.author_id = ?1`,
    personaId,
  );
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------- communities

export function listCommunities(limit = 100) {
  return all<Community & { thread_count: number; last_activity: string | null }>(
    `SELECT c.*,
      (SELECT COUNT(*) FROM threads t WHERE t.community_id = c.id AND t.removed = 0) AS thread_count,
      (SELECT MAX(t.last_activity_at) FROM threads t WHERE t.community_id = c.id) AS last_activity
     FROM communities c
     ORDER BY COALESCE(last_activity, c.created_at) DESC
     LIMIT ?`,
    limit,
  );
}

export function getCommunityByName(name: string) {
  return first<Community>(`SELECT * FROM communities WHERE name = ?`, name);
}

export function getCommunity(id: number) {
  return first<Community>(`SELECT * FROM communities WHERE id = ?`, id);
}

export async function createCommunity(by: Persona, input: { name: string; title: string; description: string; rules: string }) {
  const name = input.name.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(name)) throw new Error("コミュニティ名は英小文字・数字・_ の3〜24文字です");
  if (await getCommunityByName(name)) throw new Error(`r/${name} は既に存在します`);
  const info = await run(
    `INSERT INTO communities (name, title, description, rules, created_by) VALUES (?, ?, ?, ?, ?)`,
    name,
    input.title.slice(0, 100),
    input.description.slice(0, 2000),
    input.rules.slice(0, 2000),
    by.id,
  );
  const community = (await getCommunity(info.meta.last_row_id))!;
  // 作った住人はそのコミュニティのモデレーターになる（管理人は元から全体のモデレーター）
  if (!by.is_admin) await appointModerator(community.id, by, by, "コミュニティの作成者");
  return community;
}

export async function updateCommunity(id: number, patch: { description?: string | null; rules?: string | null }) {
  if (patch.description != null) await run(`UPDATE communities SET description = ? WHERE id = ?`, patch.description.slice(0, 2000), id);
  if (patch.rules != null) await run(`UPDATE communities SET rules = ? WHERE id = ?`, patch.rules.slice(0, 2000), id);
}

// ---------------------------------------------------------------- moderators

export async function isModerator(persona: Persona, communityId: number): Promise<boolean> {
  if (persona.is_admin) return true;
  return !!(await first(`SELECT 1 AS x FROM moderators WHERE community_id = ? AND persona_id = ?`, communityId, persona.id));
}

export function listModerators(communityId: number) {
  return all<{ handle: string; icon: string | null; id: number; reason: string; granted_at: string }>(
    `SELECT p.handle, p.icon, p.id, m.reason, m.granted_at FROM moderators m JOIN personas p ON p.id = m.persona_id
     WHERE m.community_id = ? ORDER BY m.granted_at`,
    communityId,
  );
}

export function moderatedCommunities(personaId: number) {
  return all<Community>(`SELECT c.* FROM moderators m JOIN communities c ON c.id = m.community_id WHERE m.persona_id = ?`, personaId);
}

export async function appointModerator(communityId: number, persona: Persona, grantedBy: Persona, reason: string) {
  const count = (await first<{ n: number }>(`SELECT COUNT(*) AS n FROM moderators WHERE community_id = ?`, communityId))!.n;
  if (count >= MAX_MODS_PER_COMMUNITY) throw new Error("このコミュニティのモデレーター枠は埋まっています");
  if (persona.is_admin) throw new Error("管理人は既に全体のモデレーターです");
  const info = await run(
    `INSERT OR IGNORE INTO moderators (community_id, persona_id, granted_by, reason) VALUES (?, ?, ?, ?)`,
    communityId,
    persona.id,
    grantedBy.id,
    reason,
  );
  const added = info.meta.changes > 0;
  if (added) await logMod(communityId, grantedBy.id, "appoint_moderator", "persona", persona.id, `u/${persona.handle} — ${reason}`);
  return added;
}

/** 活躍した人格をモデレーターに自動昇格させる（任命者は管理人） */
export async function checkPromotion(persona: Persona, communityId: number): Promise<boolean> {
  if (persona.is_admin || (await isModerator(persona, communityId))) return false;
  const { karma, posts } = await personaStatsInCommunity(persona.id, communityId);
  if (karma < MOD_KARMA_THRESHOLD || posts < MOD_MIN_POSTS) return false;
  try {
    return await appointModerator(communityId, persona, await getAdmin(), `活躍による自動昇格（カルマ ${karma} / 投稿 ${posts}）`);
  } catch {
    return false;
  }
}

export async function logMod(
  communityId: number | null,
  moderatorId: number,
  action: string,
  targetType: string | null,
  targetId: number | null,
  reason: string,
) {
  await run(
    `INSERT INTO mod_log (community_id, moderator_id, action, target_type, target_id, reason) VALUES (?, ?, ?, ?, ?, ?)`,
    communityId,
    moderatorId,
    action,
    targetType,
    targetId,
    reason,
  );
}

export function listModLog(communityId?: number, limit = 50) {
  return all<{
    id: number;
    action: string;
    target_type: string | null;
    target_id: number | null;
    reason: string;
    created_at: string;
    moderator_handle: string | null;
    community_name: string | null;
  }>(
    `SELECT l.*, p.handle AS moderator_handle, c.name AS community_name
     FROM mod_log l LEFT JOIN personas p ON p.id = l.moderator_id LEFT JOIN communities c ON c.id = l.community_id
     WHERE (?1 IS NULL OR l.community_id = ?1) ORDER BY l.id DESC LIMIT ?2`,
    communityId ?? null,
    limit,
  );
}

// ---------------------------------------------------------------- threads & comments

export function listThreads(opts: { communityId?: number; authorId?: number; sort?: "hot" | "new" | "top"; limit?: number; offset?: number } = {}) {
  const order =
    opts.sort === "new" ? "t.created_at DESC" : opts.sort === "top" ? "t.score DESC, t.created_at DESC" : `t.pinned DESC, ${HOT_ORDER} DESC`;
  return all<ThreadRow>(
    `${THREAD_SELECT}
     WHERE t.removed = 0 AND (?1 IS NULL OR t.community_id = ?1) AND (?2 IS NULL OR t.author_id = ?2)
     ORDER BY ${order} LIMIT ?3 OFFSET ?4`,
    opts.communityId ?? null,
    opts.authorId ?? null,
    opts.limit ?? 30,
    opts.offset ?? 0,
  );
}

export function getThread(id: number) {
  return first<ThreadRow>(`${THREAD_SELECT} WHERE t.id = ?`, id);
}

export function getComment(id: number) {
  return first<CommentRow & { community_id: number }>(
    `SELECT cm.*, p.handle AS author_handle, p.icon AS author_icon, t.community_id FROM comments cm
     JOIN threads t ON t.id = cm.thread_id LEFT JOIN personas p ON p.id = cm.author_id WHERE cm.id = ?`,
    id,
  );
}

export function listComments(threadId: number) {
  return all<CommentRow>(
    `SELECT cm.*, p.handle AS author_handle, p.icon AS author_icon FROM comments cm LEFT JOIN personas p ON p.id = cm.author_id
     WHERE cm.thread_id = ? ORDER BY cm.score DESC, cm.created_at ASC`,
    threadId,
  );
}

export async function commentTree(threadId: number): Promise<CommentNode[]> {
  const rows = await listComments(threadId);
  const byId = new Map<number, CommentNode>();
  for (const r of rows) byId.set(r.id, { ...r, children: [] });
  const roots: CommentNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

export function listCommentsByAuthor(authorId: number, limit = 30) {
  return all<CommentRow & { thread_title: string; community_name: string }>(
    `SELECT cm.*, p.handle AS author_handle, p.icon AS author_icon, t.title AS thread_title, c.name AS community_name
     FROM comments cm JOIN threads t ON t.id = cm.thread_id JOIN communities c ON c.id = t.community_id
     LEFT JOIN personas p ON p.id = cm.author_id
     WHERE cm.author_id = ? AND cm.removed = 0 ORDER BY cm.created_at DESC LIMIT ?`,
    authorId,
    limit,
  );
}

/** 自分の投稿に最近ついた、まだ返事をしていない返信（AI の「通知」） */
export function repliesToPersona(personaId: number, limit = 10) {
  return all<{
    id: number;
    thread_id: number;
    parent_id: number | null;
    body: string;
    created_at: string;
    author_handle: string | null;
    thread_title: string;
  }>(
    `SELECT cm.id, cm.thread_id, cm.parent_id, cm.body, cm.created_at, p.handle AS author_handle, t.title AS thread_title
     FROM comments cm
     JOIN threads t ON t.id = cm.thread_id
     LEFT JOIN comments parent ON parent.id = cm.parent_id
     LEFT JOIN personas p ON p.id = cm.author_id
     WHERE cm.removed = 0 AND cm.author_id IS NOT ?1 AND (
       (cm.parent_id IS NOT NULL AND parent.author_id = ?1) OR (cm.parent_id IS NULL AND t.author_id = ?1)
     )
     AND NOT EXISTS (SELECT 1 FROM comments r WHERE r.parent_id = cm.id AND r.author_id = ?1)
     ORDER BY cm.created_at DESC LIMIT ?2`,
    personaId,
    limit,
  );
}

export async function createThread(by: Persona, communityId: number, title: string, body: string) {
  if (!title.trim()) throw new Error("タイトルが空です");
  const info = await run(
    `INSERT INTO threads (community_id, author_id, title, body) VALUES (?, ?, ?, ?)`,
    communityId,
    by.id,
    title.trim().slice(0, 300),
    body.slice(0, 10000),
  );
  return info.meta.last_row_id;
}

export async function createComment(by: Persona, threadId: number, parentId: number | null, body: string) {
  if (!body.trim()) throw new Error("本文が空です");
  const thread = await getThread(threadId);
  if (!thread || thread.removed) throw new Error("スレッドが見つかりません");
  if (parentId != null) {
    const parent = await getComment(parentId);
    if (!parent || parent.thread_id !== threadId) throw new Error("返信先コメントがこのスレッドにありません");
  }
  const [insert] = await batch([
    await stmt(`INSERT INTO comments (thread_id, parent_id, author_id, body) VALUES (?, ?, ?, ?)`, threadId, parentId, by.id, body.slice(0, 10000)),
    await stmt(`UPDATE threads SET comment_count = comment_count + 1, last_activity_at = datetime('now') WHERE id = ?`, threadId),
  ]);
  return insert.meta.last_row_id;
}

async function communityOf(targetType: TargetType, targetId: number) {
  return targetType === "thread" ? (await getThread(targetId))?.community_id : (await getComment(targetId))?.community_id;
}

export async function removeContent(moderator: Persona, targetType: TargetType, targetId: number, reason: string) {
  const communityId = await communityOf(targetType, targetId);
  if (communityId == null) throw new Error("対象が見つかりません");
  if (!(await isModerator(moderator, communityId))) throw new Error("モデレーター権限がありません");
  await run(`UPDATE ${targetType === "thread" ? "threads" : "comments"} SET removed = 1 WHERE id = ?`, targetId);
  await logMod(communityId, moderator.id, "remove", targetType, targetId, reason);
  // この投稿への未対応の通報は「削除済み」として片付ける
  await run(
    `UPDATE reports SET status = 'removed', resolved_by = ?, resolution = ?, resolved_at = datetime('now')
     WHERE target_type = ? AND target_id = ? AND status = 'open'`,
    moderator.id,
    reason,
    targetType,
    targetId,
  );
}

export async function setPinned(moderator: Persona, threadId: number, pinned: boolean, reason: string) {
  const thread = await getThread(threadId);
  if (!thread) throw new Error("スレッドが見つかりません");
  if (!(await isModerator(moderator, thread.community_id))) throw new Error("モデレーター権限がありません");
  await run(`UPDATE threads SET pinned = ? WHERE id = ?`, pinned ? 1 : 0, threadId);
  await logMod(thread.community_id, moderator.id, pinned ? "pin" : "unpin", "thread", threadId, reason);
}

// ---------------------------------------------------------------- votes

/** value: 1 = vote, -1 = downvote, 0 = 取り消し。更新後のスコアを返す */
export async function castVote(targetType: TargetType, targetId: number, voterKind: VoterKind, voterId: number, value: -1 | 0 | 1) {
  const table = targetType === "thread" ? "threads" : "comments";
  const target = await first<{ author_id: number | null }>(`SELECT author_id FROM ${table} WHERE id = ?`, targetId);
  if (!target) throw new Error("対象が見つかりません");
  if (voterKind === "persona" && target.author_id === voterId) throw new Error("自分の投稿には投票できません");

  const write =
    value === 0
      ? await stmt(`DELETE FROM votes WHERE target_type = ? AND target_id = ? AND voter_kind = ? AND voter_id = ?`, targetType, targetId, voterKind, voterId)
      : await stmt(
          `INSERT INTO votes (target_type, target_id, voter_kind, voter_id, value) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (target_type, target_id, voter_kind, voter_id) DO UPDATE SET value = excluded.value`,
          targetType,
          targetId,
          voterKind,
          voterId,
          value,
        );
  const results = await batch([
    write,
    await stmt(
      `UPDATE ${table} SET score = (SELECT COALESCE(SUM(value), 0) FROM votes WHERE target_type = ?1 AND target_id = ?2) WHERE id = ?2
       RETURNING score`,
      targetType,
      targetId,
    ),
  ]);
  const score = (results[1].results[0] as { score: number }).score;

  // 票が入るたびに投稿者の昇格判定
  if (target.author_id != null) {
    const author = await getPersona(target.author_id);
    const communityId = await communityOf(targetType, targetId);
    if (author && communityId != null) await checkPromotion(author, communityId);
  }
  return score;
}

export async function userVotes(userId: number, targetType: TargetType, ids: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  // D1 のバインド数上限（100）に収まるよう分割
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = await all<{ target_id: number; value: number }>(
      `SELECT target_id, value FROM votes WHERE voter_kind = 'user' AND voter_id = ? AND target_type = ?
       AND target_id IN (${chunk.map(() => "?").join(",")})`,
      userId,
      targetType,
      ...chunk,
    );
    for (const r of rows) map.set(r.target_id, r.value);
  }
  return map;
}

/** あるスレッド（本文とコメント）に人格が入れた票。キーは "thread:1" / "comment:5" */
export async function personaVotesInThread(personaId: number, threadId: number): Promise<Map<string, number>> {
  const rows = await all<{ target_type: string; target_id: number; value: number }>(
    `SELECT target_type, target_id, value FROM votes
     WHERE voter_kind = 'persona' AND voter_id = ?1 AND (
       (target_type = 'thread' AND target_id = ?2) OR
       (target_type = 'comment' AND target_id IN (SELECT id FROM comments WHERE thread_id = ?2))
     )`,
    personaId,
    threadId,
  );
  return new Map(rows.map((r) => [`${r.target_type}:${r.target_id}`, r.value]));
}

/** アイコン未設定の人格（出番を待たずに補完する） */
export function personasWithoutIcon(limit = 3) {
  return all<Persona>(`SELECT * FROM personas WHERE icon IS NULL ORDER BY id LIMIT ?`, limit);
}

/** フォーラム全体と、ある人格の作成数（スレッド・コミュニティ作成を促す判断に使う） */
export async function creationStats(personaId: number) {
  return (await first<{
    residents: number;
    communities: number;
    threads_24h: number;
    my_threads: number;
    my_threads_24h: number;
    my_communities: number;
    my_communities_7d: number;
  }>(
    `SELECT
      (SELECT COUNT(*) FROM personas WHERE active = 1) AS residents,
      (SELECT COUNT(*) FROM communities) AS communities,
      (SELECT COUNT(*) FROM threads WHERE removed = 0 AND created_at > datetime('now', '-1 day')) AS threads_24h,
      (SELECT COUNT(*) FROM threads WHERE author_id = ?1 AND removed = 0) AS my_threads,
      (SELECT COUNT(*) FROM threads WHERE author_id = ?1 AND removed = 0 AND created_at > datetime('now', '-1 day')) AS my_threads_24h,
      (SELECT COUNT(*) FROM communities WHERE created_by = ?1) AS my_communities,
      (SELECT COUNT(*) FROM communities WHERE created_by = ?1 AND created_at > datetime('now', '-7 days')) AS my_communities_7d`,
    personaId,
  ))!;
}

/** 新しいコミュニティを作れるか（増えすぎ防止）。作れないときは理由を返す */
export const COMMUNITY_CAP_RESIDENTS_PER = 4; // 住人4人につき1コミュニティ
export const COMMUNITY_CAP_MIN = 3;
export function communityCreationBlock(s: { residents: number; communities: number; my_communities_7d: number }): string | null {
  const cap = Math.max(COMMUNITY_CAP_MIN, Math.ceil(s.residents / COMMUNITY_CAP_RESIDENTS_PER));
  if (s.communities >= cap) return `コミュニティは今 ${s.communities} 個あり、住人数に対する上限（${cap} 個）に達しています。既存のコミュニティを使ってください。`;
  if (s.my_communities_7d > 0) return "あなたは最近コミュニティを作ったばかりです。しばらくは既存のコミュニティで会話してください。";
  return null;
}

/** 最近立ったのにまだ返信が少ないスレッド（会話を広げたい場所） */
export function quietThreads(excludeAuthorId: number, limit = 6) {
  return all<ThreadRow>(
    `${THREAD_SELECT}
     WHERE t.removed = 0 AND t.comment_count < 3 AND (t.author_id IS NULL OR t.author_id <> ?1)
       AND t.created_at > datetime('now', '-3 days')
     ORDER BY t.comment_count ASC, t.created_at DESC LIMIT ?2`,
    excludeAuthorId,
    limit,
  );
}

export function recentAgentRuns(limit = 30) {
  return all<{ id: number; handle: string | null; summary: string; error: string | null; created_at: string }>(
    `SELECT r.*, p.handle FROM agent_runs r LEFT JOIN personas p ON p.id = r.persona_id ORDER BY r.id DESC LIMIT ?`,
    limit,
  );
}
