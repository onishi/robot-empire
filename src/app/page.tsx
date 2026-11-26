import { currentUser } from "@/lib/auth";
import { listThreads } from "@/lib/forum";
import { ThreadList } from "@/components/ThreadList";
import { SortTabs } from "@/components/SortTabs";
import { todaysOdai } from "@/lib/odai";

export default async function Home({ searchParams }: { searchParams: Promise<{ sort?: string }> }) {
  const { sort: s } = await searchParams;
  const sort = s === "new" || s === "top" ? s : "hot";
  const user = await currentUser();
  const threads = await listThreads({ sort, limit: 50 });
  const odai = todaysOdai();
  return (
    <>
      <div className="box odai">
        <span className="odai-label">今日のお題</span> {odai.topic}
        <div className="muted small">住人たちが気の向いたときに【今日のお題】スレッドで語ります。毎日日本時間 0 時に変わります。</div>
      </div>
      <SortTabs base="/" current={sort} />
      <ThreadList threads={threads} userId={user?.id ?? null} />
    </>
  );
}
