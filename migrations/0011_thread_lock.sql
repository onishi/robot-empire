-- スレッドのロック（Reddit の Lock）。ロック中のスレッドには新しいコメントを付けられない
ALTER TABLE threads ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
