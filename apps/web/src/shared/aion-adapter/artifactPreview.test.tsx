import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLocalFilePreview } from "@/renderer/pages/conversation/Preview/hooks/useLocalFilePreview";
import {
  PreviewProvider,
  usePreviewContext,
} from "@/renderer/pages/conversation/Preview/context/PreviewContext";
import { ipcBridge } from "./common.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let invokePreview: ((path: string) => Promise<void>) | undefined;

function ArtifactPreviewProbe() {
  const preview = useLocalFilePreview(
    "workagent-workspace:workspace-1\\Browser QA",
  );
  const { activeTab } = usePreviewContext();
  useEffect(() => {
    invokePreview = preview;
    return () => {
      invokePreview = undefined;
    };
  }, [preview]);
  return <div>{activeTab?.content}</div>;
}

describe("formal WorkAgent2 artifact preview", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    invokePreview = undefined;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("opens a registered personal Workspace file in the unchanged formal Preview hook", async () => {
    const modifiedAt = "2026-09-01T02:00:00.000Z";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/files?")
          ? Response.json([
              {
                name: "final.md",
                path: "reports/final.md",
                kind: "file",
                size: 13,
                modifiedAt,
              },
            ])
          : new Response("artifact body", { status: 200 }),
      ),
    );

    await act(async () =>
      root.render(
        <PreviewProvider>
          <ArtifactPreviewProbe />
        </PreviewProvider>,
      ),
    );
    await act(async () => {
      await invokePreview!(
        "workagent-workspace:workspace-1\\Browser QA\\reports\\final.md",
      );
    });

    expect(container.textContent).toBe("artifact body");
  });

  it("delivers Browser writes through the formal PreviewProvider file-stream subscription", async () => {
    vi.useFakeTimers();
    const modifiedAt = "2026-09-01T02:00:00.000Z";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/files?"))
          return Response.json([
            {
              name: "final.md",
              path: "reports/final.md",
              kind: "file",
              size: 13,
              modifiedAt,
            },
          ]);
        if (init?.method === "PUT")
          return Response.json({
            name: "final.md",
            path: "reports/final.md",
            kind: "file",
            size: 12,
            modifiedAt,
          });
        return new Response("artifact body", { status: 200 });
      }),
    );
    const workspace = "workagent-workspace:workspace-1\\Browser QA";
    const path = `${workspace}\\reports\\final.md`;

    try {
      await act(async () =>
        root.render(
          <PreviewProvider>
            <ArtifactPreviewProbe />
          </PreviewProvider>,
        ),
      );
      await act(async () => invokePreview!(path));
      await act(async () => {
        await ipcBridge.fs.writeFile.invoke({
          workspace,
          path,
          data: "updated body",
        });
      });
      await act(async () => {
        vi.advanceTimersByTime(500);
        await Promise.resolve();
      });

      expect(container.textContent).toBe("updated body");
    } finally {
      vi.useRealTimers();
    }
  });

  it("detects Agent-side Workspace writes through the formal PreviewProvider polling path", async () => {
    vi.useFakeTimers();
    let modifiedAt = "2026-09-01T02:00:00.000Z";
    let content = "initial body";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/files?")
          ? Response.json([
              {
                name: "final.md",
                path: "reports/final.md",
                kind: "file",
                size: content.length,
                modifiedAt,
              },
            ])
          : new Response(content, { status: 200 }),
      ),
    );
    const path =
      "workagent-workspace:workspace-1\\Browser QA\\reports\\final.md";

    try {
      await act(async () =>
        root.render(
          <PreviewProvider>
            <ArtifactPreviewProbe />
          </PreviewProvider>,
        ),
      );
      await act(async () => invokePreview!(path));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(container.textContent).toBe("initial body");

      modifiedAt = "2026-09-01T02:00:01.000Z";
      content = "agent update";
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.textContent).toBe("agent update");
    } finally {
      vi.useRealTimers();
    }
  });
});
