import { existsSync, readFileSync, readdirSync } from "node:fs";
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

  it("keeps visible application pages owned by the formal Web78 Renderer", () => {
    const temporaryPageReplicas = [
      "features/auth/LoginPage.tsx",
      "features/conversation/ConversationPage.tsx",
      "features/workspace/WorkspacePanel.tsx",
      "shared/ui/aionui/AionAutomationPage.tsx",
      "shared/ui/aionui/AionGuidEmptyState.tsx",
      "shared/ui/aionui/AionMessageList.tsx",
      "shared/ui/aionui/AionPresetPage.tsx",
      "shared/ui/aionui/AionSendBox.tsx",
      "shared/ui/aionui/AionSettingsSider.tsx",
      "shared/ui/aionui/AionSider.tsx",
      "shared/ui/aionui/AionTeamCreateModal.tsx",
      "shared/ui/aionui/AionTeamPage.tsx",
      "shared/ui/aionui/AionTeamSiderSection.tsx",
      "shared/ui/aionui/BrandLogo.tsx",
      "shared/ui/aionui/aionui.css",
      "shared/aion-adapter/localFilePreview.ts",
      "shared/aion-adapter/previewContext.ts",
    ];
    expect(
      temporaryPageReplicas.filter((path) =>
        existsSync(join(sourceRoot, path)),
      ),
    ).toEqual([]);

    const application = readFileSync(
      join(sourceRoot, "app", "App.tsx"),
      "utf8",
    );
    for (const formalComponent of [
      "@renderer/components/layout/Layout",
      "@renderer/components/layout/Router",
      "@renderer/components/layout/Sider",
    ]) {
      expect(application).toContain(formalComponent);
    }

    const viteConfig = readFileSync(
      join(sourceRoot, "..", "vite.config.ts"),
      "utf8",
    );
    for (const formalVisualSurface of [
      "@renderer/components/layout/Router",
      "@renderer/components/layout/Sider",
      "@renderer/pages/conversation",
      "@renderer/pages/guid",
      "@renderer/pages/login",
    ]) {
      expect(viteConfig).not.toContain(`find: "${formalVisualSurface}"`);
      expect(viteConfig).not.toContain(`find: '${formalVisualSurface}'`);
    }
    expect(viteConfig).not.toContain('adapter("previewContext.ts")');
    expect(viteConfig).not.toContain('adapter("localFilePreview.ts")');
    expect(viteConfig).toContain(
      'find: "../viewers/PDFViewer",\n        replacement: adapter("BrowserPdfViewer.tsx")',
    );
  });
});
