import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** Preload the Latin Inter file so the first paint already uses it. Fontsource
 *  ships `font-display: swap` and the browser only discovers the font after the
 *  CSS has loaded, so without this the page painted in the fallback font and
 *  then re-laid out in Inter, shifting the header and every line of text. The
 *  file name carries a build hash, so it is looked up in the output bundle. */
function preloadInter(): Plugin {
  return {
    name: "am-preload-inter",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const file = Object.keys(ctx.bundle ?? {}).find((f) => /inter-latin-wght-normal-[\w-]+\.woff2$/.test(f));
        if (!file) return [];
        return [
          {
            tag: "link",
            attrs: { rel: "preload", as: "font", type: "font/woff2", href: `/${file}`, crossorigin: "" },
            injectTo: "head-prepend",
          },
        ];
      },
    },
  };
}

export default defineConfig({
  root: "src/web",
  plugins: [react(), preloadInter()],
  server: {
    port: 5317,
    proxy: {
      "/api": "http://127.0.0.1:4317",
      "/events": "http://127.0.0.1:4317",
      "/mcp": "http://127.0.0.1:4317",
    },
  },
  build: { outDir: "../../dist/web", emptyOutDir: true },
});
