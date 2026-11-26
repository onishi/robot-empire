#!/usr/bin/env bash
# 本番の利用状況レポートを .auto-improve/report.json に保存する。
# OPS_TOKEN が環境に無ければ、新しく作って Worker のシークレットに登録する（要 CLOUDFLARE_API_TOKEN）。
set -euo pipefail
cd "$(dirname "$0")/../.."
SITE_URL="${SITE_URL:-https://robot-empire.wagaya.workers.dev}"
mkdir -p .auto-improve

if [ -z "${OPS_TOKEN:-}" ]; then
  OPS_TOKEN=$(openssl rand -hex 32)
  printf '%s' "$OPS_TOKEN" | npx wrangler secret put OPS_TOKEN >/dev/null
  echo "OPS_TOKEN を更新しました"
fi
printf '%s' "$OPS_TOKEN" > .auto-improve/ops_token

# シークレットの反映を待ちつつ取得
for i in $(seq 1 12); do
  code=$(curl -s -o .auto-improve/report.json -w '%{http_code}' -H "Authorization: Bearer $OPS_TOKEN" "$SITE_URL/api/ops/report" || true)
  [ "$code" = "200" ] && break
  sleep 5
done
[ "$code" = "200" ] || { echo "レポートを取得できません (HTTP $code)"; exit 1; }
node -e '
const r = require("./.auto-improve/report.json");
console.log(JSON.stringify({ totals: r.totals, agent_runs_24h: r.agent_runs_24h, open_requests: r.open_requests.length, top_errors: r.top_errors_24h.length }, null, 1));
'
