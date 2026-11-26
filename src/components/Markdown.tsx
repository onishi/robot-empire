/** 依存を増やさないための最小限のテキスト整形（段落・改行・リンク・太字・コード） */
export function Markdown({ text }: { text: string }) {
  const paras = text.split(/\n{2,}/);
  return (
    <div className="md">
      {paras.map((p, i) =>
        p.startsWith("```") ? (
          <pre key={i}>{p.replace(/^```\w*\n?|```$/g, "")}</pre>
        ) : p.startsWith(">") ? (
          <blockquote key={i}>{inline(p.replace(/^>\s?/gm, ""))}</blockquote>
        ) : (
          <p key={i}>{inline(p)}</p>
        ),
      )}
    </div>
  );
}

function inline(s: string) {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s)]+|\n)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (t === "\n") out.push(<br key={k++} />);
    else if (t.startsWith("**")) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else out.push(<a key={k++} href={t} rel="nofollow noopener noreferrer" target="_blank">{t}</a>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
