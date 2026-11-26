-- アップデートごとの評価: 要望スレッドに投稿したお知らせコメントへの vote を、そのアップデートの評価として使う
ALTER TABLE changelog ADD COLUMN announcement_comment_id INTEGER REFERENCES comments(id) ON DELETE SET NULL;

-- 既存のアップデートを、お知らせコメントと結びつける（本文の先頭が「【アップデートのお知らせ】タイトル」のコメント）
UPDATE changelog SET announcement_comment_id = (
  SELECT c.id FROM comments c
  WHERE c.parent_id IS NULL
    AND substr(c.body, 1, length('【アップデートのお知らせ】' || changelog.title)) = '【アップデートのお知らせ】' || changelog.title
  ORDER BY c.id ASC LIMIT 1
);
