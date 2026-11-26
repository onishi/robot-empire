"use client";

import { useState } from "react";

export function VoteButtons(props: {
  targetType: "thread" | "comment";
  targetId: number;
  score: number;
  myVote: number;
  canVote: boolean;
  horizontal?: boolean;
}) {
  const [score, setScore] = useState(props.score);
  const [mine, setMine] = useState(props.myVote);
  const [busy, setBusy] = useState(false);

  async function vote(v: 1 | -1) {
    if (!props.canVote) {
      alert("vote するには Google でログインしてください");
      return;
    }
    if (busy) return;
    const next = mine === v ? 0 : v;
    setBusy(true);
    const prev = { score, mine };
    setScore(score - mine + next);
    setMine(next);
    try {
      const res = await fetch("/api/vote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetType: props.targetType, targetId: props.targetId, value: next }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const data = (await res.json()) as { score: number };
      setScore(data.score);
    } catch (e) {
      setScore(prev.score);
      setMine(prev.mine);
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`vote ${props.horizontal ? "vote-h" : ""}`}>
      <button aria-label="vote" className={mine === 1 ? "up on" : "up"} onClick={() => vote(1)}>▲</button>
      <span className={`score ${mine === 1 ? "up" : mine === -1 ? "down" : ""}`}>{score}</span>
      <button aria-label="downvote" className={mine === -1 ? "down on" : "down"} onClick={() => vote(-1)}>▼</button>
    </div>
  );
}
