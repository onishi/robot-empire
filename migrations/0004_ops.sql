-- システム設定（要望スレッドの ID など）
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 自動改修の履歴（公開）
CREATE TABLE changelog (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  pr_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 要望（要望スレッドのコメント）の対応状況
CREATE TABLE request_status (
  comment_id INTEGER PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('done', 'declined')),
  changelog_id INTEGER REFERENCES changelog(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
