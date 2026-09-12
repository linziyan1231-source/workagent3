import { describe, expect, it } from "vitest";
import { workspaceContentHeaders } from "./workspace-api.js";
import { WorkspaceController } from "./workspace-api.js";
import { WorkspaceSearch } from "./workspace-search.js";
import { createServer, type RequestListener } from "node:http";

it("authenticates cursor release and binds it to its original workspace", async () => {
  const search = new WorkspaceSearch(
    () => "",
    (_id, path) => ({
      fileId: path,
      name: path,
      path,
      kind: "file",
      size: 0,
      modifiedAt: "",
    }),
  );
  search.walk = async function* () {
    yield "one";
    yield "two";
  };
  const cursor = (await search.search("first", "", undefined, 1)).nextCursor!;
  let handler!: RequestListener;
  const cleanups: Array<() => void> = [];
  new WorkspaceController(
    {
      effect: (setup: () => () => void) => {
        cleanups.push(setup());
      },
      webServer: {
        register: (route: { handler: RequestListener }) => {
          handler = route.handler;
          return () => {};
        },
      },
    } as never,
    "token",
    { search, moves: { drainAll() {} } } as never,
  );
  const server = createServer((request, response) =>
    handler(request, response),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const release = (workspace: string, token?: string) =>
    fetch(
      `http://127.0.0.1:${port}/v1/workspaces/${workspace}/search?cursor=${cursor}`,
      {
        method: "DELETE",
        headers: token ? { authorization: `Bearer ${token}` } : {},
      },
    );
  try {
    expect((await release("first")).status).toBe(401);
    expect((await release("second", "token")).status).toBe(400);
    expect((await release("first", "token")).status).toBe(204);
    expect((await release("first", "token")).status).toBe(204);
  } finally {
    for (const cleanup of cleanups) cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("Workspace content response", () => {
  it("allows authenticated same-origin PDF framing only when preview is explicit", () => {
    expect(workspaceContentHeaders("reports/final.pdf", 4, true)).toEqual({
      "cache-control": "no-store",
      "content-disposition": "inline; filename*=UTF-8''final.pdf",
      "content-length": 4,
      "content-security-policy":
        "default-src 'none'; frame-ancestors 'self'; base-uri 'none'",
      "content-type": "application/pdf",
    });
  });

  it("keeps unknown and non-preview content download-only", () => {
    expect(
      workspaceContentHeaders("reports/active.html", 7, true),
    ).toMatchObject({
      "content-disposition": "attachment; filename*=UTF-8''active.html",
      "content-type": "application/octet-stream",
    });
    expect(
      workspaceContentHeaders("reports/final.pdf", 4, false),
    ).toMatchObject({
      "content-disposition": "attachment; filename*=UTF-8''final.pdf",
      "content-type": "application/octet-stream",
    });
  });

  it("serves raster image previews inline with their real media type", () => {
    expect(workspaceContentHeaders("images/chart.png", 42, true)).toMatchObject(
      {
        "content-disposition": "inline; filename*=UTF-8''chart.png",
        "content-type": "image/png",
      },
    );
  });
});
