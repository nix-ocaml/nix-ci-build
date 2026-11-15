import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

await mkdir(new URL("./dist/", import.meta.url), { recursive: true });
await build({
  absWorkingDir: fileURLToPath(new URL(".", import.meta.url)),
  entryPoints: ["web/app.jsx"],
  outfile: "dist/app.js",
  bundle: true,
  format: "iife",
  target: ["es2022"],
  jsx: "automatic",
  sourcemap: true,
  minify: false,
  define: { "process.env.NODE_ENV": '"production"' },
  loader: {
    ".woff": "file",
    ".woff2": "file",
    ".ttf": "file",
    ".svg": "file",
    ".png": "file",
  },
  assetNames: "assets/[name]-[hash]",
  logLevel: "info",
});
await writeFile(
  new URL("./dist/index.html", import.meta.url),
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><link rel="icon" href="data:,">
<title>Build Observatory</title><link rel="stylesheet" href="/app.css"></head>
<body><div id="root"></div><script src="/app.js"></script></body></html>`,
);
