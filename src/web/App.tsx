import { useEffect, useState } from "react";
import { fetchState, subscribe } from "./api.ts";
import type { State } from "./types.ts";
import { Board } from "./components/Board.tsx";

export default function App() {
  const [state, setState] = useState<State>({ sessions: [], todos: [], activity: [] });

  useEffect(() => {
    fetchState().then(setState).catch(() => {});
    const unsub = subscribe(setState);
    return unsub;
  }, []);

  return <Board state={state} />;
}
