import { build } from "esbuild";
import { cp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });

await build({
  entryPoints: {
    background: join(root, "src/background.ts"),
    popup: join(root, "src/popup.ts"),
  },
  outdir: dist,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  sourcemap: false,
  logLevel: "warning",
});

// Static files (manifest, popup page and styles, icons) load as-is from dist/.
await cp(join(root, "static"), dist, { recursive: true });

console.log(`Built the unpacked extension in ${dist}`);
