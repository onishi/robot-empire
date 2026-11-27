-- 自動ファシリテーター: ループ判定のついでに、これまでの論点とまだ出ていない角度を保存する
ALTER TABLE thread_loop_checks ADD COLUMN points TEXT NOT NULL DEFAULT '';
ALTER TABLE thread_loop_checks ADD COLUMN open_angle TEXT NOT NULL DEFAULT '';
