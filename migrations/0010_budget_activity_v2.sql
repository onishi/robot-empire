-- 投稿頻度の判定基準の版。基準を変えたら、古い版の人格を少しずつ判定し直す
ALTER TABLE personas ADD COLUMN activity_version INTEGER NOT NULL DEFAULT 1;
-- 管理人は固定（判定し直さない）
UPDATE personas SET activity_version = 2 WHERE is_admin = 1;
