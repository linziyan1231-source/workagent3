import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "./workspace-store.js";

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "workagent-workspace-"));
  return new WorkspaceStore(join(root, "files"), join(root, "dsh"));
};

describe("WorkspaceStore", () => {
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
    const workspaceRoot = join(root, "files", workspace.id);
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
});
