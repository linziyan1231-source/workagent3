import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";
import { bundleStyles } from "./build.mjs";

const root = fileURLToPath(new URL("./", import.meta.url));
const normalize = (path) => path.replaceAll("\\", "/");
// Changing this order is a deliberate cascade change, separate from moving or
// editing a feature's styles. Later layout refinements must retain precedence.
const cascade = [
  "features/collaboration/page.css",
  "ui/tokens.css",
  "features/capabilities/picker.css",
  "features/files/manager.css",
  "host/file-panel-layout.css",
  "host/shell.css",
  "host/hero.css",
  "features/conversations/home.css",
  "host/composer.css",
  "ui/management.css",
  "features/automations/page.css",
  "ui/overlays.css",
  "features/conversations/workspace.css",
  "host/settings.css",
  "features/projects/page.css",
  "host/settings-typography.css",
  "features/projects/empty.css",
  "app/navigation-layout.css",
  "features/files/preview.css",
  "features/collaboration/shared.css",
  "host/settings-visibility.css",
  "features/collaboration/personal-tasks.css",
  "features/marketplace/page.css",
  "features/conversations/delivery.css",
  "features/agents/settings.css",
  "features/notifications/settings.css",
  "features/content/workbench.css",
  "app/shared-responsive.css",
  "host/channels.css",
  "features/content/file-references.css",
  "features/files/moves.css",
  "features/content/replies.css",
  "features/collaboration/conversation.css",
  "app/content-layout.css",
  "features/agents/picker.css",
  "features/marketplace/history.css",
  "features/files/trash.css",
  "ui/dialog.css",
  "ui/sidebar.css",
  "ui/controls.css",
  "ui/typography.css",
].map((path) => `src/${path}`);
let styles;
beforeAll(async () => {
  styles = await bundleStyles();
}, 20000);

it("preserves the explicit cascade order in the real CSS bundle", () => {
  const entry = readFileSync(join(root, "src/styles.css"), "utf8");
  const imports = [...entry.matchAll(/^@import "\.\/(.+)";$/gm)].map(
    ([, path]) => `src/${path}`,
  );
  expect(imports).toEqual(cascade);
  const included = [
    ...styles.code.matchAll(/\/\* (src\/[^\n]+\.css) \*\//g),
  ].map(([, path]) => path);
  expect(included).toEqual([...cascade, "src/styles.css"]);
});

it("includes every source stylesheet exactly once through the CSS entry", () => {
  function cssFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? cssFiles(path)
        : entry.name.endsWith(".css")
          ? [normalize(relative(root, path))]
          : [];
    });
  }
  expect(new Set(cascade).size).toBe(cascade.length);
  expect(Object.keys(styles.metafile.inputs).map(normalize).sort()).toEqual(
    cssFiles(join(root, "src")).sort(),
  );
  expect(Object.keys(styles.metafile.inputs)).toHaveLength(cascade.length + 1);
});

it("keeps upstream DOM class dependencies in host or shared app layout styles", () => {
  const violations = cascade
    .filter((path) => path.startsWith("src/features/"))
    .filter((path) =>
      /(?:hHd-Xa|VOzbGW|wSkVaW|pXSMma|uV2eYG|Sh0Q9G|gdEzaW)_/.test(
        readFileSync(join(root, path), "utf8"),
      ),
    );
  expect(violations).toEqual([]);
});

it("publishes the generated stylesheet at the existing tokens.css path", () => {
  expect(readFileSync(join(root, "tokens.css"), "utf8")).toBe(styles.code);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(pkg.exports["./tokens.css"]).toBe("./tokens.css");
  expect(pkg.files).toContain("tokens.css");
});
