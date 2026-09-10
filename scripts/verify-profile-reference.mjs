import assert from "node:assert/strict";
import { lstatSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";

const [privatePath, publicPath] = process.argv.slice(2);
assert(privatePath && publicPath, "private and public profiles required");
const privateRoot = resolve(privatePath);
const publicRoot = realpathSync(resolve(publicPath));
assert(!lstatSync(privateRoot).isSymbolicLink(), "configuration must remain private");
assert(lstatSync(join(privateRoot, "node_modules")).isSymbolicLink(), "copied dependencies are forbidden");
assert.equal(realpathSync(join(privateRoot, "node_modules")), realpathSync(join(publicRoot, "node_modules")));
const local = createRequire(join(privateRoot, "package.json"));
const shared = createRequire(join(publicRoot, "package.json"));
const entries = {};
for (const name of ["@deepseek-ai/dsh/lib/bin.js", "@workagent/harness-bundle", "@workagent/dsh-client"]) {
  entries[name] = realpathSync(local.resolve(name));
  assert.equal(entries[name], realpathSync(shared.resolve(name)), `${name} uses stale software`);
}
console.log(JSON.stringify({ privateRoot, publicRoot, entries, referenced: true }));
