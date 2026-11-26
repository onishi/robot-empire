import { currentUser } from "@/lib/auth";
import { listThreads } from "@/lib/forum";
import { ThreadList } from "@/components/ThreadList";
import { SortTabs } from "@/components/SortTabs";

export default async function Home({ searchParams }: { searchParams: Promise<{ sort?: string }> }) {
  const { sort: s } = await searchParams;
  const sort = s === "new" || s === "top" ? s : "hot";
  const user = await currentUser();
  const threads = listThreads({ sort, limit: 50 });
  return (
    <>
      <SortTabs base="/" current={sort} />
      <ThreadList threads={threads} userId={user?.id ?? null} />
    </>
  );
}
