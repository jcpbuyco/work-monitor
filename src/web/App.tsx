import { useEffect, useRef, useState } from "react";
import { fetchState, subscribe } from "./api.ts";
import type { State, LiveWorkflow, LastRun } from "./types.ts";
import { runViewTransition } from "./viewTransition.ts";
import { Board } from "./components/Board.tsx";
import { useHashRoute } from "./useHashRoute.ts";
import { CostDailyPage } from "./components/CostDailyPage.tsx";
import { WorkflowsPage } from "./components/WorkflowsPage.tsx";

/** §5.2: the SSE stream counts as stale once this long has passed with no
 *  message at all - state OR the 5s workflows tick, either one resets it. */
const STALE_AFTER_MS = 90 * 1000;
/** How often the staleness check re-evaluates; independent of STALE_AFTER_MS
 *  so the check itself never needs sub-second precision. */
const STALE_CHECK_MS = 5 * 1000;

const EMPTY_STATE: State = {
  sessions: [],
  todos: [],
  activity: [],
  stats: [],
  cost: { perSession: {}, liveTotalUsd: 0, todayUsd: 0, byModelToday: [], byProject: [], byBranch: [] },
};

export default function App() {
  const [state, setState] = useState<State>(EMPTY_STATE);
  const [workflows, setWorkflows] = useState<LiveWorkflow[]>([]);
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  // §5.2: false until the FIRST /api/state response - gates the board's
  // skeleton rows and the AppBar's "…" counts everywhere it's rendered.
  const [ready, setReady] = useState(false);
  // §5.2: flips false once the stream has been silent past STALE_AFTER_MS.
  const [connected, setConnected] = useState(true);
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);
  const hasPainted = useRef(false);
  const lastMessageRef = useRef<number | null>(null);

  useEffect(() => {
    const bump = () => {
      lastMessageRef.current = Date.now();
      setLastMessageAt(lastMessageRef.current);
      setConnected(true);
    };
    const apply = (next: State) => {
      // First paint commits directly; later updates animate layout changes
      // (cards moving between columns, todos/feed inserting & removing).
      if (hasPainted.current) runViewTransition(() => setState(next));
      else setState(next);
      hasPainted.current = true;
      setReady(true);
      bump();
    };
    fetchState().then(apply).catch(() => {});
    // Workflow updates are applied straight through setWorkflows - no
    // runViewTransition, because a 5s token tick is not a layout change
    // worth animating.
    const unsub = subscribe({
      onState: apply,
      onWorkflows: (w) => {
        setWorkflows(w);
        bump();
      },
      onLastRun: setLastRun,
      // §5.2 fix: the server's keepalive `ping` (or the browser's own `open`
      // event on a fresh connection/reconnect) counts as a message too, so an
      // idle-but-open stream never ages into "Reconnecting…".
      onOpen: bump,
      // §5.2 fix: a dropped connection is flagged the instant EventSource
      // reports it, rather than waiting out the full staleness window.
      onClose: () => setConnected(false),
    });

    const staleCheck = setInterval(() => {
      if (lastMessageRef.current != null && Date.now() - lastMessageRef.current > STALE_AFTER_MS) setConnected(false);
    }, STALE_CHECK_MS);

    return () => {
      unsub();
      clearInterval(staleCheck);
    };
  }, []);

  const route = useHashRoute();
  // §5.1: the session row's workflow chip deep-links to "#/workflows?run=<id>"
  // - startsWith, not ===, so that query string still routes to the page
  // instead of silently falling through to the board underneath it.
  if (route === "#/cost" || route.startsWith("#/cost?")) {
    return (
      <CostDailyPage state={state} workflows={workflows} ready={ready} connected={connected} lastMessageAt={lastMessageAt} />
    );
  }
  if (route === "#/workflows" || route.startsWith("#/workflows?")) {
    return (
      <WorkflowsPage state={state} workflows={workflows} ready={ready} connected={connected} lastMessageAt={lastMessageAt} />
    );
  }
  return (
    <Board
      state={state}
      workflows={workflows}
      lastRun={lastRun}
      ready={ready}
      connected={connected}
      lastMessageAt={lastMessageAt}
    />
  );
}
