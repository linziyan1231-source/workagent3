import { afterEach, describe, expect, it, vi } from "vitest";
import { workspacePort } from "./workspacePort.js";

afterEach(() => vi.unstubAllGlobals());

describe("WorkspacePort", () => {
  it("uses workspace IDs and relative paths through the runtime proxy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            name: "report.txt",
            path: "reports/report.txt",
            kind: "file",
            size: 12,
            modifiedAt: "2026-08-30T10:00:00.000Z",
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await workspacePort.files("workspace-1", "reports");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runtime/v1/workspaces/workspace-1/files?path=reports",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(JSON.stringify(fetchMock.mock.calls)).not.toMatch(/[A-Z]:\\/);
  });
});
