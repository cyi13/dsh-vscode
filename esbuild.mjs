import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: false,
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("[esbuild] watching…");
} else {
  await build(options);
  console.log("[esbuild] build done");
}
