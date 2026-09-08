// Guest builds consume only this package-owned transport output. They do not
// compile the CLI's command catalog, parsers, renderers, or executable entries.
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await build({
  entryPoints: ["transport", "stream", "errors"].map(name => resolve(cli, `src/${name}.ts`)),
  outdir: resolve(cli, "dist"),
  bundle: false,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: false,
  legalComments: "none",
});
