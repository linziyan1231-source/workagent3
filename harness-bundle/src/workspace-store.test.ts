import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "./workspace-store.js";

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "workagent-workspace-"));
  return new WorkspaceStore(join(root, "files"), join(root, "dsh"));
};

describe("WorkspaceStore", () => {
  it("creates files exclusively without overwriting an existing upload", () => {
    const store = setup();
    const project = store.create("Upload project");
    store.write(project.id, "资料/说明.txt", Buffer.from("original"), false);
    expect(() =>
      store.write(
        project.id,
        "资料/说明.txt",
        Buffer.from("replacement"),
        false,
      ),
    ).toThrow("destination_exists");
    expect(store.read(project.id, "资料/说明.txt").toString()).toBe("original");
    store.write(project.id, "资料/说明.txt", Buffer.from("explicit update"));
    expect(store.read(project.id, "资料/说明.txt").toString()).toBe(
      "explicit update",
    );
  });
  it("uses the project name as a fixed directory and rejects existing entries", () => {
    const root = mkdtempSync(join(tmpdir(), "workagent-named-project-"));
    const files = join(root, "files");
    const home = join(root, "home");
    const store = new WorkspaceStore(files, home);
    const project = store.create("  中文项目  ");
    expect(store.engineRoot(project.id)).toBe(join(files, "中文项目"));
    store.write(project.id, "资料/说明.txt", Buffer.from("保留内容"));
    store.rename(project.id, "新的显示名称");
    const restored = new WorkspaceStore(files, home);
    expect(restored.engineRoot(project.id)).toBe(join(files, "中文项目"));
    expect(restored.read(project.id, "资料/说明.txt").toString()).toBe(
      "保留内容",
    );
    expect(() => restored.create("中文项目")).toThrow(
      "workspace_directory_exists",
    );
    mkdirSync(join(files, "Taken"));
    expect(() => restored.create("taken")).toThrow(
      "workspace_directory_exists",
    );
    writeFileSync(join(files, "File"), "existing");
    expect(() => restored.create("File")).toThrow("workspace_directory_exists");
    expect(restored.list()).toHaveLength(1);
  });

  it.each([
    "../escape",
    "folder/name",
    "C:\\data",
    "con",
    "NUL.txt",
    "bad?name",
    "bad.",
    ".workagent-unassigned",
  ])("rejects invalid project directory name %s", (name) => {
    expect(() => setup().create(name)).toThrow("invalid_workspace_name");
  });
  it("persists metadata and performs bounded file operations", () => {
    const root = mkdtempSync(join(tmpdir(), "workagent-workspace-"));
    const files = join(root, "files");
    const dsh = join(root, "dsh");
    const store = new WorkspaceStore(files, dsh);
    const workspace = store.create("Personal project");

    store.mkdir(workspace.id, "src/components");
    store.write(workspace.id, "src/components/app.ts", Buffer.from("hello"));
    expect(store.read(workspace.id, "src/components/app.ts").toString()).toBe(
      "hello",
    );
    expect(store.listFiles(workspace.id, "src/components")).toMatchObject([
      { name: "app.ts", kind: "file", size: 5 },
    ]);

    store.move(workspace.id, "src/components/app.ts", "src/main.ts");
    store.delete(workspace.id, "src/main.ts");
    expect(store.listFiles(workspace.id, "src")).toMatchObject([
      { name: "components", kind: "directory" },
    ]);
    expect(new WorkspaceStore(files, dsh).list()).toEqual([workspace]);
  });

  it.each(["../outside", "C:\\Windows", "folder/../outside", "device:name"])(
    "rejects unsafe relative path %s",
    (path) => {
      const store = setup();
      const workspace = store.create("Project");
      expect(() => store.write(workspace.id, path, Buffer.from("x"))).toThrow(
        "invalid_relative_path",
      );
    },
  );

  it("rejects links before traversing them", () => {
    const root = mkdtempSync(join(tmpdir(), "workagent-workspace-"));
    const outside = mkdtempSync(join(tmpdir(), "workagent-outside-"));
    const store = new WorkspaceStore(join(root, "files"), join(root, "dsh"));
    const workspace = store.create("Project");
    const workspaceRoot = store.engineRoot(workspace.id);
    symlinkSync(outside, join(workspaceRoot, "escape"), "junction");

    expect(() => store.listFiles(workspace.id, "escape")).toThrow(
      "reparse_point_rejected",
    );
  });

  it("persists session attachments and registered artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "workagent-workspace-"));
    const files = join(root, "files");
    const dsh = join(root, "dsh");
    const store = new WorkspaceStore(files, dsh);
    const workspace = store.create("Project");
    const attachment = store.addAttachment(
      workspace.id,
      "session-1",
      "brief.txt",
      "text/plain",
      Buffer.from("brief"),
    );
    store.write(workspace.id, "reports/final.pdf", Buffer.from("pdf"));
    const artifact = store.registerArtifact(
      workspace.id,
      "session-1",
      "reports/final.pdf",
      undefined,
      "application/pdf",
    );

    expect(store.listFiles(workspace.id).map((entry) => entry.name)).toEqual([
      "reports",
    ]);
    expect(store.read(workspace.id, attachment.path).toString()).toBe("brief");
    expect(
      new WorkspaceStore(files, dsh).listAssets(workspace.id, "session-1"),
    ).toMatchObject([
      { id: attachment.id, kind: "attachment", name: "brief.txt" },
      { id: artifact.id, kind: "artifact", name: "final.pdf" },
    ]);
  });

  it("persists project scope and supports rename plus recoverable removal", () => {
    const root = mkdtempSync(join(tmpdir(), "workagent-workspace-"));
    const files = join(root, "files");
    const dsh = join(root, "dsh");
    const store = new WorkspaceStore(files, dsh);
    const project = store.create("Shared project", "team");
    store.write(project.id, "notes.txt", Buffer.from("keep me"));

    expect(store.rename(project.id, "Design team")).toMatchObject({
      name: "Design team",
      scope: "team",
    });
    store.remove(project.id);

    expect(store.get(project.id)).toBeUndefined();
    expect(existsSync(join(files, "Shared project"))).toBe(false);
    expect(readdirSync(join(files, ".workagent-project-trash"))).toHaveLength(
      1,
    );
    expect(new WorkspaceStore(files, dsh).list()).toEqual([]);
  });

  it("provides a hidden root for conversations without a project", () => {
    const root = mkdtempSync(join(tmpdir(), "workagent-workspace-"));
    const files = join(root, "files");
    const store = new WorkspaceStore(files, join(root, "dsh"));

    store.write("default", "notes.txt", Buffer.from("outside a project"));

    expect(store.list()).toEqual([]);
    expect(store.read("default", "notes.txt").toString()).toBe(
      "outside a project",
    );
    expect(existsSync(join(files, ".workagent-unassigned"))).toBe(true);
    expect(() => store.remove("default")).toThrow("workspace_not_found");
  });
});
