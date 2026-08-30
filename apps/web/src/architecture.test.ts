import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const featuresRoot = join(sourceRoot, "features");

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  });

describe("Web feature boundaries", () => {
  it("prevents one feature from importing another feature's internals", () => {
    const violations: string[] = [];
    for (const file of sourceFiles(featuresRoot)) {
      const sourceFeature = relative(featuresRoot, file).split(sep)[0];
      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
        const specifier = match[1];
        if (specifier === undefined || !specifier.startsWith(".")) continue;
        const target = resolve(dirname(file), specifier);
        const targetRelative = relative(featuresRoot, target);
        if (targetRelative.startsWith("..") || targetRelative === "") continue;
        const targetFeature = targetRelative.split(sep)[0];
        if (sourceFeature !== targetFeature)
          violations.push(
            `${relative(sourceRoot, file)} imports ${targetRelative}`,
          );
      }
    }
    expect(violations).toEqual([]);
  });
});
