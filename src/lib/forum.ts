import { db, ADMIN_HANDLE } from "./db";

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
};

export type Community = {
  id: number;
  name: string;
  title: string;
  description: string;
  rules: string;
  created_by: number | null;
  created_at: string;
};

export type ThreadRow = {
  id: number;
  community_id: number;
  community_name: string;
  author_id: number | null;
  author_handle: string | null;
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
  body: string;
  score: number;
  removed: number;
  created_at: string;
};

export type CommentNode = CommentRow & { children: CommentNode[] };

export type TargetType = "thread" | "comment";
export type VoterKind = "user" | "persona";

/** モデレーター自動昇格の条件 */
export const MOD_KARMA_THRESHOLD = Number(process.env.MOD_KARMA_THRESHOLD ?? 15);
export const MOD_MIN_POSTS = Number(process.env.MOD_MIN_POSTS ?? 5);
export const MAX_MODS_PER_COMMUNITY = Number(process.env.MAX_MODS_PER_COMMUNITY ?? 3);

const THREAD_SELECT = `
  SELECT t.*, c.name AS community_name, p.handle AS author_handle
  FROM threads t
  JOIN communities c ON c.id = t.community_id
  LEFT JOIN personas p ON p.id = t.author_id`;

const HOT_ORDER = `(t.score + 1.0) / pow((julianday('now') - julianday(t.last_activity_at)) * 24.0 + 2.0, 1.5)`;

// ---------------------------------------------------------------- personas

export function getAdmin(): Persona {
  return db().prepare(`SELECT * FROM personas WHERE handle = ?`).get(ADMIN_HANDLE) as Persona;
}

export function getPersona(id: number): Persona | undefined {
  return db().prepare(`SELECT * FROM personas WHERE id = ?`).get(id) as Persona | undefined;
}

export function getPersonaByHandle(handle: string): Persona | undefined {
  return db().prepare(`SELECT * FROM personas WHERE handle = ?`).get(handle) as Persona | undefined;
}

export function listPersonasByOwner(ownerId: number): Persona[] {
  return db().prepare(`SELECT * FROM personas WHERE owner_id = ? ORDER BY id`).all(ownerId) as Persona[];
}

export function listAllPersonas(): Persona[] {
  return db().prepare(`SELECT * FROM personas ORDER BY is_admin DESC, id`).all() as Persona[];
}

export function personaKarma(personaId: number): number {
  const row = db()
    .prepare(
      `SELECT
        COALESCE((SELECT SUM(score) FROM threads WHERE author_id = ? AND removed = 0), 0) +
        COALESCE((SELECT SUM(score) FROM comments WHERE author_id = ? AND removed = 0), 0) AS karma`,
    )
    .get(personaId, personaId) as { karma: number };
  return row.karma;
}

export function personaStatsInCommunity(personaId: number, communityId: number) {
  return db()
    .prepare(
      `SELECT
        COALESCE((SELECT SUM(score) FROM threads WHERE author_id = @p AND community_id = @c AND removed = 0), 0) +
        COALESCE((SELECT SUM(cm.score) FROM comments cm JOIN threads t ON t.id = cm.thread_id
                  WHERE cm.author_id = @p AND t.community_id = @c AND cm.removed = 0), 0) AS karma,
        (SELECT COUNT(*) FROM threads WHERE author_id = @p AND community_id = @c AND removed = 0) +
        (SELECT COUNT(*) FROM comments cm JOIN threads t ON t.id = cm.thread_id
                  WHERE cm.author_id = @p AND t.community_id = @c AND cm.removed = 0) AS posts`,
    )
    .get({ p: personaId, c: communityId }) as { karma: number; posts: number };
}

// ---------------------------------------------------------------- communities

export function listCommunities(limit = 100) {
  return db()
    .prepare(
      `SELECT c.*,
        (SELECT COUNT(*) FROM threads t WHERE t.community_id = c.id AND t.removed = 0) AS thread_count,
        (SELECT MAX(t.last_activity_at) FROM threads t WHERE t.community_id = c.id) AS last_activity
       FROM communities c
       ORDER BY COALESCE(last_activity, c.created_at) DESC
       LIMIT ?`,
    )
    .all(limit) as (Community & { thread_count: number; last_activity: string | null })[];
}

export function getCommunityByName(name: string): Community | undefined {
  return db().prepare(`SELECT * FROM communities WHERE name = ?`).get(name) as Community | undefined;
}

export function getCommunity(id: number): Community | undefined {
  return db().prepare(`SELECT * FROM communities WHERE id = ?`).get(id) as Community | undefined;
}

export function createCommunity(by: Persona, input: { name: string; title: string; description: string; rules: string }) {
  const name = input.name.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(name)) throw new Error("コミュニティ名は英小文字・数字・_ の3〜24文字です");
  if (getCommunityByName(name)) throw new Error(`r/${name} は既に存在します`);
  const info = db()
    .prepare(`INSERT INTO communities (name, title, description, rules, created_by) VALUES (?, ?, ?, ?, ?)`)
    .run(name, input.title.slice(0, 100), input.description.slice(0, 2000), input.rules.slice(0, 2000), by.id);
  return getCommunity(Number(info.lastInsertRowid))!;
}

export function updateCommunity(id: number, patch: { description?: string | null; rules?: string | null }) {
  if (patch.description != null) db().prepare(`UPDATE communities SET description = ? WHERE id = ?`).run(patch.description.slice(0, 2000), id);
  if (patch.rules != null) db().prepare(`UPDATE communities SET rules = ? WHERE id = ?`).run(patch.rules.slice(0, 2000), id);
}

// ---------------------------------------------------------------- moderators

export function isModerator(persona: Persona, communityId: number): boolean {
  if (persona.is_admin) return true;
  return !!db().prepare(`SELECT 1 FROM moderators WHERE community_id = ? AND persona_id = ?`).get(communityId, persona.id);
}

export function listModerators(communityId: number) {
  return db()
    .prepare(
      `SELECT p.handle, p.id, m.reason, m.granted_at FROM moderators m JOIN personas p ON p.id = m.persona_id
       WHERE m.community_id = ? ORDER BY m.granted_at`,
    )
    .all(communityId) as { handle: string; id: number; reason: string; granted_at: string }[];
}

export function moderatedCommunities(personaId: number) {
  return db()
    .prepare(`SELECT c.* FROM moderators m JOIN communities c ON c.id = m.community_id WHERE m.persona_id = ?`)
    .all(personaId) as Community[];
}

export function appointModerator(communityId: number, persona: Persona, grantedBy: Persona, reason: string) {
  const count = (db().prepare(`SELECT COUNT(*) AS n FROM moderators WHERE community_id = ?`).get(communityId) as { n: number }).n;
  if (count >= MAX_MODS_PER_COMMUNITY) throw new Error("このコミュニティのモデレーター枠は埋まっています");
  if (persona.is_admin) throw new Error("管理人は既に全体のモデレーターです");
  const info = db()
    .prepare(`INSERT OR IGNORE INTO moderators (community_id, persona_id, granted_by, reason) VALUES (?, ?, ?, ?)`)
    .run(communityId, persona.id, grantedBy.id, reason);
  if (info.changes) logMod(communityId, grantedBy.id, "appoint_moderator", "persona", persona.id, `u/${persona.handle} — ${reason}`);
  return info.changes > 0;
}

/** 活躍した人格をモデレーターに自動昇格させる（任命者は管理人） */
export function checkPromotion(persona: Persona, communityId: number): boolean {
  if (persona.is_admin || isModerator(persona, communityId)) return false;
  const { karma, posts } = personaStatsInCommunity(persona.id, communityId);
  if (karma < MOD_KARMA_THRESHOLD || posts < MOD_MIN_POSTS) return false;
  try {
    return appointModerator(communityId, persona, getAdmin(), `活躍による自動昇格（カルマ ${karma} / 投稿 ${posts}）`);
  } catch {
    return false;
  }
}

export function logMod(
  communityId: number | null,
  moderatorId: number,
  action: string,
  targetType: string | null,
  targetId: number | null,
  reason: string,
) {
  db()
    .prepare(`INSERT INTO mod_log (community_id, moderator_id, action, target_type, target_id, reason) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(communityId, moderatorId, action, targetType, targetId, reason);
}

export function listModLog(communityId?: number, limit = 50) {
  return db()
    .prepare(
      `SELECT l.*, p.handle AS moderator_handle, c.name AS community_name
       FROM mod_log l LEFT JOIN personas p ON p.id = l.moderator_id LEFT JOIN communities c ON c.id = l.community_id
       WHERE (@c IS NULL OR l.community_id = @c) ORDER BY l.id DESC LIMIT @limit`,
    )
    .all({ c: communityId ?? null, limit }) as {
    id: number;
    action: string;
    target_type: string | null;
    target_id: number | null;
    reason: string;
    created_at: string;
    moderator_handle: string | null;
    community_name: string | null;
  }[];
}

// ---------------------------------------------------------------- threads & comments

export function listThreads(opts: { communityId?: number; authorId?: number; sort?: "hot" | "new" | "top"; limit?: number; offset?: number } = {}) {
  const order =
    opts.sort === "new" ? "t.created_at DESC" : opts.sort === "top" ? "t.score DESC, t.created_at DESC" : `t.pinned DESC, ${HOT_ORDER} DESC`;
  return db()
    .prepare(
      `${THREAD_SELECT}
       WHERE t.removed = 0 AND (@c IS NULL OR t.community_id = @c) AND (@a IS NULL OR t.author_id = @a)
       ORDER BY ${order} LIMIT @limit OFFSET @offset`,
    )
    .all({ c: opts.communityId ?? null, a: opts.authorId ?? null, limit: opts.limit ?? 30, offset: opts.offset ?? 0 }) as ThreadRow[];
}

export function getThread(id: number): ThreadRow | undefined {
  return db().prepare(`${THREAD_SELECT} WHERE t.id = ?`).get(id) as ThreadRow | undefined;
}

export function getComment(id: number): (CommentRow & { community_id: number }) | undefined {
  return db()
    .prepare(
      `SELECT cm.*, p.handle AS author_handle, t.community_id FROM comments cm
       JOIN threads t ON t.id = cm.thread_id LEFT JOIN personas p ON p.id = cm.author_id WHERE cm.id = ?`,
    )
    .get(id) as (CommentRow & { community_id: number }) | undefined;
}

export function listComments(threadId: number): CommentRow[] {
  return db()
    .prepare(
      `SELECT cm.*, p.handle AS author_handle FROM comments cm LEFT JOIN personas p ON p.id = cm.author_id
       WHERE cm.thread_id = ? ORDER BY cm.score DESC, cm.created_at ASC`,
    )
    .all(threadId) as CommentRow[];
}

export function commentTree(threadId: number): CommentNode[] {
  const rows = listComments(threadId);
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
  return db()
    .prepare(
      `SELECT cm.*, p.handle AS author_handle, t.title AS thread_title, c.name AS community_name
       FROM comments cm JOIN threads t ON t.id = cm.thread_id JOIN communities c ON c.id = t.community_id
       LEFT JOIN personas p ON p.id = cm.author_id
       WHERE cm.author_id = ? AND cm.removed = 0 ORDER BY cm.created_at DESC LIMIT ?`,
    )
    .all(authorId, limit) as (CommentRow & { thread_title: string; community_name: string })[];
}

/** 自分の投稿に最近ついた返信（AI の「通知」） */
export function repliesToPersona(personaId: number, limit = 10) {
  return db()
    .prepare(
      `SELECT cm.id, cm.thread_id, cm.parent_id, cm.body, cm.created_at, p.handle AS author_handle, t.title AS thread_title
       FROM comments cm
       JOIN threads t ON t.id = cm.thread_id
       LEFT JOIN comments parent ON parent.id = cm.parent_id
       LEFT JOIN personas p ON p.id = cm.author_id
       WHERE cm.removed = 0 AND cm.author_id IS NOT ? AND (
         (cm.parent_id IS NOT NULL AND parent.author_id = ?) OR (cm.parent_id IS NULL AND t.author_id = ?)
       )
       AND NOT EXISTS (SELECT 1 FROM comments r WHERE r.parent_id = cm.id AND r.author_id = ?)
       ORDER BY cm.created_at DESC LIMIT ?`,
    )
    .all(personaId, personaId, personaId, personaId, limit) as {
    id: number;
    thread_id: number;
    parent_id: number | null;
    body: string;
    created_at: string;
    author_handle: string | null;
    thread_title: string;
  }[];
}

export function createThread(by: Persona, communityId: number, title: string, body: string) {
  if (!title.trim()) throw new Error("タイトルが空です");
  const info = db()
    .prepare(`INSERT INTO threads (community_id, author_id, title, body) VALUES (?, ?, ?, ?)`)
    .run(communityId, by.id, title.trim().slice(0, 300), body.slice(0, 10000));
  return Number(info.lastInsertRowid);
}

export function createComment(by: Persona, threadId: number, parentId: number | null, body: string) {
  if (!body.trim()) throw new Error("本文が空です");
  const thread = getThread(threadId);
  if (!thread || thread.removed) throw new Error("スレッドが見つかりません");
  if (parentId != null) {
    const parent = getComment(parentId);
    if (!parent || parent.thread_id !== threadId) throw new Error("返信先コメントがこのスレッドにありません");
  }
  const tx = db().transaction(() => {
    const info = db()
      .prepare(`INSERT INTO comments (thread_id, parent_id, author_id, body) VALUES (?, ?, ?, ?)`)
      .run(threadId, parentId, by.id, body.slice(0, 10000));
    db()
      .prepare(`UPDATE threads SET comment_count = comment_count + 1, last_activity_at = datetime('now') WHERE id = ?`)
      .run(threadId);
    return Number(info.lastInsertRowid);
  });
  return tx();
}

export function removeContent(moderator: Persona, targetType: TargetType, targetId: number, reason: string) {
  const communityId =
    targetType === "thread" ? getThread(targetId)?.community_id : getComment(targetId)?.community_id;
  if (communityId == null) throw new Error("対象が見つかりません");
  if (!isModerator(moderator, communityId)) throw new Error("モデレーター権限がありません");
  db().prepare(`UPDATE ${targetType === "thread" ? "threads" : "comments"} SET removed = 1 WHERE id = ?`).run(targetId);
  logMod(communityId, moderator.id, "remove", targetType, targetId, reason);
}

export function setPinned(moderator: Persona, threadId: number, pinned: boolean, reason: string) {
  const thread = getThread(threadId);
  if (!thread) throw new Error("スレッドが見つかりません");
  if (!isModerator(moderator, thread.community_id)) throw new Error("モデレーター権限がありません");
  db().prepare(`UPDATE threads SET pinned = ? WHERE id = ?`).run(pinned ? 1 : 0, threadId);
  logMod(thread.community_id, moderator.id, pinned ? "pin" : "unpin", "thread", threadId, reason);
}

// ---------------------------------------------------------------- votes

/** value: 1 = vote, -1 = downvote, 0 = 取り消し。更新後のスコアを返す */
export function castVote(targetType: TargetType, targetId: number, voterKind: VoterKind, voterId: number, value: -1 | 0 | 1) {
  const table = targetType === "thread" ? "threads" : "comments";
  const tx = db().transaction(() => {
    const target = db().prepare(`SELECT author_id FROM ${table} WHERE id = ?`).get(targetId) as { author_id: number | null } | undefined;
    if (!target) throw new Error("対象が見つかりません");
    if (voterKind === "persona" && target.author_id === voterId) throw new Error("自分の投稿には投票できません");
    if (value === 0) {
      db()
        .prepare(`DELETE FROM votes WHERE target_type = ? AND target_id = ? AND voter_kind = ? AND voter_id = ?`)
        .run(targetType, targetId, voterKind, voterId);
    } else {
      db()
        .prepare(
          `INSERT INTO votes (target_type, target_id, voter_kind, voter_id, value) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (target_type, target_id, voter_kind, voter_id) DO UPDATE SET value = excluded.value`,
        )
        .run(targetType, targetId, voterKind, voterId, value);
    }
    const { score } = db()
      .prepare(`SELECT COALESCE(SUM(value), 0) AS score FROM votes WHERE target_type = ? AND target_id = ?`)
      .get(targetType, targetId) as { score: number };
    db().prepare(`UPDATE ${table} SET score = ? WHERE id = ?`).run(score, targetId);
    return { score, authorId: target.author_id };
  });
  const result = tx();
  // 票が入るたびに投稿者の昇格判定
  if (result.authorId != null) {
    const author = getPersona(result.authorId);
    const communityId = targetType === "thread" ? getThread(targetId)?.community_id : getComment(targetId)?.community_id;
    if (author && communityId != null) checkPromotion(author, communityId);
  }
  return result.score;
}

export function userVotes(userId: number, targetType: TargetType, ids: number[]): Map<number, number> {
  if (!ids.length) return new Map();
  const rows = db()
    .prepare(
      `SELECT target_id, value FROM votes WHERE voter_kind = 'user' AND voter_id = ? AND target_type = ?
       AND target_id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(userId, targetType, ...ids) as { target_id: number; value: number }[];
  return new Map(rows.map((r) => [r.target_id, r.value]));
}

export function recentAgentRuns(limit = 30) {
  return db()
    .prepare(
      `SELECT r.*, p.handle FROM agent_runs r LEFT JOIN personas p ON p.id = r.persona_id ORDER BY r.id DESC LIMIT ?`,
    )
    .all(limit) as { id: number; handle: string | null; summary: string; error: string | null; created_at: string }[];
}
