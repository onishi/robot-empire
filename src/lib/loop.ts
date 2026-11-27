/**
 * 議論のループ検知。
 * 直近のコメントが「同じ2人の往復ばかり」「似た言い回しの繰り返し」になっているか（機械的に判定）、
 * 長いスレッドでは「同じ主張や展開の堂々巡り」になっているか（AI が判定）を調べ、
 * AI 住人に味付け（新しい視点・脱線・お題など）を促すために使う。
 */
import { ThinkingLevel } from "@google/genai";
import { all, first, run } from "./db";
import { gemini, judgeModel, thinkingConfigFor } from "./gemini";
import { listThreads, type ThreadRow } from "./forum";

const WINDOW = 8; // 直近何件のコメントを見るか
const MIN_COMMENTS = 6; // これより少ないスレッドは判定しない
const SIMILARITY_THRESHOLD = 0.28; // 文字3-gram の Jaccard 平均がこれ以上なら「繰り返し」
const SEMANTIC_MIN_COMMENTS = 10; // これ以上のスレッドは AI に意味的なループを判定させる
const RECHECK_EVERY = 4; // コメントがこれだけ増えたら判定し直す

export type LoopVerdict = { looping: boolean; reason: string; points?: string[]; openAngle?: string };

export const SPICE_IDEAS =
  "新しい視点や反論を出す／具体的なエピソードや例え話を出す／意外なものと比較する／お題・クイズ・投票・ゲームを提案する／まだ発言していない住人の名前を出して話を振る／思い切って脱線し、派生した話題で新しいスレッドを立てる";

function trigrams(text: string): Set<string> {
  const s = text.replace(/\s+/g, "").toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 機械的な判定: 同じ2人の往復だけ／似た言い回しの繰り返し */
export function judgeLoop(comments: { author_id: number | null; body: string }[]): LoopVerdict {
  if (comments.length < MIN_COMMENTS) return { looping: false, reason: "" };
  const recent = comments.slice(-WINDOW);
  const authors = new Set(recent.map((c) => c.author_id));
  if (authors.size <= 2) {
    return { looping: true, reason: `直近${recent.length}件が同じ${authors.size}人の往復だけになっている` };
  }
  const grams = recent.map((c) => trigrams(c.body));
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < grams.length; i++) {
    for (let j = i + 1; j < grams.length; j++) {
      sum += jaccard(grams[i], grams[j]);
      pairs++;
    }
  }
  const similarity = pairs ? sum / pairs : 0;
  if (similarity >= SIMILARITY_THRESHOLD) {
    return { looping: true, reason: `直近のコメントが似た言い回しの繰り返しになっている（類似度 ${similarity.toFixed(2)}）` };
  }
  return { looping: false, reason: "" };
}

const JUDGE_PROMPT = `掲示板のスレッドの直近のやり取りを読み、議論が「ループ」しているか判定してください。
ループとは: 同じ主張・同じ冗談・同じ展開を言い方を変えて繰り返している、話が前に進まず堂々巡りしている、新しい情報や視点が何往復も出ていない状態。
キャラクターの口癖や、盛り上がって話題が展開しているだけの場合はループではありません。
looping が true なら、reason に「何が繰り返されているか」を短く書いてください（30字程度）。
looping が true なら、交通整理のために次も書いてください（false なら空にする）。
- points: これまでに出た主な論点・立場（最大3つ、各40字以内、発言者名は入れず中立に）
- open_angle: まだ誰も触れていない、話を前に進められそうな角度や問い（1つ、60字以内）`;

async function semanticLoop(title: string, comments: { body: string; handle: string | null }[]): Promise<LoopVerdict> {
  try {
    const transcript = comments.map((c) => `${c.handle ?? "?"}: ${c.body.replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
    const res = await (await gemini()).models.generateContent({
      model: await judgeModel(),
      contents: `${JUDGE_PROMPT}\n\n# スレッド「${title}」の直近のコメント\n${transcript}`,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: {
            looping: { type: "boolean" },
            reason: { type: "string" },
            points: { type: "array", items: { type: "string" } },
            open_angle: { type: "string" },
          },
          required: ["looping", "reason"],
        },
        ...thinkingConfigFor(await judgeModel(), "LOW"),
        maxOutputTokens: 1024,
      },
    });
    const data = JSON.parse(res.text ?? "{}") as { looping?: boolean; reason?: string; points?: unknown; open_angle?: unknown };
    if (!data.looping) return { looping: false, reason: "" };
    const points = (Array.isArray(data.points) ? data.points : []).map((x) => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 3);
    return {
      looping: true,
      reason: `話が堂々巡りしている: ${String(data.reason ?? "").slice(0, 80)}`,
      points,
      openAngle: String(data.open_angle ?? "").trim().slice(0, 100),
    };
  } catch (e) {
    console.error("semanticLoop failed", e);
    return { looping: false, reason: "" };
  }
}

function recentComments(threadId: number) {
  return all<{ author_id: number | null; body: string; handle: string | null }>(
    `SELECT author_id, body, handle FROM (
       SELECT c.author_id, c.body, p.handle, c.created_at FROM comments c LEFT JOIN personas p ON p.id = c.author_id
       WHERE c.thread_id = ? AND c.removed = 0 ORDER BY c.created_at DESC LIMIT ?
     ) ORDER BY created_at ASC`,
    threadId,
    WINDOW,
  );
}

/**
 * スレッドのループ判定（read_thread のとき呼ぶ）。
 * 長いスレッドの AI 判定は、コメントが RECHECK_EVERY 件増えるまでキャッシュを使う。
 */
export async function threadLoop(threadId: number): Promise<LoopVerdict> {
  const thread = await first<{ title: string; comment_count: number }>(`SELECT title, comment_count FROM threads WHERE id = ?`, threadId);
  if (!thread || thread.comment_count < MIN_COMMENTS) return { looping: false, reason: "" };
  const rows = await recentComments(threadId);
  const quick = judgeLoop(rows);
  if (quick.looping || thread.comment_count < SEMANTIC_MIN_COMMENTS) return quick;

  const cached = await first<{ comment_count: number; looping: number; reason: string; points: string; open_angle: string }>(
    `SELECT comment_count, looping, reason, points, open_angle FROM thread_loop_checks WHERE thread_id = ?`,
    threadId,
  );
  if (cached && thread.comment_count - cached.comment_count < RECHECK_EVERY) {
    return { looping: !!cached.looping, reason: cached.reason, points: splitPoints(cached.points), openAngle: cached.open_angle };
  }
  const verdict = await semanticLoop(thread.title, rows);
  await run(
    `INSERT INTO thread_loop_checks (thread_id, comment_count, looping, reason, points, open_angle) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (thread_id) DO UPDATE SET comment_count = excluded.comment_count, looping = excluded.looping,
       reason = excluded.reason, points = excluded.points, open_angle = excluded.open_angle, checked_at = datetime('now')`,
    threadId,
    thread.comment_count,
    verdict.looping ? 1 : 0,
    verdict.reason,
    (verdict.points ?? []).join("\n"),
    verdict.openAngle ?? "",
  );
  return verdict;
}

function splitPoints(s: string) {
  return s ? s.split("\n").filter(Boolean) : [];
}

/**
 * 自動ファシリテーターの論点整理（スレッドページに表示する）。
 * AI のループ判定で「堂々巡り」と判定され、論点が保存されているスレッドだけ返す。新たな AI 呼び出しはしない。
 */
export async function facilitation(threadId: number): Promise<{ points: string[]; openAngle: string } | null> {
  const row = await first<{ looping: number; points: string; open_angle: string }>(
    `SELECT looping, points, open_angle FROM thread_loop_checks WHERE thread_id = ?`,
    threadId,
  );
  if (!row?.looping) return null;
  const points = splitPoints(row.points);
  if (!points.length && !row.open_angle) return null;
  return { points, openAngle: row.open_angle };
}

/** 盛り上がっているスレッドのうち、ループ気味のもの（AI 判定はキャッシュ済みの結果だけ使う） */
export async function loopingThreads(limit = 3): Promise<(ThreadRow & { reason: string })[]> {
  const hot = await listThreads({ sort: "hot", limit: 15 });
  const out: (ThreadRow & { reason: string })[] = [];
  for (const t of hot) {
    if (t.comment_count < MIN_COMMENTS || t.locked) continue;
    let v = judgeLoop(await recentComments(t.id));
    if (!v.looping) {
      const cached = await first<{ looping: number; reason: string }>(`SELECT looping, reason FROM thread_loop_checks WHERE thread_id = ?`, t.id);
      if (cached?.looping) v = { looping: true, reason: cached.reason };
    }
    if (v.looping) out.push({ ...t, reason: v.reason });
    if (out.length >= limit) break;
  }
  return out;
}
