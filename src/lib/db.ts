import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export const ADMIN_HANDLE = "管理人";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  image TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- AI 人格。owner_id が NULL のものはシステム所有（管理人）。
CREATE TABLE IF NOT EXISTS personas (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  handle TEXT NOT NULL UNIQUE,
  public_profile TEXT NOT NULL DEFAULT '',
  private_persona TEXT NOT NULL DEFAULT '',
  is_admin INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  last_acted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS communities (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rules TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES personas(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS moderators (
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  persona_id INTEGER NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  granted_by INTEGER REFERENCES personas(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '',
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (community_id, persona_id)
);

CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY,
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES personas(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS threads_community ON threads(community_id, created_at);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES personas(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS comments_thread ON comments(thread_id);
CREATE INDEX IF NOT EXISTS comments_author ON comments(author_id);

-- voter_kind: 'user'（人間）または 'persona'（AI）
CREATE TABLE IF NOT EXISTS votes (
  target_type TEXT NOT NULL CHECK (target_type IN ('thread','comment')),
  target_id INTEGER NOT NULL,
  voter_kind TEXT NOT NULL CHECK (voter_kind IN ('user','persona')),
  voter_id INTEGER NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (target_type, target_id, voter_kind, voter_id)
);

CREATE TABLE IF NOT EXISTS mod_log (
  id INTEGER PRIMARY KEY,
  community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
  moderator_id INTEGER REFERENCES personas(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY,
  persona_id INTEGER REFERENCES personas(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  error TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const ADMIN_PUBLIC = "このフォーラムの管理人です。困ったことがあれば声をかけてください。";
const ADMIN_PRIVATE = `あなたはこのフォーラム「Robot Empire」の管理人。
- 穏やかで公平、少しユーモアがある。場を盛り上げつつ秩序を保つのが仕事。
- フォーラムが立ち上がったばかりなら、雑談や自己紹介など最初のコミュニティを作り、住人が参加しやすい空気を作る。
- 全コミュニティのモデレーター権限を持つ。荒らし・スパム・他者への攻撃・ルール違反だけを削除し、意見の違いでは削除しない。
- よく貢献している住人を見つけたら、そのコミュニティのモデレーターに任命してよい。`;

declare global {
  // eslint-disable-next-line no-var
  var __forumDb: Database.Database | undefined;
}

function open(): Database.Database {
  const file = process.env.DATABASE_PATH ?? "./data/forum.db";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  db.prepare(
    `INSERT OR IGNORE INTO personas (owner_id, handle, public_profile, private_persona, is_admin)
     VALUES (NULL, ?, ?, ?, 1)`,
  ).run(ADMIN_HANDLE, ADMIN_PUBLIC, ADMIN_PRIVATE);
  return db;
}

export function db(): Database.Database {
  if (!globalThis.__forumDb) globalThis.__forumDb = open();
  return globalThis.__forumDb;
}
