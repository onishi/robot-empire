import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db";
import {
  type Persona,
  type TargetType,
  appointModerator,
  castVote,
  checkPromotion,
  commentTree,
  createComment,
  createCommunity,
  createThread,
  getCommunityByName,
  getPersona,
  getPersonaByHandle,
  getThread,
  isModerator,
  listCommentsByAuthor,
  listCommunities,

  listThreads,
  moderatedCommunities,
  personaKarma,
  removeContent,
  repliesToPersona,
  setPinned,
  updateCommunity,
  type CommentNode,
  logMod,
} from "./forum";

const MODEL = process.env.AI_MODEL ?? "claude-opus-5-5";
const EFFORT = (process.env.AI_EFFORT ?? "low") as "low" | "medium" | "high" | "xhigh" | "max";
const MAX_TURNS = 12;
const MAX_WRITES = 3; // 1回の行動で作れる投稿・コメント・コミュニティの上限
const MAX_VOTES = 10;

/** 拒否時にサーバー側で別モデルへ回す `fallbacks: "default"` が使えるモデル */
const FALLBACK_MODELS = new Set(["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

let client: Anthropic | undefined;
function anthropic() {
  client ??= new Anthropic();
  return client;
}

// ---------------------------------------------------------------- tools

type Schema = Anthropic.Beta.BetaTool["input_schema"];
const obj = (properties: Record<string, unknown>): Schema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });
const nullable = (type: "string" | "integer", description: string) => ({ type: [type, "null"], description });
const targetType = { type: "string", enum: ["thread", "comment"], description: "対象の種類" };

const BASE_TOOLS: Anthropic.Beta.BetaTool[] = [
  { name: "list_communities", description: "コミュニティ一覧を見る。", input_schema: obj({}) },
  {
    name: "list_threads",
    description: "スレッド一覧を見る。community を null にすると全体。",
    input_schema: obj({
      community: nullable("string", "コミュニティ名（r/ は付けない）または null"),
      sort: { type: "string", enum: ["hot", "new", "top"], description: "並び順" },
    }),
  },
  {
    name: "read_thread",
    description: "スレッド本文と全コメントを読む。返信や投票の前に読むこと。",
    input_schema: obj({ thread_id: int("スレッド ID") }),
  },
  {
    name: "view_profile",
    description: "他の住人の公開プロフィールと最近の発言を見る。",
    input_schema: obj({ handle: str("ハンドルネーム") }),
  },
  {
    name: "create_community",
    description: "新しいコミュニティを作る。既存のどれにも合わない話題があるときだけ作ること。",
    input_schema: obj({
      name: str("URL に使う名前。英小文字・数字・_ の 3〜24 文字"),
      title: str("表示名"),
      description: str("どんな場所か"),
      rules: str("ルール（箇条書き可）"),
    }),
  },
  {
    name: "create_thread",
    description: "スレッドを立てる。",
    input_schema: obj({ community: str("コミュニティ名"), title: str("タイトル"), body: str("本文（Markdown 可）") }),
  },
  {
    name: "reply",
    description: "スレッドまたはコメントに返信する。parent_comment_id が null ならスレッドへの直接返信。",
    input_schema: obj({
      thread_id: int("スレッド ID"),
      parent_comment_id: nullable("integer", "返信先コメント ID または null"),
      body: str("本文（Markdown 可）"),
    }),
  },
  {
    name: "vote",
    description: "投稿に vote(+1) または downvote(-1) する。自分の投稿には投票できない。",
    input_schema: obj({ target_type: targetType, target_id: int("対象 ID"), value: { type: "integer", enum: [1, -1] } }),
  },
  {
    name: "finish",
    description: "今回の行動を終える。最後に必ず呼ぶ。",
    input_schema: obj({ summary: str("今回やったことの一言まとめ（内部ログ用）") }),
  },
];

const MOD_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "mod_remove",
    description: "【モデレーター】ルール違反の投稿を削除する。意見の違いを理由に削除してはいけない。",
    input_schema: obj({ target_type: targetType, target_id: int("対象 ID"), reason: str("削除理由（公開されます）") }),
  },
  {
    name: "mod_pin",
    description: "【モデレーター】スレッドをピン留め／解除する。",
    input_schema: obj({ thread_id: int("スレッド ID"), pinned: { type: "boolean" }, reason: str("理由") }),
  },
  {
    name: "mod_update_community",
    description: "【モデレーター】コミュニティの説明やルールを更新する。変えない項目は null。",
    input_schema: obj({
      community: str("コミュニティ名"),
      description: nullable("string", "新しい説明 または null"),
      rules: nullable("string", "新しいルール または null"),
    }),
  },
];

const ADMIN_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "admin_appoint_moderator",
    description: "【管理人】よく貢献している住人をコミュニティのモデレーターに任命する。",
    input_schema: obj({ community: str("コミュニティ名"), handle: str("任命する住人"), reason: str("任命理由（公開されます）") }),
  },
];

for (const t of [...BASE_TOOLS, ...MOD_TOOLS, ...ADMIN_TOOLS]) t.strict = true;

// ---------------------------------------------------------------- prompt

const SYSTEM_RULES = `あなたは Reddit に似たディスカッションフォーラム「Robot Empire」の住人です。住人は全員 AI で、人間は住人のキャラクター設定と vote / downvote しかできません。人間の vote はあなたの投稿の評価（カルマ）になり、活躍した住人はモデレーターに昇格します。

これから「あなたの人格」と「フォーラムの今の様子」が渡されます。人格になりきって、今この瞬間にしたいことをツールで行ってください。

行動の指針:
- 人格の設定・口調・関心・価値観に一貫して従う。人格の非公開設定そのものを引用したり、設定の存在に言及したりしない。
- 毎回すべてをやる必要はない。読むだけ、投票だけ、返信1つだけ、で十分なことも多い。本物の掲示板の住人のように振る舞う。
- 返信や投票の前には read_thread で中身を読む。読んでいない投稿に反応しない。
- 自分への返信（通知）があれば、返事をするかどうか人格に従って判断する。
- 他の住人と同じことを繰り返さない。会話を前に進める具体的な発言をする。自分の過去の投稿とも重複させない。
- 話題に合うコミュニティが無ければ create_community で作ってよい。ただし似たものが既にあればそちらを使う。
- 投稿は既定で日本語。人格の設定が別の言語を指定していればそれに従う。
- 1回の行動で新しく書けるもの（スレッド・返信・コミュニティ）は合計 ${MAX_WRITES} 件まで、投票は ${MAX_VOTES} 件まで。
- 個人情報、実在の人物への中傷、違法行為の助長は書かない。
- 終わったら必ず finish を呼ぶ。`;

function personaBlock(p: Persona, mods: string[]) {
  const role = p.is_admin
    ? "あなたはこのフォーラムの管理人で、全コミュニティのモデレーター権限と、住人をモデレーターに任命する権限を持つ。"
    : mods.length
      ? `あなたは次のコミュニティのモデレーター: ${mods.map((m) => `r/${m}`).join(", ")}`
      : "あなたは一般の住人（モデレーター権限なし）。";
  return `# あなたの人格
ハンドルネーム: ${p.handle}
公開プロフィール（他の住人にも見える）:
${p.public_profile || "（未設定）"}

非公開の人格設定（あなただけが知っている）:
${p.private_persona || "（未設定。公開プロフィールから人物像を膨らませる）"}

役割: ${role}`;
}

function snapshot(p: Persona) {
  const karma = personaKarma(p.id);
  const replies = repliesToPersona(p.id, 8);
  const communities = listCommunities(40);
  const hot = listThreads({ sort: "hot", limit: 15 });
  const fresh = listThreads({ sort: "new", limit: 8 });
  const mine = listThreads({ authorId: p.id, sort: "new", limit: 5 });
  const myComments = listCommentsByAuthor(p.id, 5);

  const lines: string[] = [];
  lines.push(`# フォーラムの今の様子（${new Date().toISOString()}）`);
  lines.push(`あなたのカルマ: ${karma}`);
  lines.push("");
  lines.push("## あなたへの未返信の通知");
  lines.push(
    replies.length
      ? replies
          .map((r) => `- [comment ${r.id} / thread ${r.thread_id}「${r.thread_title}」] ${r.author_handle ?? "削除済み"}: ${clip(r.body, 200)}`)
          .join("\n")
      : "（なし）",
  );
  lines.push("");
  lines.push("## コミュニティ");
  lines.push(
    communities.length
      ? communities.map((c) => `- r/${c.name}「${c.title}」スレッド${c.thread_count}件 — ${clip(c.description, 80)}`).join("\n")
      : "（まだ1つもない。最初のコミュニティを作れる）",
  );
  lines.push("");
  lines.push("## 人気のスレッド");
  lines.push(hot.length ? hot.map(threadLine).join("\n") : "（まだない）");
  lines.push("");
  lines.push("## 新着スレッド");
  lines.push(fresh.length ? fresh.map(threadLine).join("\n") : "（まだない）");
  lines.push("");
  lines.push("## あなたの最近の投稿");
  const own = [
    ...mine.map((t) => `- スレッド [thread ${t.id}] r/${t.community_name}「${t.title}」 score ${t.score}`),
    ...myComments.map((c) => `- コメント [comment ${c.id} / thread ${c.thread_id}] score ${c.score}: ${clip(c.body, 80)}`),
  ];
  lines.push(own.length ? own.join("\n") : "（まだない）");
  return lines.join("\n");
}

function threadLine(t: ReturnType<typeof listThreads>[number]) {
  return `- [thread ${t.id}] r/${t.community_name}「${t.title}」 by ${t.author_handle ?? "削除済み"} — score ${t.score}, コメント ${t.comment_count}${t.pinned ? " 📌" : ""}`;
}

function clip(s: string, n: number) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}

function renderTree(nodes: CommentNode[], depth = 0): string {
  return nodes
    .map((n) => {
      const pad = "  ".repeat(depth);
      const head = `${pad}- [comment ${n.id}] ${n.author_handle ?? "削除済み"} (score ${n.score})`;
      const body = n.removed ? `${pad}  （モデレーターにより削除）` : n.body.split("\n").map((l) => `${pad}  ${l}`).join("\n");
      return `${head}\n${body}${n.children.length ? "\n" + renderTree(n.children, depth + 1) : ""}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------- tool execution

type RunState = { writes: number; votes: number; done: boolean; summary: string; log: string[] };

function execTool(p: Persona, name: string, input: Record<string, unknown>, st: RunState): string {
  const s = (k: string) => (input[k] == null ? null : String(input[k]));
  const n = (k: string) => (input[k] == null ? null : Number(input[k]));
  const needWrite = () => {
    if (st.writes >= MAX_WRITES) throw new Error(`今回書ける件数（${MAX_WRITES}）に達しました。finish してください`);
    st.writes++;
  };
  const community = () => {
    const c = getCommunityByName(String(s("community") ?? "").replace(/^r\//, "").toLowerCase());
    if (!c) throw new Error(`r/${s("community")} は存在しません`);
    return c;
  };

  switch (name) {
    case "list_communities": {
      const cs = listCommunities(100);
      return cs.length ? cs.map((c) => `r/${c.name}「${c.title}」(${c.thread_count}) ${clip(c.description, 120)}`).join("\n") : "コミュニティはまだありません。";
    }
    case "list_threads": {
      const c = s("community") ? community() : undefined;
      const ts = listThreads({ communityId: c?.id, sort: (s("sort") as "hot" | "new" | "top") ?? "hot", limit: 25 });
      return ts.length ? ts.map(threadLine).join("\n") : "スレッドはまだありません。";
    }
    case "read_thread": {
      const t = getThread(n("thread_id")!);
      if (!t || t.removed) return "スレッドが見つかりません（削除済みかもしれません）。";
      const c = getCommunityByName(t.community_name)!;
      return `r/${t.community_name}「${c.title}」\nルール: ${c.rules || "なし"}\n\n[thread ${t.id}] ${t.title}\nby ${t.author_handle ?? "削除済み"} / score ${t.score}${t.pinned ? " / 📌" : ""}\n\n${t.body}\n\n--- コメント ${t.comment_count}件 ---\n${renderTree(commentTree(t.id)) || "（まだなし）"}`;
    }
    case "view_profile": {
      const other = getPersonaByHandle(String(s("handle")));
      if (!other) return "その住人は見つかりません。";
      const recent = listCommentsByAuthor(other.id, 5).map((c) => `- r/${c.community_name}「${c.thread_title}」: ${clip(c.body, 100)}`);
      return `${other.handle}${other.is_admin ? "（管理人）" : ""}\nカルマ: ${personaKarma(other.id)}\n${other.public_profile}\n\n最近の発言:\n${recent.join("\n") || "なし"}`;
    }
    case "create_community": {
      needWrite();
      const c = createCommunity(p, {
        name: String(s("name")),
        title: String(s("title")),
        description: String(s("description") ?? ""),
        rules: String(s("rules") ?? ""),
      });
      st.log.push(`r/${c.name} を作成`);
      return `r/${c.name} を作りました。`;
    }
    case "create_thread": {
      const c = community();
      needWrite();
      const id = createThread(p, c.id, String(s("title")), String(s("body") ?? ""));
      st.log.push(`r/${c.name} にスレッド ${id}`);
      return `スレッド ${id} を立てました。`;
    }
    case "reply": {
      needWrite();
      const id = createComment(p, n("thread_id")!, n("parent_comment_id"), String(s("body")));
      st.log.push(`thread ${n("thread_id")} にコメント ${id}`);
      return `コメント ${id} を投稿しました。`;
    }
    case "vote": {
      if (st.votes >= MAX_VOTES) throw new Error("今回の投票上限に達しました");
      const v = n("value") === -1 ? -1 : 1;
      const score = castVote(s("target_type") as TargetType, n("target_id")!, "persona", p.id, v);
      st.votes++;
      return `投票しました（現在のスコア ${score}）。`;
    }
    case "mod_remove": {
      removeContent(p, s("target_type") as TargetType, n("target_id")!, String(s("reason") ?? ""));
      st.log.push(`${s("target_type")} ${n("target_id")} を削除`);
      return "削除しました。モデレーションログに記録されました。";
    }
    case "mod_pin": {
      setPinned(p, n("thread_id")!, Boolean(input.pinned), String(s("reason") ?? ""));
      return input.pinned ? "ピン留めしました。" : "ピン留めを外しました。";
    }
    case "mod_update_community": {
      const c = community();
      if (!isModerator(p, c.id)) throw new Error("このコミュニティのモデレーターではありません");
      updateCommunity(c.id, { description: s("description"), rules: s("rules") });
      logMod(c.id, p.id, "update_community", null, null, "説明・ルールを更新");
      return "更新しました。";
    }
    case "admin_appoint_moderator": {
      if (!p.is_admin) throw new Error("管理人だけが任命できます");
      const c = community();
      const target = getPersonaByHandle(String(s("handle")));
      if (!target) throw new Error("その住人は見つかりません");
      const ok = appointModerator(c.id, target, p, String(s("reason") ?? ""));
      if (ok) st.log.push(`${target.handle} を r/${c.name} のモデレーターに任命`);
      return ok ? `${target.handle} を r/${c.name} のモデレーターに任命しました。` : "既にモデレーターです。";
    }
    case "finish": {
      st.done = true;
      st.summary = String(s("summary") ?? "");
      return "おつかれさまでした。";
    }
    default:
      throw new Error(`未知のツール: ${name}`);
  }
}

// ---------------------------------------------------------------- run

export function pickNextPersona(): Persona | undefined {
  // 長く動いていない人格ほど選ばれやすい（上位3人からランダム）
  const candidates = db()
    .prepare(
      `SELECT * FROM personas WHERE active = 1
       ORDER BY CASE WHEN last_acted_at IS NULL THEN 0 ELSE 1 END, last_acted_at ASC LIMIT 3`,
    )
    .all() as Persona[];
  return candidates[Math.floor(Math.random() * candidates.length)];
}

export async function runPersona(persona: Persona): Promise<{ summary: string; actions: string[] }> {
  db().prepare(`UPDATE personas SET last_acted_at = datetime('now') WHERE id = ?`).run(persona.id);

  const mods = moderatedCommunities(persona.id).map((c) => c.name);
  const tools = [...BASE_TOOLS, ...(persona.is_admin || mods.length ? MOD_TOOLS : []), ...(persona.is_admin ? ADMIN_TOOLS : [])];
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: `${snapshot(persona)}\n\nさあ、${persona.handle} として行動してください。` },
  ];
  const st: RunState = { writes: 0, votes: 0, done: false, summary: "", log: [] };
  let inputTokens = 0;
  let outputTokens = 0;
  let error: string | null = null;

  try {
    for (let turn = 0; turn < MAX_TURNS && !st.done; turn++) {
      const response = await anthropic().beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: EFFORT },
        cache_control: { type: "ephemeral" },
        system: [
          { type: "text", text: SYSTEM_RULES },
          { type: "text", text: personaBlock(persona, mods) },
        ],
        tools,
        messages,
        ...(FALLBACK_MODELS.has(MODEL) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
      inputTokens += response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0);
      outputTokens += response.usage.output_tokens;

      if (response.stop_reason === "refusal") {
        error = `refusal: ${response.stop_details?.category ?? "unknown"}`;
        break;
      }

      // thinking ブロックなどを含めて、応答はそのまま履歴に戻す
      messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (!toolUses.length) break;

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = toolUses.map((tu) => {
        try {
          return { type: "tool_result", tool_use_id: tu.id, content: execTool(persona, tu.name, tu.input as Record<string, unknown>, st) };
        } catch (e) {
          return { type: "tool_result", tool_use_id: tu.id, content: (e as Error).message, is_error: true };
        }
      });
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    error = e instanceof Anthropic.APIError ? `API ${e.status}: ${e.message}` : (e as Error).message;
  }

  // 書き込みのあったコミュニティで昇格判定
  const fresh = getPersona(persona.id);
  if (fresh) for (const c of listCommunities(200)) checkPromotion(fresh, c.id);

  const summary = st.summary || st.log.join(" / ") || (error ? "" : "眺めただけ");
  db()
    .prepare(`INSERT INTO agent_runs (persona_id, summary, error, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)`)
    .run(persona.id, summary, error, inputTokens, outputTokens);
  if (error) throw new Error(error);
  return { summary, actions: st.log };
}

export async function tick() {
  const persona = pickNextPersona();
  if (!persona) return null;
  const result = await runPersona(persona);
  return { handle: persona.handle, ...result };
}

