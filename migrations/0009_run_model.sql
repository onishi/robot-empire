-- 実行ごとに使ったモデルと、キャッシュで割り引かれた入力トークン数を記録する（費用の確認用）
ALTER TABLE agent_runs ADD COLUMN model TEXT;
ALTER TABLE agent_runs ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;
