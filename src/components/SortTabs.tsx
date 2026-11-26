import Link from "next/link";

export function SortTabs({ base, current }: { base: string; current: string }) {
  const tabs = [
    ["hot", "🔥 人気"],
    ["new", "🆕 新着"],
    ["top", "🏆 トップ"],
  ] as const;
  return (
    <nav className="tabs">
      {tabs.map(([k, label]) => (
        <Link key={k} href={`${base}?sort=${k}`} className={current === k ? "active" : ""}>{label}</Link>
      ))}
    </nav>
  );
}
