import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BrowserPdfViewer from "./BrowserPdfViewer.js";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("formal Preview browser PDF host", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("maps the Electron-only file path to the authenticated inline PDF endpoint", async () => {
    await act(async () =>
      root.render(
        <BrowserPdfViewer
          file_path="workagent-workspace:workspace-1\\Browser QA\\reports\\final.pdf"
          hideToolbar
        />,
      ),
    );

    expect(container.querySelector("webview")).toBeNull();
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
      "/api/runtime/v1/workspaces/workspace-1/content?path=reports%2Ffinal.pdf&preview=1",
    );
  });
});
