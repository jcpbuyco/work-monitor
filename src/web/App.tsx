import { useEffect, useRef, useState } from "react";
import { fetchState, subscribe } from "./api.ts";
import type { State, LiveWorkflow } from "./types.ts";
import { runViewTransition } from "./viewTransition.ts";
import { Board } from "./components/Board.tsx";
import { useHashRoute } from "./useHashRoute.ts";
import { CostDailyPage } from "./components/CostDailyPage.tsx";
import { WorkflowsPage } from "./components/WorkflowsPage.tsx";

export default function App() {
  const [state, setState] = useState<State>({
    sessions: [],
    todos: [],
    activity: [],
    stats: [],
    cost: { perSession: {}, liveTotalUsd: 0, todayUsd: 0, byModelToday: [], byProject: [], byBranch: [] },
  });
  const [workflows, setWorkflows] = useState<LiveWorkflow[]>([]);
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
    // Workflow updates are applied straight through setWorkflows — no
    // runViewTransition, because a 5s token tick is not a layout change
    // worth animating.
    const unsub = subscribe({ onState: apply, onWorkflows: setWorkflows });
    return unsub;
  }, []);

  const route = useHashRoute();
  if (route === "#/cost") return <CostDailyPage />;
  if (route === "#/workflows") return <WorkflowsPage />;
  return <Board state={state} workflows={workflows} />;
}
