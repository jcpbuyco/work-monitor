# Dashboard readability (text-size control) + todo detail modal

**Date:** 2026-06-15
**Status:** Approved design — ready for implementation plan
**Scope:** `src/web/` only (plus the `tailwind.config.js` font token). No server/API/data changes — the modal shows fields already in `/api/state`.

## Motivation

Two dashboard improvements:
1. On a 4K monitor the UI text is too small (the type scale is built on the browser-default 16px root and a few hardcoded `text-[11px]` labels). The user wants a way to make it bigger.
2. Todo cards render the entire note inline, so a long hand-off note dominates the board. The user wants the card kept compact (≈4 lines) and a way to view the full todo in a modal.

## Decisions (settled during brainstorming)

- **Readability:** a user-controlled **text-size control in the app bar** (not an auto/responsive bump), persisted, scaling the whole UI via the root font-size.
- **Modal trigger:** **clicking the card** opens the detail modal; dragging still works (distinguished by a movement threshold).
- **Clamp depth:** note → 4 lines, title → 2 lines.
- **Control style:** an `A− / A+` stepper (compact) rather than an S/M/L segmented control.
- Modal is **view-only**; **todos only** (not session cards).

## 1. Text-size control

- **`src/web/useTextSize.ts`** (mirrors `useTheme`): a fixed scale `SIZES = [14, 16, 18, 20, 22]` (px), default **16**. Resolves from `localStorage["wm-text-size"]` (must be one of `SIZES`, else default). Exposes `{ size, inc, dec, canInc, canDec }`. A `useEffect` applies `document.documentElement.style.fontSize = size + "px"`. `inc`/`dec` step within `SIZES` (clamped) and persist to `localStorage`.
- **App bar:** add an `A− / A+` stepper next to the theme toggle — two buttons with `aria-label`s `"Decrease text size"` / `"Increase text size"`, each `disabled` at its clamp (`!canDec` / `!canInc`).
- **No-flash:** add an inline snippet to `index.html` `<head>` (beside the existing theme script) that applies the saved size before first paint:
  ```html
  <script>
    (function () {
      try {
        var s = Number(localStorage.getItem('wm-text-size'));
        if ([14, 16, 18, 20, 22].indexOf(s) !== -1) document.documentElement.style.fontSize = s + 'px';
      } catch (e) {}
    })();
  </script>
  ```
- **Make the scale scale:** add a rem-based font token so the smallest labels respond to the root size. In `tailwind.config.js` `theme.extend`: `fontSize: { "2xs": "0.6875rem" }`. Then replace the hardcoded `text-[Npx]` literals (`text-[11px]` and any `text-[10px]`/`text-[9px]`) wherever they appear — confirmed in `Lane.tsx`, `SessionCard.tsx`, `TodoCard.tsx` — with `text-2xs` (the implementer should `grep` for the exact set; `AppBar` currently uses `text-xs`/`text-sm`, so it likely needs none). Everything else already uses `rem` classes (`text-xs`, `text-sm`, `font-medium`, …), which scale with the root font-size automatically.

## 2. Todo line-clamp + detail modal

### Card clamp (`TodoCard.tsx`)
- Title: add `line-clamp-2`. Note: add `line-clamp-4` and **drop** `whitespace-pre-wrap` on the card (line-clamp uses `-webkit-box`; the full note keeps its formatting in the modal). Tailwind v3.4 ships `line-clamp-*` in core. Meta line unchanged.

### Click-to-open (drag-safe)
- In `Board.tsx`, give the `DndContext` a `PointerSensor` with an activation distance so a still click is a click and a ≥5px drag is a drag:
  ```ts
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  // <DndContext sensors={sensors} onDragEnd={onDragEnd}>
  ```
- `TodoCard` moves the dnd `{...listeners} {...attributes}` onto the **card root** and adds `onClick={() => onOpen(t)}`. The delete `✕` button gets `onPointerDown={(e) => e.stopPropagation()}` (so it never starts a drag) and `onClick={(e) => { e.stopPropagation(); deleteTodo(t.id); }}` (so it deletes without opening the modal). dnd-kit suppresses the click after a real drag, so dragging never opens the modal.
- `TodoCard` gains an `onOpen: (t: Todo) => void` prop.

### `TodoModal.tsx` (new) — native `<dialog>`
- Props: `{ todo: Todo | null; onClose: () => void }`. The `<dialog>` stays mounted (via a `ref`); a `useEffect` calls `dialog.showModal()` when `todo` becomes non-null and `dialog.close()` when it's null — **wrapped in `try/catch`** (jsdom's `<dialog>` support is partial; the guard keeps tests from throwing and is harmless in Chrome).
- Closes via: the `✕` button (`onClose`), **Esc** (native `dialog` `close` event → `onClose`), and **backdrop click** (`onClick` on the dialog: if `e.target === dialogEl` → `onClose`).
- Content (token-styled with `bg-card`, `border-border`, `text-foreground`, `text-muted-foreground`; `::backdrop` dimmed): full **title**; full **note** with `whitespace-pre-wrap` in a `max-h-[60vh] overflow-auto` region; meta — `→ {for_who}` (amber), `⎇ {branch}`, project, and `links` rendered as a list (each link shown as text; if it looks like a URL, an anchor). Omit any field that's null/empty.
- Rendered once by `Board`, driven by a `selectedTodo` state: `const [selected, setSelected] = useState<Todo | null>(null)`; `TodoCard onOpen={setSelected}`; `<TodoModal todo={selected} onClose={() => setSelected(null)} />`.

## 3. Files

- **New:** `src/web/useTextSize.ts`, `src/web/components/TodoModal.tsx`.
- **Modify:** `src/web/components/AppBar.tsx` (A−/A+ stepper), `src/web/index.html` (no-flash size script), `tailwind.config.js` (`2xs` token), `src/web/components/Board.tsx` (sensor + `selectedTodo` + `<TodoModal>` + pass `onOpen`), `src/web/components/TodoCard.tsx` (clamp, card-level listeners + `onClick`, ✕ stopPropagation, `onOpen` prop, `text-[11px]`→`text-2xs`), and the `text-[11px]`→`text-2xs` swap in `src/web/components/Lane.tsx` + `SessionCard.tsx`.
- **Tests:** new `web-tests/useTextSize.test.ts`, `web-tests/TodoModal.test.tsx`; update `web-tests/Board.test.tsx` (pass through unaffected) and add a `TodoCard` interaction assertion.

## 4. Testing

- **`useTextSize`** (`web-tests/useTextSize.test.ts`, jsdom): default 16 when nothing stored; reads a valid stored size; `inc`/`dec` step and clamp at the ends (`canInc`/`canDec`); applies `document.documentElement.style.fontSize`; persists to `localStorage`.
- **`TodoModal`** (`web-tests/TodoModal.test.tsx`): with a `todo`, renders its title, full note, and meta (for_who/branch/project); clicking `✕` calls `onClose`. (Don't assert native modal open state — jsdom is unreliable there; the content renders regardless.)
- **`TodoCard`**: clicking the card calls `onOpen(t)`; clicking `✕` does **not** call `onOpen` (and calls `deleteTodo`); the note element carries `line-clamp-4`.
- **Regression:** `Board.test.tsx` stays green — the asserted strings (`"Hand off spec"`, `"→ Maria"`, session texts) still render (clamping hides overflow visually but the text is in the DOM); `TodoCard` now needs an `onOpen` prop, so the Board test (which renders `<Board>`) is unaffected, but any direct `TodoCard` render must pass `onOpen`. `AppBar.test.tsx` stays green (the new A−/A+ buttons have distinct labels; counts + theme toggle queries unchanged).
- Full web suite + `typecheck` + `web:build` green.

## 5. Non-goals

- No detail modal or click-to-open for **session** cards (todos only). No edit/delete **inside** the modal (view-only; the card's `✕` still deletes). No server/API/SSE/data-model changes. No new dependencies (native `<dialog>`, Tailwind built-in `line-clamp`, existing dnd-kit `PointerSensor`).
