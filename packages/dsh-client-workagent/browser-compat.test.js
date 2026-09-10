import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { expect, it } from "vitest";

const source = readFileSync(
  new URL("./src/client.js", import.meta.url),
  "utf8",
);
const boot = source.slice(0, source.indexOf("window.__ModuleLoader__.load"));

it("supports HTTP browsers without randomUUID before DSH RPC loads", () => {
  const crypto = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) };
  runInNewContext(boot, { crypto });
  const ids = Array.from({ length: 128 }, () => crypto.randomUUID());
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids)
    expect(id).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
    );
});

it("preserves the native browser UUID implementation", () => {
  const randomUUID = () => "native";
  const crypto = { randomUUID };
  runInNewContext(boot, { crypto });
  expect(crypto.randomUUID).toBe(randomUUID);
});
