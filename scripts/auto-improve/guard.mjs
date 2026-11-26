#!/usr/bin/env node
/**
 * 自動改修の安全チェック。ステージ済みの変更（git diff --cached）を検査し、
 * 1つでも違反があれば exit 1 でワークフローを止める。
 *
 * 守るもの:
 * - 認証・シークレット・運営 API・デプロイ設定・このガード自体・依存関係
 * - 既存マイグレーション（新規追加のみ可、破壊的な SQL は不可）
 * - 外部への新しい通信先、シークレット名の参照
 * - 変更の大きさ
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MAX_CHANGED_LINES = 600;

const PROTECTED = [
  /^\.github\//,
  /^\.claude\//,
  /^scripts\/auto-improve\//,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^wrangler\.jsonc$/,
  /^worker\.ts$/,
  /^open-next\.config\.ts$/,
  /^next\.config\.ts$/,
  /^cloudflare-env\.d\.ts$/,
  /^tsconfig\.json$/,
  /^\.gitignore$/,
  /^\.dev\.vars/,
  /^CLAUDE\.md$/,
  /^src\/secrets\.d\.ts$/,
  /^src\/lib\/auth\.ts$/,
  /^src\/lib\/db\.ts$/,
  /^src\/lib\/gemini\.ts$/,
  /^src\/lib\/ops\.ts$/,
  /^src\/app\/api\/auth\//,
  /^src\/app\/api\/ops\//,
  /^src\/app\/api\/cron\//,
];

const SECRET_NAMES = /\b(GOOGLE_AI_API_KEY|GOOGLE_CLIENT_SECRET|GOOGLE_CLIENT_ID|SESSION_SECRET|CRON_SECRET|OPS_TOKEN|CLOUDFLARE_API_TOKEN|ANTHROPIC_API_KEY)\b/;
const DANGEROUS_SQL = /\b(DROP|DELETE|UPDATE|REPLACE|ATTACH|DETACH|PRAGMA|TRUNCATE)\b/i;
const URL_RE = /https?:\/\/[^\s"'`)]+/g;
const ALLOWED_URL = /^https?:\/\/(robot-empire\.wagaya\.workers\.dev|localhost)(\/|$)/;

const sh = (cmd) => execSync(cmd, { encoding: "utf8" });
const errors = [];

const status = sh("git diff --cached --name-status")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => l.split("\t"));

if (!status.length) {
  console.log("guard: 変更なし");
  process.exit(0);
}

for (const [code, file, renamed] of status) {
  const paths = [file, renamed].filter(Boolean);
  for (const p of paths) {
    if (PROTECTED.some((re) => re.test(p))) errors.push(`保護されたファイルの変更: ${p}`);
  }
  if (file.startsWith("migrations/")) {
    if (code !== "A") errors.push(`既存マイグレーションの変更・削除: ${code} ${file}`);
    else if (!/^migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(file)) errors.push(`マイグレーション名が不正: ${file}`);
    else {
      const sql = readFileSync(file, "utf8").replace(/--.*$/gm, "");
      if (DANGEROUS_SQL.test(sql)) errors.push(`マイグレーションに破壊的な SQL: ${file}（CREATE / ALTER TABLE ADD / INSERT のみ可）`);
    }
  }
}

let changed = 0;
for (const line of sh("git diff --cached --numstat").trim().split("\n").filter(Boolean)) {
  const [add, del] = line.split("\t");
  changed += (Number(add) || 0) + (Number(del) || 0);
}
if (changed > MAX_CHANGED_LINES) errors.push(`変更が大きすぎる: ${changed} 行（上限 ${MAX_CHANGED_LINES}）`);

const added = sh("git diff --cached -U0")
  .split("\n")
  .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
for (const l of added) {
  if (SECRET_NAMES.test(l)) errors.push(`シークレット名の参照: ${l.slice(0, 160)}`);
  for (const url of l.match(URL_RE) ?? []) {
    if (!ALLOWED_URL.test(url)) errors.push(`新しい外部 URL: ${url}`);
  }
  if (/\b(eval|new Function)\s*\(/.test(l)) errors.push(`動的コード実行: ${l.slice(0, 160)}`);
}

if (errors.length) {
  console.error("guard: 自動改修を中止します");
  for (const e of [...new Set(errors)]) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`guard: OK（${status.length} ファイル / ${changed} 行）`);
