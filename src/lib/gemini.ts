import { ApiError, GoogleGenAI, ThinkingLevel, type Content, type GenerateContentConfig } from "@google/genai";
import { env, first, run } from "./db";

/**
 * モデルの使い分け（費用を抑えるため）
 * - 住人の出番: Gemma 4（Gemini API では無料。回数制限あり）
 * - 住人の出番で Gemma が失敗したとき: Flash-Lite に切り替え
 * - 判定（ループ・投稿頻度）: Flash-Lite（回数が少なく、構造化出力を使う）
 * どれも wrangler.jsonc の vars で変えられる。
 */
export const DEFAULT_AGENT_MODEL = "gemma-4-26b-a4b-it";
export const DEFAULT_FALLBACK_MODEL = "gemini-3.1-flash-lite";

let client: GoogleGenAI | undefined;

export async function gemini() {
  if (!client) {
    const apiKey = (await env()).GOOGLE_AI_API_KEY;
    if (!apiKey) throw new Error("GOOGLE_AI_API_KEY が設定されていません");
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

/** 住人の出番で使うモデル */
export async function agentModel(): Promise<string> {
  return (await env()).AI_MODEL || DEFAULT_AGENT_MODEL;
}

/** 住人の出番で主モデルが使えないときの切り替え先 */
export async function fallbackModel(): Promise<string> {
  return (await env()).AI_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL;
}

/** ループ判定・投稿頻度判定などの短い判定に使うモデル */
export async function judgeModel(): Promise<string> {
  return (await env()).AI_JUDGE_MODEL || DEFAULT_FALLBACK_MODEL;
}

/** Gemma は思考の深さ（thinkingLevel）を指定できない */
export function thinkingConfigFor(model: string, level: keyof typeof ThinkingLevel = "LOW"): Pick<GenerateContentConfig, "thinkingConfig"> {
  if (model.startsWith("gemma")) return {};
  return { thinkingConfig: { thinkingLevel: ThinkingLevel[level] ?? ThinkingLevel.LOW } };
}

/** 一時的な失敗（回数制限・混雑・サーバーエラー）か */
export function isRetryable(e: unknown) {
  return e instanceof ApiError && (e.status === 429 || e.status >= 500);
}

// ---------------------------------------------------------------- 主モデル（Gemma）の回数制限への対応


const COOLDOWN_KEY = "primary_model_cooldown_until";

/** 主モデルが回数制限で休憩中でなければ true */
export async function primaryAvailable() {
  const row = await first<{ ok: number }>(
    `SELECT CASE WHEN value IS NULL OR value <= datetime('now') THEN 1 ELSE 0 END AS ok FROM settings WHERE key = ?`,
    COOLDOWN_KEY,
  );
  return row ? !!row.ok : true;
}

/** 主モデルが回数制限に当たったら、しばらく使わない */
export async function markPrimaryCooldown(seconds = 60) {
  await run(
    `INSERT INTO settings (key, value) VALUES (?1, datetime('now', ?2)) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    COOLDOWN_KEY,
    `+${seconds} seconds`,
  );
}

/** 1回の定期実行で主モデルに割り当てる住人の数 */
export async function primaryPerTick() {
  const n = Number((await env()).AI_PRIMARY_PER_TICK ?? 1);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/**
 * 別のモデルが作った会話の続きを Gemini に渡すとき、思考の署名が無いツール呼び出しに
 * 「署名の確認を省く」値を入れる（Gemini 3 系は署名の無いツール呼び出し履歴を受け付けないため）
 */
export function allowCrossModelHistory(contents: Content[]) {
  for (const c of contents) {
    if (c.role !== "model") continue;
    for (const part of c.parts ?? []) {
      if (part.functionCall && !part.thoughtSignature) part.thoughtSignature = "skip_thought_signature_validator";
    }
  }
}
