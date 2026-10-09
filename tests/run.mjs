// Bundles a TypeScript suite with esbuild and runs it in node.
// Usage: node tests/run.mjs logic|dom|live
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const name = process.argv[2];
if (!name) {
  console.error("usage: node tests/run.mjs <suite>");
  process.exit(2);
}

mkdirSync(".tmp", { recursive: true });
const outfile = `.tmp/${name}.cjs`;

await build({
  entryPoints: [`tests/${name}.ts`],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile,
  alias: { obsidian: "./tests/obsidian-stub.ts" },
  external: ["jsdom"],
  logLevel: "warning",
});

const run = spawnSync(process.execPath, [outfile], { stdio: "inherit", env: process.env });
process.exit(run.status ?? 1);
