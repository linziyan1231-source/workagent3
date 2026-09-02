import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BrowserPdfViewer from "./BrowserPdfViewer.js";
import { ipcBridge } from "./common.js";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("formal Preview browser PDF host", () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    // React 19 flushes passive effect cleanups during the unmount above, so
    // the URL statics installed by shared-PDF tests must stay in place until
    // now.
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  describe("shared project PDFs", () => {
    let createObjectURL: ReturnType<typeof vi.fn>;
    let revokeObjectURL: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      createObjectURL = vi.fn(() => "blob:shared-pdf");
      revokeObjectURL = vi.fn();
      URL.createObjectURL =
        createObjectURL as unknown as typeof URL.createObjectURL;
      URL.revokeObjectURL =
        revokeObjectURL as unknown as typeof URL.revokeObjectURL;
    });

    it("renders shared:// PDFs from the shared read-buffer bytes in the same sandboxed iframe", async () => {
      const readFileBuffer = vi
        .spyOn(ipcBridge.fs.readFileBuffer, "invoke")
        .mockResolvedValue(btoa("%PDF-1.4 shared bytes"));

      await act(async () =>
        root.render(
          <BrowserPdfViewer
            file_path="shared://project-1/reports/final.pdf"
            hideToolbar
          />,
        ),
      );
      await act(async () => {});

      expect(readFileBuffer).toHaveBeenCalledWith({
        path: "shared://project-1/reports/final.pdf",
      });
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe("application/pdf");
      expect(blob.size).toBe("%PDF-1.4 shared bytes".length);
      expect(container.querySelector("webview")).toBeNull();
      expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
        "blob:shared-pdf",
      );

      await act(async () => root.unmount());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:shared-pdf");
      root = createRoot(container);
    });

    it("shows the load failure when the shared read-buffer request rejects", async () => {
      vi.spyOn(ipcBridge.fs.readFileBuffer, "invoke").mockRejectedValue(
        new Error("shared_file_operation_failed"),
      );

      await act(async () =>
        root.render(
          <BrowserPdfViewer
            file_path="shared://project-1/reports/missing.pdf"
            hideToolbar
          />,
        ),
      );
      await act(async () => {});

      expect(createObjectURL).not.toHaveBeenCalled();
      expect(container.querySelector("iframe")).toBeNull();
      expect(container.textContent).toContain("preview.pdf.loadFailed");
    });

    it.each([
      ["empty base64", ""],
      ["null buffer", null],
    ])(
      "shows the load failure when the shared read-buffer returns %s",
      async (_label, buffer) => {
        vi.spyOn(ipcBridge.fs.readFileBuffer, "invoke").mockResolvedValue(
          buffer,
        );

        await act(async () =>
          root.render(
            <BrowserPdfViewer
              file_path="shared://project-1/reports/empty.pdf"
              hideToolbar
            />,
          ),
        );
        await act(async () => {});

        expect(createObjectURL).not.toHaveBeenCalled();
        expect(container.querySelector("iframe")).toBeNull();
        expect(container.textContent).toContain("preview.pdf.loadFailed");
      },
    );
  });
});
