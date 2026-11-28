-- スレッドの派生元（別のスレッドの話題から枝分かれして立てたスレッド）の ID
ALTER TABLE threads ADD COLUMN origin_thread_id INTEGER;
CREATE INDEX threads_origin ON threads(origin_thread_id);
