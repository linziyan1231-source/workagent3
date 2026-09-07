import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "./workspace-store.js";
import { migrateWorkspaceDirectories } from "./workspace-directory-migration.js";

const setup = (names = ["项目甲", "项目乙"]) => {
  const root = mkdtempSync(join(tmpdir(), "workagent-directory-migration-"));
  const files = join(root, "files");
  const home = join(root, "home");
  mkdirSync(join(home, "workagent"), { recursive: true });
  const projects = names.map((name, index) => ({
    id: `workspace-${index}`,
    name,
    createdAt: "2026-09-06T00:00:00Z",
  }));
  for (const project of projects) {
    mkdirSync(join(files, project.id, "nested"), { recursive: true });
    writeFileSync(join(files, project.id, "nested", "data.txt"), project.id);
  }
  writeFileSync(
    join(home, "workagent", "workspaces.json"),
    JSON.stringify(projects),
  );
  writeFileSync(
    join(home, "workagent", "sessions.json"),
    JSON.stringify([
      {
        id: "session",
        nativeId: "native",
        engine: "codex",
        title: "保留会话",
        workspaceId: projects[0]!.id,
        workspacePath: join(files, projects[0]!.id),
        createdAt: "2026-09-06",
        updatedAt: "2026-09-06",
      },
    ]),
  );
  return { files, home, projects };
};

describe("project directory migration", () => {
  it("preserves files, IDs and explicit session paths and does not repeat after a display rename", () => {
    const { files, home, projects } = setup();
    const legacy = new WorkspaceStore(files, home);
    const asset = legacy.addAttachment(
      projects[0]!.id,
      "session",
      "附件.txt",
      "text/plain",
      Buffer.from("附件"),
    );
    expect(migrateWorkspaceDirectories(files, home, true)).toHaveLength(2);
    expect(existsSync(join(files, projects[0]!.id))).toBe(true);
    expect(migrateWorkspaceDirectories(files, home)).toHaveLength(2);
    const store = new WorkspaceStore(files, home);
    expect(store.engineRoot(projects[0]!.id)).toBe(join(files, "项目甲"));
    expect(store.read(projects[0]!.id, "nested/data.txt").toString()).toBe(
      projects[0]!.id,
    );
    expect(store.read(projects[0]!.id, asset.path).toString()).toBe("附件");
    expect(
      JSON.parse(
        readFileSync(join(home, "workagent", "sessions.json"), "utf8"),
      )[0],
    ).toMatchObject({
      workspaceId: projects[0]!.id,
      workspacePath: join(files, "项目甲"),
    });
    store.rename(projects[0]!.id, "改显示名称");
    expect(migrateWorkspaceDirectories(files, home)).toEqual([]);
    expect(new WorkspaceStore(files, home).engineRoot(projects[0]!.id)).toBe(
      join(files, "项目甲"),
    );
  });

  it("detects duplicate names and existing folders before moving any files", () => {
    const { files, home, projects } = setup(["重复", "重复"]);
    expect(() => migrateWorkspaceDirectories(files, home)).toThrow(
      "workspace_directory_exists",
    );
    for (const project of projects)
      expect(existsSync(join(files, project.id, "nested", "data.txt"))).toBe(
        true,
      );
    const other = setup();
    mkdirSync(join(other.files, "项目乙"));
    expect(() => migrateWorkspaceDirectories(other.files, other.home)).toThrow(
      "workspace_directory_exists",
    );
    expect(existsSync(join(other.files, "workspace-0"))).toBe(true);
  });

  it("resumes an interrupted journal without overwriting a destination", () => {
    const { files, home, projects } = setup();
    const moves = migrateWorkspaceDirectories(files, home, true);
    writeFileSync(
      join(home, "workagent", "workspace-directory-migration.json"),
      JSON.stringify({
        complete: false,
        moves,
        projects: projects.map((p) => ({ ...p, directory: p.name })),
      }),
    );
    renameSync(moves[0]!.source, moves[0]!.destination);
    expect(migrateWorkspaceDirectories(files, home)).toHaveLength(2);
    expect(
      new WorkspaceStore(files, home)
        .read(projects[0]!.id, "nested/data.txt")
        .toString(),
    ).toBe(projects[0]!.id);
  });
});
