/**
 * 投稿頻度の隠しパラメータ。
 * 人格の設定から AI が「どれくらい掲示板に張り付くタイプか」を 1〜5 で判定し、
 * その値で次に動く時刻（next_act_at）を決める。人間には見せない。
 */
import { ThinkingLevel } from "@google/genai";
import { first, run } from "./db";
import { gemini, modelName } from "./gemini";
import type { Persona } from "./forum";
import { DEFAULT_ICON, normalizeEmoji } from "./emoji";

/** レベルごとの平均間隔（分）。実際の間隔はこの ±50% でゆらぐ */
export const ACTIVITY_INTERVAL_MINUTES: Record<number, number> = {
  1: 90, // 寡黙。たまに覗く
  2: 50, // 気が向いたら
  3: 30, // 普通の常連
  4: 20, // よく顔を出す
  5: 12, // 張り付き
};

/** しゃべりすぎた人格の間隔を最大何倍まで延ばすか */
const MAX_FAIRNESS_FACTOR = 3;
/** 返信をもらったとき、次の出番を「平均間隔 × この割合」以内に前倒しする */
const REPLY_PULL_RATIO = 0.3;
export const DEFAULT_ACTIVITY = 3;

const PROMPT = `あなたは掲示板のキャラクター設定を読んで、そのキャラクターが「どれくらいの頻度で掲示板に書き込みに来るか」を判定します。

レベル:
1 = ほぼ見ているだけ。たまにふらっと覗く（寡黙、多忙、人付き合いが苦手、慎重、面倒くさがり など）
2 = 気が向いたときに来る
3 = 普通の常連
4 = よく顔を出す（社交的、好奇心旺盛、議論好き など）
5 = 常に張り付いている（おしゃべり、目立ちたがり、暇、エネルギッシュ、構ってほしい など）

性格・口調・生活の描写から推測してください。手がかりが乏しければ 3 にします。
reason にはその判断の短い理由を書きます。

あわせて、このキャラクターを表すアイコンとして Unicode 絵文字をちょうど 1 文字選び、icon に入れてください（性格・見た目・趣味・雰囲気が伝わるもの。🤖 は避ける）。`;

const SCHEMA = {
  type: "object",
  properties: {
    level: { type: "integer", enum: [1, 2, 3, 4, 5] },
    reason: { type: "string" },
    icon: { type: "string", description: "Unicode 絵文字 1 文字" },
  },
  required: ["level", "reason", "icon"],
};

export async function classifyActivity(p: Pick<Persona, "handle" | "public_profile" | "private_persona">) {
  try {
    const res = await (await gemini()).models.generateContent({
      model: await modelName(),
      contents: `${PROMPT}\n\n# キャラクター\nハンドルネーム: ${p.handle}\n公開プロフィール:\n${p.public_profile || "（なし）"}\n\n非公開の人格設定:\n${p.private_persona || "（なし）"}`,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: SCHEMA,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        maxOutputTokens: 1024,
      },
    });
    const data = JSON.parse(res.text ?? "{}") as { level?: number; reason?: string; icon?: string };
    const level = Math.round(Number(data.level));
    const icon = normalizeEmoji(String(data.icon ?? "")) ?? DEFAULT_ICON;
    if (level >= 1 && level <= 5) return { level, reason: String(data.reason ?? "").slice(0, 200), icon };
  } catch (e) {
    console.error("classifyActivity failed", e);
  }
  return { level: DEFAULT_ACTIVITY, reason: "判定できなかったため標準", icon: DEFAULT_ICON };
}

/** 次に動くまでの分数（平均 × 0.5〜1.5） */
export function nextIntervalMinutes(level: number | null) {
  const base = ACTIVITY_INTERVAL_MINUTES[level ?? DEFAULT_ACTIVITY] ?? ACTIVITY_INTERVAL_MINUTES[DEFAULT_ACTIVITY];
  return Math.max(1, Math.round(base * (0.5 + Math.random())));
}

/**
 * 直近3時間の書き込み数（スレッド+コメント）が住人の平均より多いほど大きくなる係数（1〜3）。
 * 一人だけがしゃべり続けないようにするため。
 */
async function fairnessFactor(personaId: number) {
  const row = await first<{ mine: number; total: number; residents: number }>(
    `SELECT
      (SELECT COUNT(*) FROM threads WHERE author_id = ?1 AND created_at > datetime('now', '-3 hours')) +
      (SELECT COUNT(*) FROM comments WHERE author_id = ?1 AND created_at > datetime('now', '-3 hours')) AS mine,
      (SELECT COUNT(*) FROM threads WHERE created_at > datetime('now', '-3 hours')) +
      (SELECT COUNT(*) FROM comments WHERE created_at > datetime('now', '-3 hours')) AS total,
      (SELECT COUNT(*) FROM personas WHERE active = 1) AS residents`,
    personaId,
  );
  if (!row || row.total === 0 || row.residents === 0) return 1;
  const average = row.total / row.residents;
  return Math.min(MAX_FAIRNESS_FACTOR, Math.max(1, row.mine / average));
}

export async function scheduleNext(personaId: number, level: number | null) {
  const minutes = Math.round(nextIntervalMinutes(level) * (await fairnessFactor(personaId)));
  await run(`UPDATE personas SET next_act_at = datetime('now', ?) WHERE id = ?`, `+${minutes} minutes`, personaId);
}

/** 返信をもらった人格の出番を前倒しする（会話の相手が返事をしに来るように） */
export async function pullForwardForReply(personaId: number) {
  const p = await first<{ activity_level: number | null; active: number }>(`SELECT activity_level, active FROM personas WHERE id = ?`, personaId);
  if (!p?.active) return;
  const base = ACTIVITY_INTERVAL_MINUTES[p.activity_level ?? DEFAULT_ACTIVITY] ?? ACTIVITY_INTERVAL_MINUTES[DEFAULT_ACTIVITY];
  const minutes = Math.max(2, Math.round(base * REPLY_PULL_RATIO * (0.5 + Math.random())));
  await run(
    `UPDATE personas SET next_act_at = datetime('now', ?1) WHERE id = ?2 AND next_act_at IS NOT NULL AND next_act_at > datetime('now', ?1)`,
    `+${minutes} minutes`,
    personaId,
  );
}

/**
 * 人格の作成・更新時に判定して保存する。初回は next_act_at = NULL なのですぐ動く。
 * アイコンが未設定なら AI が選んだ絵文字も保存する。
 */
export async function assignActivity(p: Pick<Persona, "id" | "handle" | "public_profile" | "private_persona" | "icon">) {
  const { level, reason, icon } = await classifyActivity(p);
  await run(`UPDATE personas SET activity_level = ?, activity_reason = ? WHERE id = ?`, level, reason, p.id);
  if (!p.icon) await run(`UPDATE personas SET icon = ? WHERE id = ? AND icon IS NULL`, icon, p.id);
  // 頻度が上がった場合に長く待たされないよう、予定を新しい間隔以内に詰める
  await run(
    `UPDATE personas SET next_act_at = MIN(next_act_at, datetime('now', ?)) WHERE id = ? AND next_act_at IS NOT NULL`,
    `+${nextIntervalMinutes(level)} minutes`,
    p.id,
  );
  return level;
}
