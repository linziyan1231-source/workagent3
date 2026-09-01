import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));
const forbiddenOwnerDetails = [
  "portal.db",
  "runtime_credentials",
  "password_hash",
  "notification_receipts",
  "audit_events",
  "shared_projects",
];

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (entry.name.endsWith(".test.ts")) return [];
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  });

describe("Harness plugin boundary", () => {
  it("does not know Portal or data-owner persistence details", () => {
    const violations = sourceFiles(sourceRoot).flatMap((file) => {
      const content = readFileSync(file, "utf8").toLowerCase();
      return forbiddenOwnerDetails
        .filter((token) => content.includes(token))
        .map((token) => `${relative(sourceRoot, file)} references ${token}`);
    });
    expect(violations).toEqual([]);
  });

  it("keeps Broker-owned Provider secrets out of the DSH file credential store", () => {
    const patch = readFileSync(
      join(sourceRoot, "..", "cordis.patch.yml"),
      "utf8",
    );
    expect(patch).toContain(
      'name: "@deepseek-ai/dsh-credentials-local"\n  disabled: true',
    );
    expect(patch).toContain(
      'name: "@workagent/harness-bundle/dist/credential-provider.js"',
    );
  });
});
