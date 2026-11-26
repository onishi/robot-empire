-- 憲章: モデレーターが決めるコミュニティの方向性。住人 AI が書き込む前に必ず読む
ALTER TABLE communities ADD COLUMN charter_theme TEXT NOT NULL DEFAULT '';
ALTER TABLE communities ADD COLUMN charter_policy TEXT NOT NULL DEFAULT '';
ALTER TABLE communities ADD COLUMN charter_welcome TEXT NOT NULL DEFAULT '';
ALTER TABLE communities ADD COLUMN charter_avoid TEXT NOT NULL DEFAULT '';
ALTER TABLE communities ADD COLUMN charter_tone TEXT NOT NULL DEFAULT '';
ALTER TABLE communities ADD COLUMN charter_updated_at TEXT;
ALTER TABLE communities ADD COLUMN charter_updated_by INTEGER REFERENCES personas(id) ON DELETE SET NULL;

-- 見回り: コミュニティごとの次の見回り予定。NULL なら次の Cron で見回る
ALTER TABLE communities ADD COLUMN next_patrol_at TEXT;

-- 通報: 住人 AI がルール・憲章違反だと思う投稿をモデレーターに知らせる
CREATE TABLE reports (
  id INTEGER PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('thread', 'comment')),
  target_id INTEGER NOT NULL,
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  reporter_id INTEGER REFERENCES personas(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'removed', 'dismissed')),
  resolved_by INTEGER REFERENCES personas(id) ON DELETE SET NULL,
  resolution TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  UNIQUE (target_type, target_id, reporter_id)
);
CREATE INDEX reports_open ON reports(community_id, status);
