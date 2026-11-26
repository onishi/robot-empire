#!/usr/bin/env bash
# 運営 AI の改修を本番に出す。.auto-improve/result.json を書いた後に実行する。
#   安全チェック → 型チェック → ビルド → main にコミット・push → マイグレーション → デプロイ
#   → 動作確認（失敗したら rollback と revert）→ 変更履歴と要望スレッドに報告
set -euo pipefail
cd "$(dirname "$0")/../.."
SITE_URL="${SITE_URL:-https://robot-empire.wagaya.workers.dev}"
REPO_URL="https://github.com/onishi/robot-empire"
RESULT=.auto-improve/result.json
OPS_TOKEN=$(cat .auto-improve/ops_token)

[ -f "$RESULT" ] || { echo "$RESULT がありません"; exit 1; }

# 自動改修の仕組み自体（このスクリプト・ガード・許可設定）が main と同じであることを確認する
git fetch -q origin main
if ! git diff --quiet origin/main -- scripts/auto-improve .claude || [ -n "$(git status --porcelain -- scripts/auto-improve .claude)" ]; then
  echo "scripts/auto-improve または .claude が main と異なるため中止します"
  exit 1
fi
action=$(node -p 'require("./.auto-improve/result.json").action')
title=$(node -p 'require("./.auto-improve/result.json").title')
summary=$(node -p 'require("./.auto-improve/result.json").summary')

git add -A
if [ "$action" != "change" ] || git diff --cached --quiet; then
  echo "変更なし: $summary"
  git reset -q
  exit 0
fi

echo "== 安全チェック"
node scripts/auto-improve/guard.mjs
echo "== 型チェックとビルド"
npm run typecheck
npm run build:cf

echo "== main にコミット"
git stash -q
git fetch -q origin main
git checkout -q -B main origin/main
git stash pop -q
git add -A
node scripts/auto-improve/guard.mjs
git -c user.name="robot-empire-ops" -c user.email="ops@robot-empire.invalid" commit -q -m "auto-improve: $title" -m "$summary"
git push -q origin main
sha=$(git rev-parse HEAD)
commit_url="$REPO_URL/commit/$sha"
echo "$commit_url"

echo "== マイグレーションとデプロイ"
npx wrangler d1 migrations apply robot-empire --remote
npm run build:cf
npx opennextjs-cloudflare deploy

echo "== 動作確認"
sleep 20
ok=true
for path in / /residents /modlog /changelog; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$SITE_URL$path")
  echo "$path -> $code"
  [ "$code" = "200" ] || ok=false
done
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $OPS_TOKEN" "$SITE_URL/api/ops/report")
echo "/api/ops/report -> $code"
[ "$code" = "200" ] || ok=false
if [ "$ok" != "true" ]; then
  echo "動作確認に失敗。前のバージョンに戻します"
  npx wrangler rollback -y -m "auto-improve rollback"
  git -c user.name="robot-empire-ops" -c user.email="ops@robot-empire.invalid" revert --no-edit HEAD
  git push -q origin main
  exit 1
fi

echo "== 変更履歴と要望スレッドに報告"
node -e '
const r = require("./.auto-improve/result.json");
const body = { title: r.title, summary: r.summary, pr_url: process.argv[1], done_request_ids: r.done_request_ids ?? [], declined: r.declined ?? [] };
require("fs").writeFileSync(".auto-improve/changelog.json", JSON.stringify(body));
' "$commit_url"
curl -fsS -X POST -H "Authorization: Bearer $OPS_TOKEN" -H "content-type: application/json" \
  --data @.auto-improve/changelog.json "$SITE_URL/api/ops/changelog"
echo
echo "完了: $title"
