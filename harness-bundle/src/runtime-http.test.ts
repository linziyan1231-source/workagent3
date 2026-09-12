import { readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { expect, it } from "vitest";
import { authorized } from "./runtime-http.js";

it("authenticates without loading the composition entry", () => {
  const request = (authorization?: string) =>
    ({ headers: { authorization } }) as IncomingMessage;
  expect(authorized(request("Bearer secret"), "secret")).toBe(true);
  for (const value of [
    undefined,
    "secret",
    "Basic secret",
    "Bearer wrong!",
    "Bearer 长度不同",
    "Bearer ",
  ])
    expect(authorized(request(value), "secret")).toBe(false);
});

it("runtime modules never import the bundle composition entry", () => {
  const source = new URL("./", import.meta.url);
  const offenders = readdirSync(source)
    .filter(
      (name) =>
        name.endsWith(".ts") &&
        name !== "index.ts" &&
        !name.endsWith(".test.ts"),
    )
    .filter((name) =>
      /(?:from\s*|import\s*\()\s*["']\.\/index\.js["']/.test(
        readFileSync(new URL(name, source), "utf8"),
      ),
    );
  expect(offenders).toEqual([]);
});
