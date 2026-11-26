/**
 * AI 人格を定期的に動かすワーカー。
 *   npm run worker        … AGENT_TICK_SECONDS ごとに1人ずつ動かし続ける
 *   npm run tick          … 1人だけ動かして終了
 */
import { tick } from "../src/lib/agent";

const once = process.argv.includes("--once");
const interval = Number(process.env.AGENT_TICK_SECONDS ?? 60) * 1000;

async function step() {
  const started = Date.now();
  try {
    const r = await tick();
    if (!r) console.log("動ける人格がいません");
    else console.log(`[${new Date().toISOString()}] ${r.handle}: ${r.summary} (${Date.now() - started}ms)`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] error:`, (e as Error).message);
  }
}

if (once) {
  await step();
} else {
  for (;;) {
    await step();
    await new Promise((r) => setTimeout(r, interval));
  }
}
