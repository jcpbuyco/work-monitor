import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";

// NodeURL (not the global `URL`) is deliberate: this suite runs under the
// jsdom test environment, whose global `URL` mis-resolves a relative URL
// against a `file://` base (it silently falls back to `http://localhost:3000/…`
// instead), which then throws "The URL must be of scheme file" out of
// fileURLToPath. Node's own URL constructor resolves it correctly.
const ROOT = fileURLToPath(new NodeURL("../src/web/", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("motion gating", () => {
  it("uses no stock Tailwind animate-* utility anywhere in src/web", () => {
    // Tailwind's animate-* classes carry no `.am-anim` ancestor requirement, so
    // they keep running with the Motion toggle OFF. Every animation in this app
    // must go through an `.am-anim`-gated class in styles.css instead.
    const offenders = walk(ROOT)
      .filter((f) => /\.(ts|tsx|css|html)$/.test(f))
      .filter((f) => /\banimate-/.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f))
      .sort(); // readdirSync order is filesystem-defined; sort so the failure message is stable
    expect(offenders).toEqual([]);
  });
});
