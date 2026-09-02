import { afterEach, describe, expect, it, vi } from "vitest";
import { ipcBridge } from "./common.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const workspace = "workagent-workspace:workspace-1\\Personal";
const hash = "ab".repeat(32);

describe("office preview bridge", () => {
  it("converts a personal workspace Office file and returns the sandbox PDF URL", async () => {
    const fetch = vi.fn(async () => jsonResponse({ hash }));
    vi.stubGlobal("fetch", fetch);

    const result = await ipcBridge.wordPreview.start.invoke({
      file_path: "docs/report.docx",
      workspace,
    });

    expect(result).toEqual({
      url: `/api/runtime/v1/office-preview/content/${hash}.pdf`,
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/runtime/v1/office-preview/convert",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({
          workspace: "workspace-1",
          path: "docs/report.docx",
        }),
      }),
    );
  });

  it("passes through the backend error code when conversion fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "OFFICECLI_NOT_FOUND" }, 503)),
    );

    const result = await ipcBridge.pptPreview.start.invoke({
      file_path: "deck.pptx",
      workspace,
    });
    expect(result).toEqual({ url: null, error: "OFFICECLI_NOT_FOUND" });
  });

  it("maps unexpected failures to OFFICECLI_START_FAILED", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    const result = await ipcBridge.excelPreview.start.invoke({
      file_path: "book.xlsx",
      workspace,
    });
    expect(result).toEqual({ url: null, error: "OFFICECLI_START_FAILED" });
  });

  it("routes shared Office files through the owner-side portal preview", async () => {
    const url =
      "/api/portal/shared-office-preview?project_id=project_1234567890&path=docs%2Fdeck.pptx";
    const fetch = vi.fn(async () => jsonResponse({ success: true, url }));
    vi.stubGlobal("fetch", fetch);

    const result = await ipcBridge.pptPreview.start.invoke({
      file_path: "shared://project_1234567890/docs/deck.pptx",
      workspace: "shared://project_1234567890",
    });

    expect(result).toEqual({ url });
    expect(fetch).toHaveBeenCalledWith(
      "/api/portal/shared-office-preview",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          project_id: "project_1234567890",
          path: "docs/deck.pptx",
        }),
      }),
    );
  });
});

describe("workspaceOfficeWatch", () => {
  const entry = (name: string, path: string) => ({
    name,
    path,
    kind: "file",
    size: 10,
    modifiedAt: "2026-09-01T00:00:00+08:00",
  });

  it("emits fileAdded only for Office files that appear after the baseline", async () => {
    let listing = [entry("report.docx", "report.docx")];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(listing)),
    );
    vi.useFakeTimers();

    const events: Array<{ file_path: string; workspace: string }> = [];
    const unsubscribe = ipcBridge.workspaceOfficeWatch.fileAdded.on((event) =>
      events.push(event),
    );
    await ipcBridge.workspaceOfficeWatch.start.invoke({ workspace });
    // The initial listing is the baseline: pre-existing files never emit.
    expect(events).toEqual([]);

    listing = [
      entry("report.docx", "report.docx"),
      entry("deck.pptx", "deck.pptx"),
      entry("notes.md", "notes.md"),
    ];
    await vi.advanceTimersByTimeAsync(3000);

    expect(events).toEqual([
      {
        file_path: `${workspace}/deck.pptx`,
        workspace,
      },
    ]);

    await ipcBridge.workspaceOfficeWatch.stop.invoke({ workspace });
    unsubscribe();
    listing = [...listing, entry("book.xlsx", "book.xlsx")];
    await vi.advanceTimersByTimeAsync(6000);
    expect(events).toHaveLength(1);
  });

  it("ignores shared workspaces", async () => {
    const fetch = vi.fn(async () => jsonResponse([]));
    vi.stubGlobal("fetch", fetch);
    await ipcBridge.workspaceOfficeWatch.start.invoke({
      workspace: "shared://project_1234567890",
    });
    expect(fetch).not.toHaveBeenCalled();
    await ipcBridge.workspaceOfficeWatch.stop.invoke({
      workspace: "shared://project_1234567890",
    });
  });
});
