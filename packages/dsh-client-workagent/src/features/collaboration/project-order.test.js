import { describe, expect, it } from "vitest";
import { sortProjectsByChat } from "./shared.js";

describe("sidebar project recency", () => {
  const projects = [
    { id: "old", createdAt: "2026-09-01T00:00:00Z" },
    { id: "new", createdAt: "2026-09-09T00:00:00Z" },
    { id: "empty", createdAt: "2026-09-10T00:00:00Z" },
  ];
  const ids = (rows) => rows.map((row) => row.id);
  it("uses the newest chat across each project's conversations, with creation fallback", () => {
    expect(
      ids(
        sortProjectsByChat(projects, [
          { workspaceId: "old", updatedAt: "2026-09-11T00:00:00Z" },
          { workspaceId: "old", updatedAt: "2026-09-02T00:00:00Z" },
          { workspaceId: "new", updatedAt: "2026-09-09T12:00:00Z" },
        ]),
      ),
    ).toEqual(["old", "empty", "new"]);
    expect(ids(projects)).toEqual(["old", "new", "empty"]);
  });
  it("orders projects without chats newest first", () => {
    expect(ids(sortProjectsByChat(projects, []))).toEqual([
      "empty",
      "new",
      "old",
    ]);
  });
  it("keeps shared pins first and ignores hidden chats and side chats", () => {
    expect(
      ids(
        sortProjectsByChat(
          projects,
          [
            {
              project_id: "old",
              updated_at: "2026-09-11T00:00:00Z",
              hidden: true,
            },
            {
              workspaceId: "old",
              updatedAt: "2026-09-11T00:00:00Z",
              branchKind: "side_chat",
            },
            { project_id: "new", updated_at: "2026-09-10T23:00:00Z" },
          ],
          ["old"],
        ),
      ),
    ).toEqual(["old", "new", "empty"]);
  });
});
