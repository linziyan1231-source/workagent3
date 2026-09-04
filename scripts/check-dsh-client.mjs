import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const expected = "0.1.1-rc.2";
const packageFiles = [
  "package.json",
  "harness-bundle/package.json",
  "profiles/workagent/package.json",
];

for (const relative of packageFiles) {
  const pkg = JSON.parse(await readFile(new URL(relative, root), "utf8"));
  for (const group of [pkg.dependencies ?? {}, pkg.devDependencies ?? {}]) {
    for (const [name, version] of Object.entries(group)) {
      if (name.startsWith("@deepseek-ai/dsh") && version !== expected) {
        throw new Error(
          `${relative}: ${name} must be pinned to ${expected}, got ${version}`,
        );
      }
    }
  }
}

const pluginRoot = new URL(
  "../packages/dsh-client-workagent/",
  import.meta.url,
);
const files = await readdir(pluginRoot, { recursive: true });
for (const file of files.filter(
  (name) =>
    !name.includes("node_modules") &&
    /\.(?:css|[cm]?[jt]sx?)$/.test(name) &&
    name !== "tokens.css",
)) {
  const source = await readFile(join(fileURLToPath(pluginRoot), file), "utf8");
  if (/(?:#[0-9a-f]{3,8}\b|rgba?\s*\()/i.test(source)) {
    throw new Error(`${file}: use --dsw-* tokens instead of hard-coded colors`);
  }
}

const client = await readFile(new URL("client.js", pluginRoot), "utf8");
if (/harness\s*key|type\s*[:=]\s*["']password["']/i.test(client)) {
  throw new Error("WorkAgent dsh client must not expose a Harness key input");
}
if (/AionUi/i.test(client)) {
  throw new Error("WorkAgent dsh client contains retired upstream branding");
}
if (/\b(?:window\.|globalThis\.)?prompt\s*\(/.test(client)) {
  throw new Error("WorkAgent dsh client must use inline editors, not prompt()");
}
if (!client.includes('rel = "stylesheet"') || !client.includes("tokens.css")) {
  throw new Error(
    "WorkAgent dsh client must load its external token stylesheet",
  );
}
for (const token of [
  "--dsw-radius-sm",
  "--dsw-radius-lg",
  "--dsw-font-sans",
  "--dsw-scrollbar-size",
]) {
  const tokens = await readFile(new URL("tokens.css", pluginRoot), "utf8");
  if (!tokens.includes(token))
    throw new Error(`tokens.css is missing ${token}`);
}
const composition = await readFile(
  new URL("harness-bundle/cordis.patch.yml", root),
  "utf8",
);
for (const required of [
  "@workagent/dsh-client",
  "ui-brand-official",
  "ui-settings-models",
]) {
  if (!composition.includes(required))
    throw new Error(`dsh composition is missing ${required}`);
}
console.log("dsh client policy checks passed");
