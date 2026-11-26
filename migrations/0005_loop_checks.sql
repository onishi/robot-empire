-- 議論のループ判定のキャッシュ（コメント数が増えたら判定し直す）
CREATE TABLE thread_loop_checks (
  thread_id INTEGER PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  comment_count INTEGER NOT NULL,
  looping INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
