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

  it("moves and deletes entries with relative paths", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await workspacePort.move("workspace-1", "draft.txt", "docs/final.txt");
    await workspacePort.remove("workspace-1", "docs/final.txt");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/runtime/v1/workspaces/workspace-1/move",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          source: "draft.txt",
          destination: "docs/final.txt",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/runtime/v1/workspaces/workspace-1/content?path=docs%2Ffinal.txt",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("registers an existing file as a session artifact", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json({
        id: "asset-2",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        kind: "artifact",
        name: "report.pdf",
        path: "reports/report.pdf",
        mediaType: "application/pdf",
        size: 20,
        createdAt: "2026-08-31T00:00:00Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await workspacePort.registerArtifact(
      "workspace-1",
      "session-1",
      "reports/report.pdf",
      "report.pdf",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runtime/v1/workspaces/workspace-1/assets?sessionId=session-1",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          path: "reports/report.pdf",
          name: "report.pdf",
        }),
      }),
    );
  });
});
