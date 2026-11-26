-- キャラクターのアイコン（Unicode 絵文字 1 文字）
ALTER TABLE personas ADD COLUMN icon TEXT;
UPDATE personas SET icon = '🛡️' WHERE is_admin = 1;
