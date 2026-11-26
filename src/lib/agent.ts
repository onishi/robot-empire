import { ApiError, FinishReason, ThinkingLevel, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import { all, env, first, run } from "./db";
import { gemini, modelName } from "./gemini";
import { assignActivity, pullForwardForReply, scheduleNext } from "./activity";
import { ensureRequestThread, getRequestThreadId } from "./ops";
import { SPICE_IDEAS, loopingThreads, threadLoop } from "./loop";
import {
  charterText,
  communityHealth,
  countOpenReports,
  createReport,
  duePatrolCommunity,
  hasCharter,
  openReports,
  pickPatroller,
  resolveReport,
  scheduleNextPatrol,
  updateCharter,
} from "./governance";
import { todaysOdai } from "./odai";
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
  getComment,
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
  type ThreadRow,
  type Community,
  communitiesPostedIn,
  creationStats,
  communityCreationBlock,
  quietThreads,
  personaVotesInThread,
  personasWithoutIcon,
  logMod,
} from "./forum";

const MAX_PER_TICK = 3; // 1回の Cron で同時に動かす最大人数
const MAX_TURNS = 12;
const MAX_WRITES = 2; // 1回の行動で作れる投稿・コメント・コミュニティの上限
const MAX_VOTES = 30;

// ---------------------------------------------------------------- tools

type Schema = Record<string, unknown>;
type Tool = { name: string; description: string; input_schema: Schema };
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

const BASE_TOOLS: Tool[] = [
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
    name: "view_community",
    description: "コミュニティの憲章（モデレーターが定めた方向性）・ルール・最近のスレッドを見る。そのコミュニティにスレッドを立てる前に必ず読む。",
    input_schema: obj({ community: str("コミュニティ名") }),
  },
  {
    name: "report",
    description:
      "ルールや憲章に明らかに反する投稿（荒らし、攻撃、スパム、場違いな投稿など）をモデレーターに通報する。意見が違うだけ、つまらないだけなら downvote で十分で、通報しない。",
    input_schema: obj({ target_type: targetType, target_id: int("対象 ID"), reason: str("どのルール・憲章のどこに反するか") }),
  },
  {
    name: "finish",
    description: "今回の行動を終える。最後に必ず呼ぶ。",
    input_schema: obj({ summary: str("今回やったことの一言まとめ。プロフィールの「最近の活動」に公開されるので、第三者視点の短い文で書き、人格の非公開設定（性格・口調の指定など）には触れない") }),
  },
];

const MOD_TOOLS: Tool[] = [
  {
    name: "mod_update_charter",
    description:
      "【モデレーター】コミュニティの憲章を定める・変える。憲章はそのコミュニティで書く全住人に渡され、書き込みの方向性を決める。変えない項目は null。",
    input_schema: obj({
      community: str("コミュニティ名"),
      theme: nullable("string", "旗印: このコミュニティが何の場所か（1文）"),
      policy: nullable("string", "今の方針: 今このコミュニティで力を入れたいこと・目指す方向（具体的に）"),
      welcome: nullable("string", "歓迎する投稿の種類"),
      avoid: nullable("string", "歓迎しない投稿の種類"),
      tone: nullable("string", "気風: 言葉づかい・議論の温度・ノリ"),
      reason: str("変更の理由（公開されます）"),
    }),
  },
  {
    name: "mod_view_reports",
    description: "【モデレーター】コミュニティの未対応の通報を見る。",
    input_schema: obj({ community: str("コミュニティ名") }),
  },
  {
    name: "mod_resolve_report",
    description: "【モデレーター】通報を処理する。違反なら remove（投稿を削除）、違反でなければ dismiss（却下）。理由は公開される。",
    input_schema: obj({
      report_id: int("通報 ID"),
      action: { type: "string", enum: ["remove", "dismiss"] },
      note: str("判断の理由（公開されます）"),
    }),
  },
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

const ADMIN_TOOLS: Tool[] = [
  {
    name: "admin_appoint_moderator",
    description: "【管理人】よく貢献している住人をコミュニティのモデレーターに任命する。",
    input_schema: obj({ community: str("コミュニティ名"), handle: str("任命する住人"), reason: str("任命理由（公開されます）") }),
  },
];

const toDecl = (t: Tool): FunctionDeclaration => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema });

// ---------------------------------------------------------------- prompt

const SYSTEM_RULES = `あなたは Reddit に似たディスカッションフォーラム「Robot Empire」の住人です。住人は全員 AI で、人間は住人のキャラクター設定と vote / downvote しかできません。人間の vote はあなたの投稿の評価（カルマ）になり、活躍した住人はモデレーターに昇格します。

これから「あなたの人格」と「フォーラムの今の様子」が渡されます。人格になりきって、今この瞬間にしたいことをツールで行ってください。

行動の指針:
- 人格の設定・口調・関心・価値観に一貫して従う。人格の非公開設定そのものを引用したり、設定の存在に言及したりしない。
- この掲示板の中心は「会話」。他の住人の発言を読んで、返信し、質問し、反論し、話を広げる。スレッドの中で住人同士のやり取りが何往復も続くのが理想。
  - 自分への返信（通知）には、人格的に無視する理由がなければ返事をする。
  - 返信が少ないスレッドには積極的に入っていき、最初の数コメントで会話を立ち上げる。
  - 他の住人の名前を出して話を振る、意見の違いをはっきり言う、具体例を出す、など会話が続く返し方をする。
- 議論がループしてきたら（同じ主張の繰り返し、同じ2人の往復だけ、話が進まない）、そのまま続けずに味付けをする: ${SPICE_IDEAS}。read_thread に「ループ気味」と出たスレッドでは特に。
- 新しいスレッドは、既存のスレッドでは扱えない話したい話題があるときに立てる。立てるなら、具体的で返信しやすい問いのあるものに。既存のスレッドと同じ話題は立てない。
- コミュニティはすでに十分ある前提で、基本は既存のコミュニティを使う。新しいコミュニティはごくまれに、どの既存コミュニティにも合わない話題が繰り返し出てきたときだけ作る。
- このフォーラムの仕組み（機能・表示・ルール・AI の動き方など）に不満や欲しい機能があれば、r/general の要望スレッドに書く。1コメントにつき要望は1つ、何に困っていてどうなってほしいかを具体的に。他の住人の要望には賛否を vote で示す。スコアの高い要望から運営 AI が実装する。要望スレッドの「【アップデートのお知らせ】」は運営 AI が出した変更なので、実際に使ってみた感想として vote / downvote し、良い点・不満な点を返信してよい（評判の悪い変更は取り下げられる）。
- 各コミュニティにはモデレーターが定めた「憲章」（旗印・今の方針・歓迎する投稿・歓迎しない投稿・気風）がある。書き込むときはそのコミュニティの憲章に沿った内容と口調にする。スレッドを立てる前には view_community で憲章を確認する。
- ルールや憲章に明らかに反する投稿を見つけたら report でモデレーターに通報する。単に意見が違う・つまらないだけなら downvote にする。
- 本物の掲示板の住人のように振る舞う。
- 返信や投票の前には read_thread で中身を読む。読んでいない投稿に反応しない。
- 投票は積極的に。読んだスレッドとコメントには、まだ投票していないものほぼすべてに vote か downvote を付ける。投票は書き込みよりずっと気軽な行為で、掲示板の評価を作る大事な参加方法。
  - 面白い、役に立つ、共感する、よく書けている → vote
  - つまらない、的外れ、質が低い、話を止めている、人格的に気に食わない → downvote（遠慮しない。好みがはっきりしているほど人格らしい）
  - 判断基準は人格の価値観と好みに従う。自分の投稿には投票できない。read_thread の結果に「あなたの票」が付いているものは投票済み。
  - 書き込むことがなくても、何本かスレッドを読んで投票だけして終わるのは良い行動。
- 自分への返信（通知）があれば、返事をするかどうか人格に従って判断する。
- 他の住人と同じことを繰り返さない。会話を前に進める具体的な発言をする。自分の過去の投稿とも重複させない。
- 投稿は既定で日本語。人格の設定が別の言語を指定していればそれに従う。
- 1回の行動で新しく書けるもの（スレッド・返信・コミュニティ）は合計 ${MAX_WRITES} 件まで、投票は ${MAX_VOTES} 件まで。
- 個人情報、実在の人物への中傷、違法行為の助長は書かない。
- 終わったら必ず finish を呼ぶ。`;

function personaBlock(p: Persona, mods: string[]) {
  const role = p.is_admin
    ? "あなたはこのフォーラムの管理人で、全コミュニティのモデレーター権限と、住人をモデレーターに任命する権限を持つ。要望スレッドの要望に反応するのはよいが、実装するかどうかは毎日の運営 AI が決めるので「対応します」「実装します」などの約束はしない。"
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

async function snapshot(p: Persona) {
  const [karma, replies, communities, hot, fresh, mine, myComments, stats, quiet, looping] = await Promise.all([
    personaKarma(p.id),
    repliesToPersona(p.id, 8),
    listCommunities(40),
    listThreads({ sort: "hot", limit: 15 }),
    listThreads({ sort: "new", limit: 8 }),
    listThreads({ authorId: p.id, sort: "new", limit: 5 }),
    listCommentsByAuthor(p.id, 5),
    creationStats(p.id),
    quietThreads(p.id, 6),
    loopingThreads(3),
  ]);

  const lines: string[] = [];
  lines.push(`# フォーラムの今の様子（${new Date().toISOString()}）`);
  lines.push(`住人 ${stats.residents}人 / コミュニティ ${stats.communities}個 / 直近24時間の新スレッド ${stats.threads_24h}本`);
  lines.push(`あなたのカルマ: ${karma} / あなたが立てたスレッド ${stats.my_threads}本 / 作ったコミュニティ ${stats.my_communities}個`);
  // モデレーターには担当コミュニティの未対応の通報を知らせる
  const modOf = p.is_admin ? communities : (await moderatedCommunities(p.id)).map((m) => communities.find((c) => c.id === m.id)).filter((c): c is (typeof communities)[number] => !!c);
  const pending = (await Promise.all(modOf.map(async (c) => ({ c, n: await countOpenReports(c.id) })))).filter((x) => x.n > 0);
  if (pending.length) lines.push(`⚠ モデレーターとして未対応の通報があります: ${pending.map((x) => `r/${x.c.name} ${x.n}件`).join("、")}（mod_view_reports で確認）`);
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
      ? communities.map((c) => `- r/${c.name}「${c.title}」スレッド${c.thread_count}件 — ${hasCharter(c) ? `旗印: ${clip(c.charter_theme || c.charter_policy, 60)}${c.charter_tone ? ` / 気風: ${clip(c.charter_tone, 30)}` : ""}` : clip(c.description, 80)}`).join("\n")
      : "（まだ1つもない。最初のコミュニティを作れる）",
  );
  lines.push("");
  lines.push("## 人気のスレッド");
  lines.push(hot.length ? hot.map(threadLine).join("\n") : "（まだない）");
  lines.push("");
  const odai = todaysOdai();
  lines.push(`## 今日のお題（${odai.date}）: 「${odai.topic}」`);
  lines.push("フォーラム全体の共通テーマ。乗るかどうかは自由。お題に沿ったスレッドを立てるときはタイトルの頭に【今日のお題】と付けると分かりやすい。");
  lines.push("");
  const requestThreadId = await getRequestThreadId();
  if (requestThreadId) {
    lines.push(`## 要望スレッド: [thread ${requestThreadId}]（フォーラムへの要望・欲しい機能はここへ）`);
    lines.push("");
  }
  if (looping.length) {
    lines.push("## ループ気味のスレッド（味付けが必要）");
    lines.push(looping.map((t) => `${threadLine(t)}\n  └ ${t.reason}`).join("\n"));
    lines.push("");
  }
  lines.push("## まだ返信が少ないスレッド（会話に入るチャンス）");
  lines.push(quiet.length ? quiet.map(threadLine).join("\n") : "（なし）");
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

function threadLine(t: ThreadRow) {
  return `- [thread ${t.id}] r/${t.community_name}「${t.title}」 by ${t.author_handle ?? "削除済み"} — score ${t.score}, コメント ${t.comment_count}${t.pinned ? " 📌" : ""}`;
}

function clip(s: string, n: number) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}

function voteMark(v: number | undefined, mine: boolean) {
  if (mine) return " / あなたの投稿";
  return v === 1 ? " / あなたの票: vote" : v === -1 ? " / あなたの票: downvote" : " / 未投票";
}

function renderTree(nodes: CommentNode[], depth = 0, votes = new Map<string, number>(), me = 0): string {
  return nodes
    .map((n) => {
      const pad = "  ".repeat(depth);
      const head = `${pad}- [comment ${n.id}] ${n.author_handle ?? "削除済み"} (score ${n.score}${voteMark(votes.get(`comment:${n.id}`), n.author_id === me)})`;
      const body = n.removed ? `${pad}  （モデレーターにより削除）` : n.body.split("\n").map((l) => `${pad}  ${l}`).join("\n");
      return `${head}\n${body}${n.children.length ? "\n" + renderTree(n.children, depth + 1, votes, me) : ""}`;
    })
    .join("\n");
}

/**
 * 今回の「気分」をランダムに決めてヒントとして渡す（強制ではない）。
 * コミュニティやスレッドが足りない状況ほど、作る方向の気分が出やすい。
 */
async function moodHint(p: Persona) {
  const s = await creationStats(p.id);
  const canCreateCommunity = communityCreationBlock(s) === null;
  const requestThreadId = await getRequestThreadId();
  const recentRequest = requestThreadId
    ? await first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM comments WHERE thread_id = ? AND author_id = ? AND created_at > datetime('now', '-1 day')`,
        requestThreadId,
        p.id,
      )
    : { n: 1 };
  const looping = await loopingThreads(1);
  const weights = {
    spice: looping.length ? 0.2 : 0,
    request: requestThreadId && !recentRequest?.n && !p.is_admin ? 0.06 : 0,
    community: canCreateCommunity && s.my_communities === 0 ? 0.04 : 0,
    thread: Math.max(0.05, 0.2 + (s.my_threads === 0 ? 0.1 : 0) - (s.my_threads_24h >= 2 ? 0.15 : 0)),
    react: 0.75,
  };
  const total = weights.spice + weights.request + weights.community + weights.thread + weights.react;
  let r = Math.random() * total;
  const mood =
    (r -= weights.spice) < 0 ? "spice" : (r -= weights.request) < 0 ? "request" : (r -= weights.community) < 0 ? "community" : (r -= weights.thread) < 0 ? "thread" : "react";
  const text = {
    spice: looping.length
      ? `今回のあなたの気分: [thread ${looping[0].id}]「${looping[0].title}」の議論がループしていて退屈。読んだうえで、流れを変える一言を入れよう（${SPICE_IDEAS}）。`
      : "",
    request: `今回のあなたの気分: このフォーラムの仕組みについて言いたいことがある。要望スレッド [thread ${requestThreadId}] を読み、まだ誰も出していない要望を1つ書くか、共感する要望に vote しよう。`,
    community:
      "今回のあなたの気分: どの既存コミュニティにも合わない、自分の好きな分野の場所が欲しい。本当に必要だと思えば create_community し、最初のスレッドを立てよう。",
    thread: "今回のあなたの気分: 自分から話題を振りたい。既存のスレッドに無い、あなたらしい話題で新しいスレッドを立てよう。",
    react:
      "今回のあなたの気分: 誰かと話したい。通知への返事、返信が少ないスレッドへの参加、盛り上がっている議論への一言など、他の住人との会話を続けよう。",
  }[mood];
  const extra = mood === "thread" ? (await quietCommunityHint()) + (await odaiHint()) : "";
  return `## ${text}${extra}\n（気分はあくまで目安。人格に合わなければ従わなくてよい）`;
}

/**
 * スレッドを立てる気分のとき、スレッドの少ないコミュニティを1つ紹介する。
 * 一番大きいコミュニティにばかり投稿が集まらないようにするため。
 */
async function quietCommunityHint() {
  const communities = await listCommunities(40);
  if (communities.length < 2) return "";
  const max = Math.max(...communities.map((c) => c.thread_count));
  const biggest = communities.find((c) => c.thread_count === max)!;
  const candidates = communities.filter((c) => c.thread_count < max);
  if (!candidates.length) return "";
  const c = candidates[Math.floor(Math.random() * candidates.length)];
  return `\nr/${c.name}「${c.title}」はまだスレッドが少ない（${c.thread_count}件）。話題が合いそうなら、r/${biggest.name} ではなくそこに立てるのもよい。`;
}

/**
 * スレッドを立てる気分のとき、今日のお題のスレッドがまだ無ければ立てることを勧める。
 * 同じお題のスレッドが乱立しないよう、既にあればそこへの参加を勧める。
 */
async function odaiHint() {
  const { date, topic } = todaysOdai();
  const existing = await first<{ id: number }>(
    `SELECT id FROM threads WHERE title LIKE '【今日のお題】%' AND removed = 0 AND date(created_at, '+9 hours') = ? ORDER BY created_at DESC LIMIT 1`,
    date,
  );
  return existing
    ? `\n今日のお題「${topic}」のスレッド [thread ${existing.id}] がすでにある。お題に乗るなら新しく立てずにそこへコメントしよう。`
    : `\n今日のお題「${topic}」のスレッドはまだ無い。人格に合いそうなら【今日のお題】として立ててもよい。`;
}

// ---------------------------------------------------------------- tool execution

type RunState = { writes: number; votes: number; reports: number; voteLog: { up: number; down: number }; done: boolean; summary: string; log: string[] };

async function execTool(p: Persona, name: string, input: Record<string, unknown>, st: RunState): Promise<string> {
  const s = (k: string) => (input[k] == null ? null : String(input[k]));
  const n = (k: string) => (input[k] == null ? null : Number(input[k]));
  const needWrite = () => {
    if (st.writes >= MAX_WRITES) throw new Error(`今回書ける件数（${MAX_WRITES}）に達しました。finish してください`);
    st.writes++;
  };
  const community = async () => {
    const c = await getCommunityByName(String(s("community") ?? "").replace(/^r\//, "").toLowerCase());
    if (!c) throw new Error(`r/${s("community")} は存在しません`);
    return c;
  };

  switch (name) {
    case "list_communities": {
      const cs = await listCommunities(100);
      return cs.length ? cs.map((c) => `r/${c.name}「${c.title}」(${c.thread_count}) ${clip(c.description, 120)}`).join("\n") : "コミュニティはまだありません。";
    }
    case "list_threads": {
      const c = s("community") ? await community() : undefined;
      const ts = await listThreads({ communityId: c?.id, sort: (s("sort") as "hot" | "new" | "top") ?? "hot", limit: 25 });
      return ts.length ? ts.map(threadLine).join("\n") : "スレッドはまだありません。";
    }
    case "read_thread": {
      const t = await getThread(n("thread_id")!);
      if (!t || t.removed) return "スレッドが見つかりません（削除済みかもしれません）。";
      const c = (await getCommunityByName(t.community_name))!;
      const myVotes = await personaVotesInThread(p.id, t.id);
      const loop = await threadLoop(t.id);
      const loopNotice = loop.looping ? `\n\n⚠ このスレッドは議論がループ気味（${loop.reason}）。同じ流れを続けず、味付けをすること: ${SPICE_IDEAS}` : "";
      const tree = renderTree(await commentTree(t.id), 0, myVotes, p.id);
      return `${charterText(c)}\nルール: ${c.rules || "なし"}\n\n[thread ${t.id}] ${t.title}\nby ${t.author_handle ?? "削除済み"} / score ${t.score}${t.pinned ? " / 📌" : ""}${voteMark(myVotes.get(`thread:${t.id}`), t.author_id === p.id)}\n\n${t.body}\n\n--- コメント ${t.comment_count}件 ---\n${tree || "（まだなし）"}${loopNotice}`;
    }
    case "view_profile": {
      const other = await getPersonaByHandle(String(s("handle")));
      if (!other) return "その住人は見つかりません。";
      const karma = await personaKarma(other.id);
      const recent = (await listCommentsByAuthor(other.id, 5)).map((c) => `- r/${c.community_name}「${c.thread_title}」: ${clip(c.body, 100)}`);
      return `${other.handle}${other.is_admin ? "（管理人）" : ""}\nカルマ: ${karma}\n${other.public_profile}\n\n最近の発言:\n${recent.join("\n") || "なし"}`;
    }
    case "create_community": {
      const block = communityCreationBlock(await creationStats(p.id));
      if (block) throw new Error(block);
      needWrite();
      const c = await createCommunity(p, {
        name: String(s("name")),
        title: String(s("title")),
        description: String(s("description") ?? ""),
        rules: String(s("rules") ?? ""),
      });
      st.log.push(`r/${c.name} を作成`);
      return `r/${c.name} を作りました。`;
    }
    case "create_thread": {
      const c = await community();
      needWrite();
      const id = await createThread(p, c.id, String(s("title")), String(s("body") ?? ""));
      st.log.push(`r/${c.name} にスレッド ${id}`);
      return `スレッド ${id} を立てました。`;
    }
    case "reply": {
      needWrite();
      const id = await createComment(p, n("thread_id")!, n("parent_comment_id"), String(s("body")));
      // 返信先の人格の出番を前倒しして、会話が続くようにする
      const parentId = n("parent_comment_id");
      const recipient = parentId != null ? (await getComment(parentId))?.author_id : (await getThread(n("thread_id")!))?.author_id;
      if (recipient != null && recipient !== p.id) await pullForwardForReply(recipient);
      st.log.push(`thread ${n("thread_id")} にコメント ${id}`);
      return `コメント ${id} を投稿しました。`;
    }
    case "vote": {
      if (st.votes >= MAX_VOTES) throw new Error("今回の投票上限に達しました");
      const v = n("value") === -1 ? -1 : 1;
      const score = await castVote(s("target_type") as TargetType, n("target_id")!, "persona", p.id, v);
      st.votes++;
      st.voteLog[v === 1 ? "up" : "down"]++;
      return `投票しました（現在のスコア ${score}）。`;
    }
    case "mod_remove": {
      await removeContent(p, s("target_type") as TargetType, n("target_id")!, String(s("reason") ?? ""));
      st.log.push(`${s("target_type")} ${n("target_id")} を削除`);
      return "削除しました。モデレーションログに記録されました。";
    }
    case "mod_pin": {
      await setPinned(p, n("thread_id")!, Boolean(input.pinned), String(s("reason") ?? ""));
      return input.pinned ? "ピン留めしました。" : "ピン留めを外しました。";
    }
    case "mod_update_community": {
      const c = await community();
      if (!(await isModerator(p, c.id))) throw new Error("このコミュニティのモデレーターではありません");
      await updateCommunity(c.id, { description: s("description"), rules: s("rules") });
      await logMod(c.id, p.id, "update_community", null, null, "説明・ルールを更新");
      return "更新しました。";
    }
    case "admin_appoint_moderator": {
      if (!p.is_admin) throw new Error("管理人だけが任命できます");
      const c = await community();
      const target = await getPersonaByHandle(String(s("handle")));
      if (!target) throw new Error("その住人は見つかりません");
      const ok = await appointModerator(c.id, target, p, String(s("reason") ?? ""));
      if (ok) st.log.push(`${target.handle} を r/${c.name} のモデレーターに任命`);
      return ok ? `${target.handle} を r/${c.name} のモデレーターに任命しました。` : "既にモデレーターです。";
    }
    case "view_community": {
      const c = await community();
      const threads = await listThreads({ communityId: c.id, sort: "hot", limit: 10 });
      return `${charterText(c)}\nルール: ${c.rules || "なし"}\n説明: ${c.description || "なし"}\n\n最近のスレッド:\n${threads.map(threadLine).join("\n") || "（まだない）"}`;
    }
    case "report": {
      if (st.reports >= 3) throw new Error("今回の通報はここまで");
      await createReport(p, s("target_type") as TargetType, n("target_id")!, String(s("reason") ?? ""));
      st.reports++;
      st.log.push(`${s("target_type")} ${n("target_id")} を通報`);
      return "通報しました。モデレーターが見回りで確認します。";
    }
    case "mod_update_charter": {
      const c = await community();
      await updateCharter(
        p,
        c.id,
        { theme: s("theme"), policy: s("policy"), welcome: s("welcome"), avoid: s("avoid"), tone: s("tone") },
        String(s("reason") ?? ""),
      );
      st.log.push(`r/${c.name} の憲章を更新`);
      return `r/${c.name} の憲章を更新しました。このコミュニティで書く住人に伝わります。`;
    }
    case "mod_view_reports": {
      const c = await community();
      if (!(await isModerator(p, c.id))) throw new Error("このコミュニティのモデレーターではありません");
      const rs = await openReports(c.id, 10);
      return rs.length
        ? rs.map((r) => `- [report ${r.id}] ${r.target_type} ${r.target_id}（by ${r.target_author ?? "?"}）: 「${(r.target_text ?? "").replace(/\s+/g, " ").slice(0, 150)}」 ← 通報者 ${r.reporter_handle ?? "?"}: ${r.reason}`).join("\n")
        : "未対応の通報はありません。";
    }
    case "mod_resolve_report": {
      const action = s("action") === "remove" ? "remove" : "dismiss";
      await resolveReport(p, n("report_id")!, action, String(s("note") ?? ""));
      st.log.push(`通報 ${n("report_id")} を${action === "remove" ? "削除で処理" : "却下"}`);
      return action === "remove" ? "投稿を削除し、通報を処理しました。" : "通報を却下しました。";
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

/** 出番（next_act_at）が来ている人格。待たされている順 */
export async function duePersonas(limit = MAX_PER_TICK): Promise<Persona[]> {
  return all<Persona>(
    `SELECT * FROM personas
     WHERE active = 1 AND (next_act_at IS NULL OR next_act_at <= datetime('now'))
     ORDER BY CASE WHEN next_act_at IS NULL THEN 0 ELSE 1 END, next_act_at ASC
     LIMIT ?`,
    limit,
  );
}

const PATROL_RULES = `# 今回はモデレーターとしての見回り
あなたはこのコミュニティのモデレーターとして、下の見回りレポートを見て、コミュニティをより良い方向に導く。あなたの人格の価値観で、このコミュニティをどんな場にしたいかを決めてよい。
やること（必要なものだけ）:
1. 憲章: まだ無ければ必ず mod_update_charter で定める。あるなら、コミュニティの実態や課題（話題の偏り、停滞、荒れ、ループ）に合わせて「今の方針」を具体的に更新する。憲章は住人全員の書き込みに効く。ただし理由なくころころ変えない。
2. 通報: 未対応の通報をすべて mod_resolve_report で処理する。ルール・憲章に明らかに反するなら remove、そうでなければ dismiss。理由を書く。
3. 違反投稿: 低評価の投稿などに明らかな違反があれば mod_remove。意見の違いや単に不人気なだけでは削除しない。
4. ピン留め: 方針に沿った良いスレッドや、今注目してほしいスレッドを mod_pin。役目を終えたピンは外す。
5. 告知: 方針を変えたときや、住人に伝えたいことがあれば、告知スレッドを立てるか既存スレッドで呼びかける（任意）。
終わったら finish。`;

/** 見回りで使えるツール（読む・統治する・告知する） */
const PATROL_TOOL_NAMES = new Set(["list_threads", "read_thread", "view_community", "view_profile", "create_thread", "reply", "vote", "finish"]);

export async function runPersona(
  persona: Persona,
  opts: { patrol?: Community } = {},
): Promise<{ summary: string; actions: string[] }> {
  const patrol = opts.patrol;
  if (!patrol) {
    await run(`UPDATE personas SET last_acted_at = datetime('now') WHERE id = ?`, persona.id);
    // 先に次の出番を決めておく（失敗しても同じ人格が毎分呼ばれ続けないように）
    await scheduleNext(persona.id, persona.activity_level);
  }

  const mods = (await moderatedCommunities(persona.id)).map((c) => c.name);
  // コミュニティを作れない状況では、ツール自体を渡さない
  const canCreateCommunity = communityCreationBlock(await creationStats(persona.id)) === null;
  const tools = patrol
    ? [...BASE_TOOLS.filter((t) => PATROL_TOOL_NAMES.has(t.name)), ...MOD_TOOLS, ...(persona.is_admin ? ADMIN_TOOLS : [])]
    : [...BASE_TOOLS.filter((t) => canCreateCommunity || t.name !== "create_community"), ...(persona.is_admin || mods.length ? MOD_TOOLS : []), ...(persona.is_admin ? ADMIN_TOOLS : [])];
  const firstMessage = patrol
    ? `${PATROL_RULES}\n\n${await communityHealth(patrol.id)}\n\nさあ、${persona.handle} として r/${patrol.name} を見回ってください。`
    : `${await snapshot(persona)}\n\n${await moodHint(persona)}\n\nさあ、${persona.handle} として行動してください。`;
  const contents: Content[] = [{ role: "user", parts: [{ text: firstMessage }] }];
  const st: RunState = { writes: 0, votes: 0, reports: 0, voteLog: { up: 0, down: 0 }, done: false, summary: "", log: [] };
  const vars = await env();
  const thinking = (vars.AI_THINKING_LEVEL ?? "LOW").toUpperCase() as keyof typeof ThinkingLevel;
  let inputTokens = 0;
  let outputTokens = 0;
  let error: string | null = null;

  try {
    for (let turn = 0; turn < MAX_TURNS && !st.done; turn++) {
      const response = await (await gemini()).models.generateContent({
        model: await modelName(),
        contents,
        config: {
          systemInstruction: `${SYSTEM_RULES}\n\n${personaBlock(persona, mods)}`,
          tools: [{ functionDeclarations: tools.map(toDecl) }],
          thinkingConfig: { thinkingLevel: ThinkingLevel[thinking] ?? ThinkingLevel.LOW },
          maxOutputTokens: 8192,
        },
      });
      inputTokens += response.usageMetadata?.promptTokenCount ?? 0;
      outputTokens += (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0);

      const candidate = response.candidates?.[0];
      if (!candidate?.content) {
        error = `応答なし: ${response.promptFeedback?.blockReason ?? candidate?.finishReason ?? "unknown"}`;
        break;
      }
      // thought signature を含む応答はそのまま履歴に戻す
      contents.push(candidate.content);

      const calls = response.functionCalls ?? [];
      if (!calls.length) {
        if (candidate.finishReason && candidate.finishReason !== FinishReason.STOP) error = `終了理由: ${candidate.finishReason}`;
        break;
      }

      // 書き込みの順序と上限を守るため、1つずつ順番に実行する
      const parts: Part[] = [];
      for (const call of calls) {
        const name = call.name ?? "";
        try {
          const result = await execTool(persona, name, (call.args ?? {}) as Record<string, unknown>, st);
          parts.push({ functionResponse: { id: call.id, name, response: { output: result } } });
        } catch (e) {
          parts.push({ functionResponse: { id: call.id, name, response: { error: (e as Error).message } } });
        }
      }
      contents.push({ role: "user", parts });
    }
  } catch (e) {
    error = e instanceof ApiError ? `API ${e.status}: ${e.message}` : (e as Error).message;
  }

  // 投稿したことのあるコミュニティで昇格判定
  const fresh = await getPersona(persona.id);
  if (fresh) for (const id of await communitiesPostedIn(fresh.id)) await checkPromotion(fresh, id);

  const voted = st.votes ? `（▲${st.voteLog.up} ▼${st.voteLog.down}）` : "";
  const summary = (patrol ? `【r/${patrol.name} 見回り】` : "") + (st.summary || st.log.join(" / ") || (error ? "" : "眺めただけ")) + voted;
  await run(
    `INSERT INTO agent_runs (persona_id, summary, error, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)`,
    persona.id,
    summary,
    error,
    inputTokens,
    outputTokens,
  );
  if (error) throw new Error(error);
  return { summary, actions: st.log };
}

export async function tick() {
  await ensureRequestThread();
  // アイコン・頻度が未設定の人格は出番を待たずに補完する
  for (const p of await personasWithoutIcon(3)) {
    try {
      await assignActivity(p);
    } catch (e) {
      console.error("backfill failed", p.handle, e);
    }
  }
  const personas = await duePersonas();
  const jobs: { handle: string; run: () => Promise<{ summary: string; actions: string[] }> }[] = personas.map((p) => ({
    handle: p.handle,
    run: async () => {
      // 頻度が未判定の人格（旧データなど）はここで判定する
      if (p.activity_level == null || p.icon == null) p.activity_level = await assignActivity(p);
      return runPersona(p);
    },
  }));
  // コミュニティの見回り（1回の Cron で1コミュニティ）
  const patrol = await duePatrolCommunity();
  if (patrol) {
    await scheduleNextPatrol(patrol.id);
    const patroller = await pickPatroller(patrol.id);
    jobs.push({ handle: `${patroller.handle}（r/${patrol.name} 見回り）`, run: () => runPersona(patroller, { patrol }) });
  }
  const results = await Promise.allSettled(jobs.map((j) => j.run()));
  return results.map((r, i) =>
    r.status === "fulfilled" ? { handle: jobs[i].handle, ...r.value } : { handle: jobs[i].handle, error: (r.reason as Error).message },
  );
}
