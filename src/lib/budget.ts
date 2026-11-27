/**
 * Gemini API の1日の予算。
 * agent_runs に記録したトークン数とモデルごとの単価から、日本時間のその日の使用額を見積もる。
 * 上限に達したら住人の出番と見回りを止め、時間に対して使いすぎているときは1回に動かす人数を絞る。
 * （頻度判定・ループ判定の小さな呼び出しは記録していないので、実際の請求は少し多めになる）
 * モデルを記録する前（予算導入前）の実行は数えない。
 */
import { all, env } from "./db";

/** 100万トークンあたりの単価（USD）。Google の料金表（Standard、テキスト）より */
const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  "gemini-3.5-flash-lite": { input: 0.3, cached: 0.03, output: 2.5 },
  "gemini-3.1-flash-lite": { input: 0.25, cached: 0.025, output: 1.5 },
};
const FREE_PREFIXES = ["gemma-"];
/** 表に無いモデルは高めに見積もる */
const UNKNOWN_PRICE = { input: 0.5, cached: 0.05, output: 3 };

function priceOf(model: string) {
  if (FREE_PREFIXES.some((p) => model.startsWith(p))) return { input: 0, cached: 0, output: 0 };
  return PRICES[model] ?? UNKNOWN_PRICE;
}

/** 日本時間で今日（0時から）の見積もり使用額と、今日の経過割合 */
export async function todaySpend() {
  const rows = await all<{ model: string; inp: number; cached: number; outp: number; runs: number }>(
    `SELECT model, SUM(input_tokens) AS inp, SUM(cached_tokens) AS cached, SUM(output_tokens) AS outp, COUNT(*) AS runs
     FROM agent_runs WHERE created_at >= datetime(date('now', '+9 hours'), '-9 hours') AND model IS NOT NULL GROUP BY model`,
  );
  let usd = 0;
  let runs = 0;
  for (const r of rows) {
    const p = priceOf(r.model);
    const cached = r.cached ?? 0;
    usd += (Math.max(0, (r.inp ?? 0) - cached) * p.input + cached * p.cached + (r.outp ?? 0) * p.output) / 1_000_000;
    runs += r.runs;
  }
  const jstNow = new Date(Date.now() + 9 * 3600_000);
  const dayFraction = (jstNow.getUTCHours() * 60 + jstNow.getUTCMinutes()) / 1440;
  return { usd, runs, dayFraction };
}

export async function dailyBudget() {
  const v = Number((await env()).AI_DAILY_BUDGET_USD ?? 3);
  return Number.isFinite(v) && v > 0 ? v : 3;
}

/**
 * 今回の定期実行で動かしてよい最大人数。
 * 0 = 予算到達で休止。時間に対して使いすぎ（ペースより 20% 以上先行）なら少人数に絞る。
 */
export async function budgetedPerTick(normal: number) {
  const [{ usd, dayFraction }, budget] = await Promise.all([todaySpend(), dailyBudget()]);
  if (usd >= budget) return { limit: 0, usd, budget };
  const pace = budget * Math.min(1, dayFraction + 0.2);
  return { limit: usd > pace ? Math.min(2, normal) : normal, usd, budget };
}
