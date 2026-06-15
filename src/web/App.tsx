import { useEffect, useRef, useState } from "react";
import { fetchState, subscribe } from "./api.ts";
import type { State } from "./types.ts";
import { runViewTransition } from "./viewTransition.ts";
import { Board } from "./components/Board.tsx";

export default function App() {
  const [state, setState] = useState<State>({
    sessions: [],
    todos: [],
    activity: [],
    stats: [],
    cost: { perSession: {}, liveTotalUsd: 0, todayUsd: 0, byModelToday: [], byProject: [], byBranch: [] },
  });
  const ready = useRef(false);

  useEffect(() => {
    const apply = (next: State) => {
      // First paint commits directly; later updates animate layout changes
      // (cards moving between columns, todos/feed inserting & removing).
      if (ready.current) runViewTransition(() => setState(next));
      else setState(next);
      ready.current = true;
    };
    fetchState().then(apply).catch(() => {});
    const unsub = subscribe(apply);
    return unsub;
  }, []);

  return <Board state={state} />;
}
