import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeAll, expect, it } from "vitest";
import { bundleClient } from "./build.mjs";

const root = fileURLToPath(new URL("./", import.meta.url));
const normalize = (path) => path.replaceAll("\\", "/");
let inputs;
let outputs;

beforeAll(async () => {
  // Use the same in-memory build as the shipped DSH factory. No generated file
  // is written, and the graph reflects esbuild's actual package resolution.
  const { metafile } = await bundleClient();
  inputs = new Map(
    Object.entries(metafile.inputs).map(([path, input]) => [
      normalize(path),
      input.imports.map((entry) => ({ ...entry, path: normalize(entry.path) })),
    ]),
  );
  outputs = Object.values(metafile.outputs);
}, 20000);

function sourceEdges() {
  return [...inputs].flatMap(([from, imports]) =>
    from.startsWith("src/") ? imports.map((entry) => ({ from, ...entry })) : [],
  );
}

it("keeps pinned host DOM selectors and theme attributes out of business modules", () => {
  const violations = [...inputs.keys()]
    .filter((path) => path.startsWith("src/") && !path.startsWith("src/host/"))
    .filter((path) =>
      /(?:hHd-Xa|VOzbGW|wSkVaW|pXSMma|uV2eYG|Sh0Q9G|gdEzaW)_|data-ds-dark-theme/.test(
        readFileSync(join(root, path), "utf8"),
      ),
    );
  expect(violations).toEqual([]);
});

it("has no cycles among the source modules in the real client bundle", () => {
  const visiting = new Set();
  const visited = new Set();
  const cycles = [];
  function visit(path, trail) {
    if (visiting.has(path)) {
      cycles.push([...trail.slice(trail.indexOf(path)), path].join(" -> "));
      return;
    }
    if (visited.has(path)) return;
    visiting.add(path);
    for (const dependency of inputs.get(path) ?? [])
      if (!dependency.external && dependency.path.startsWith("src/"))
        visit(dependency.path, [...trail, path]);
    visiting.delete(path);
    visited.add(path);
  }
  for (const path of inputs.keys())
    if (path.startsWith("src/")) visit(path, []);
  expect(inputs.has("src/client.js")).toBe(true);
  expect(cycles).toEqual([]);
});

it("keeps feature and shared modules independent of app composition", () => {
  const violations = sourceEdges()
    .filter(
      ({ from, path }) =>
        /^src\/(features|ui|platform|host)\//.test(from) &&
        (path.startsWith("src/app/") || path === "src/client.js"),
    )
    .map(({ from, path }) => `${from} -> ${path}`);
  expect(violations).toEqual([]);
});

it("does not let platform or shared UI import business features", () => {
  const violations = sourceEdges()
    .filter(
      ({ from, path }) =>
        /^src\/(platform|ui)\//.test(from) && path.startsWith("src/features/"),
    )
    .map(({ from, path }) => `${from} -> ${path}`);
  expect(violations).toEqual([]);
});

it("uses the host's React and UI primitives without bundling another instance", () => {
  const hostModule = (path) =>
    /^(react|@deepseek-ai\/dsh-client-ui-primitives)(\/|$)/.test(path);
  const imports = outputs.flatMap((output) => output.imports);
  for (const name of ["react", "@deepseek-ai/dsh-client-ui-primitives"])
    expect(imports.some((entry) => entry.path === name && entry.external)).toBe(
      true,
    );
  expect(
    sourceEdges()
      .filter(({ original, path }) => hostModule(original ?? path))
      .filter(({ external }) => !external),
  ).toEqual([]);
  expect(
    [...inputs.keys()].filter((path) =>
      /node_modules\/(react|react-dom|@deepseek-ai\/dsh-client-ui-primitives)\//.test(
        path,
      ),
    ),
  ).toEqual([]);
});

it("uses contracts package exports instead of reaching into its source", () => {
  const { exports: contractExports } = JSON.parse(
    readFileSync(new URL("../contracts/package.json", import.meta.url), "utf8"),
  );
  const publicImports = new Set(
    Object.keys(contractExports).map(
      (entry) => `@workagent/contracts${entry === "." ? "" : entry.slice(1)}`,
    ),
  );
  const violations = sourceEdges()
    .filter(
      ({ path, original }) =>
        /(^|\/)contracts\//.test(path) ||
        original?.startsWith("@workagent/contracts"),
    )
    .filter(
      ({ path, original }) =>
        !publicImports.has(original) || /(^|\/)src\//.test(path),
    )
    .map(({ from, original, path }) => `${from}: ${original} -> ${path}`);
  expect(violations).toEqual([]);
});

it("declares every identifier in source modules instead of relying on concatenation scope", () => {
  function sourceFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? sourceFiles(path)
        : /\.[cm]?[jt]sx?$/.test(entry.name) &&
            !/\.(test|spec)\./.test(entry.name)
          ? [path]
          : [];
    });
  }
  const files = sourceFiles(join(root, "src"));
  const sourceSet = new Set(files.map(normalize));
  const program = ts.createProgram(files, {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    types: [],
  });
  const unbound = program
    .getSemanticDiagnostics()
    .filter(
      (diagnostic) =>
        [2304, 2552].includes(diagnostic.code) &&
        diagnostic.file &&
        sourceSet.has(normalize(diagnostic.file.fileName)),
    )
    .map((diagnostic) => {
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
        diagnostic.start,
      );
      return `${normalize(relative(root, diagnostic.file.fileName))}:${line + 1}:${character + 1} TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
    });
  expect(unbound).toEqual([]);
}, 20000);
