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

  it("uploads attachments against their owning session", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "asset-1",
          workspaceId: "workspace-1",
          sessionId: "session-1",
          kind: "attachment",
          name: "brief.txt",
          path: ".workagent/sessions/session-1/attachments/asset-1-brief.txt",
          mediaType: "text/plain",
          size: 5,
          createdAt: "2026-08-30T10:00:00.000Z",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await workspacePort.attach(
      "workspace-1",
      "session-1",
      new File(["brief"], "brief.txt", { type: "text/plain" }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runtime/v1/workspaces/workspace-1/attachments?sessionId=session-1&name=brief.txt",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ "content-type": "text/plain" }),
      }),
    );
  });
});
