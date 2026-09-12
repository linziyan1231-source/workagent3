import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";
import prettier from "prettier";

const root = new URL("./", import.meta.url);

export async function bundleStyles({ minify = false } = {}) {
  const result = await build({
    absWorkingDir: fileURLToPath(root),
    entryPoints: ["src/styles.css"],
    bundle: true,
    target: "es2023",
    charset: "utf8",
    legalComments: "none",
    minify,
    write: false,
    metafile: true,
  });
  const code = minify
    ? result.outputFiles[0].text
    : await prettier.format(result.outputFiles[0].text, { parser: "css" });
  return { code, metafile: result.metafile };
}

// DSH supplies these modules. Bundling a second React instance breaks hooks.
export async function bundleClient() {
  const result = await build({
    absWorkingDir: fileURLToPath(root),
    entryPoints: ["src/client.js"],
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2023",
    charset: "utf8",
    external: ["react", "@deepseek-ai/dsh-client-ui-primitives"],
    write: false,
    metafile: true,
  });
  const crypto = await readFile(new URL("src/host/crypto.js", root), "utf8");
  const code = await prettier.format(
    `${crypto}\nwindow.__ModuleLoader__.load({
      id: "@workagent/dsh-client",
      factory: (require) => {
        const module = { exports: {} };
        const exports = module.exports;
        ${result.outputFiles[0].text}
        return module.exports;
      },
    });`,
    { parser: "babel" },
  );
  return { code, metafile: result.metafile };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [client, styles] = await Promise.all([bundleClient(), bundleStyles()]);
  await writeFile(new URL("client.js", root), client.code);
  await writeFile(new URL("tokens.css", root), styles.code);
}
