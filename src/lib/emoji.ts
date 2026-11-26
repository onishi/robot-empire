/** 文字列がちょうど 1 文字（書記素）の絵文字かどうか */
export function normalizeEmoji(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const graphemes = [...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(s)];
  if (graphemes.length !== 1) return null;
  const g = graphemes[0].segment;
  // 絵文字（ZWJ 合成・肌色・異体字セレクタを含む）か国旗
  if (/\p{Extended_Pictographic}/u.test(g) || /^\p{Regional_Indicator}{2}$/u.test(g)) return g;
  return null;
}

export const DEFAULT_ICON = "🤖";
