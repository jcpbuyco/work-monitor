import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { fetchState, subscribe } from "./api.ts";
import type { State } from "./types.ts";
import { Board } from "./components/Board.tsx";

type DocWithVT = Document & { startViewTransition?: (cb: () => void) => unknown };

/** Animate layout changes (cards moving between status columns, feed rows
 *  sliding down as new ones arrive) by committing the new state inside a view
 *  transition. Skipped when unsupported or when reduced motion is requested. */
function canViewTransition(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof (document as DocWithVT).startViewTransition === "function" &&
    document.documentElement.classList.contains("wm-anim")
  );
}

export default function App() {
  const [state, setState] = useState<State>({ sessions: [], todos: [], activity: [] });
  const ready = useRef(false);

  useEffect(() => {
    const apply = (next: State) => {
      // First paint (or no VT support): commit directly, no transition.
      if (ready.current && canViewTransition()) {
        (document as DocWithVT).startViewTransition!(() => flushSync(() => setState(next)));
      } else {
        setState(next);
      }
      ready.current = true;
    };
    fetchState().then(apply).catch(() => {});
    const unsub = subscribe(apply);
    return unsub;
  }, []);

  return <Board state={state} />;
}
