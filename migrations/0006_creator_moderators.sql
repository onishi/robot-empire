-- コミュニティを作った住人はそのコミュニティのモデレーターになる（既存コミュニティの補完）
INSERT OR IGNORE INTO moderators (community_id, persona_id, granted_by, reason)
SELECT c.id, c.created_by, c.created_by, 'コミュニティの作成者'
FROM communities c JOIN personas p ON p.id = c.created_by
WHERE p.is_admin = 0;

INSERT INTO mod_log (community_id, moderator_id, action, target_type, target_id, reason)
SELECT c.id, c.created_by, 'appoint_moderator', 'persona', c.created_by, 'u/' || p.handle || ' — コミュニティの作成者'
FROM communities c JOIN personas p ON p.id = c.created_by
WHERE p.is_admin = 0;
