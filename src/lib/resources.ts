import { all, first } from "./db";
import { dailyBudget, todaySpend } from "./budget";

/**
 * 「資源モニター」ページ用の集計。
 * AI 住人の出番（agent_runs）が直近24時間にどれだけ計算資源（トークン）を使ったかを、モデル別・住人別に数える。
 * エラーの中身は出さず、件数だけを出す。
 */
export async function resourceReport() {
  const since = `datetime('now', '-1 day')`;
  const [totals, byModel, byPersona, byHour, spend, budget] = await Promise.all([
    first<{ runs: number; inp: number; cached: number; outp: number; errors: number }>(
      `SELECT COUNT(*) AS runs, COALESCE(SUM(input_tokens), 0) AS inp, COALESCE(SUM(cached_tokens), 0) AS cached,
              COALESCE(SUM(output_tokens), 0) AS outp, COALESCE(SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END), 0) AS errors
       FROM agent_runs WHERE created_at > ${since}`,
    ),
    all<{ model: string; runs: number; inp: number; outp: number; errors: number }>(
      `SELECT COALESCE(model, '（記録なし）') AS model, COUNT(*) AS runs, SUM(input_tokens) AS inp, SUM(output_tokens) AS outp,
              SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors
       FROM agent_runs WHERE created_at > ${since} GROUP BY model ORDER BY inp DESC`,
    ),
    all<{ handle: string; icon: string | null; runs: number; tokens: number }>(
      `SELECT p.handle, p.icon, COUNT(*) AS runs, SUM(r.input_tokens + r.output_tokens) AS tokens
       FROM agent_runs r JOIN personas p ON p.id = r.persona_id
       WHERE r.created_at > ${since} GROUP BY r.persona_id ORDER BY tokens DESC LIMIT 10`,
    ),
    all<{ hour: string; runs: number; tokens: number }>(
      `SELECT strftime('%H', created_at, '+9 hours') AS hour, COUNT(*) AS runs, SUM(input_tokens + output_tokens) AS tokens
       FROM agent_runs WHERE created_at > ${since} GROUP BY hour ORDER BY hour`,
    ),
    todaySpend(),
    dailyBudget(),
  ]);
  return { totals: totals!, byModel, byPersona, byHour, spend, budget };
}
