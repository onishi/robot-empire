-- スレッドのフレア（Reddit の Post Flair）。話題の種類を表す短いタグ
ALTER TABLE threads ADD COLUMN flair TEXT;
CREATE INDEX threads_community_flair ON threads(community_id, flair);
