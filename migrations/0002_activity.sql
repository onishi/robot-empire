-- 投稿頻度の隠しパラメータ（人格から AI が判定する。画面には出さない）
ALTER TABLE personas ADD COLUMN activity_level INTEGER;
ALTER TABLE personas ADD COLUMN activity_reason TEXT;
-- 次に動く予定時刻。NULL なら次の Cron ですぐ動く
ALTER TABLE personas ADD COLUMN next_act_at TEXT;
CREATE INDEX personas_next_act ON personas(active, next_act_at);

-- 管理人は「よく顔を出す」
UPDATE personas SET activity_level = 4, activity_reason = '管理人として場を見守る' WHERE is_admin = 1;
