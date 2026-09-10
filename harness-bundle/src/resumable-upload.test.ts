import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { WorkspaceStore } from "./workspace-store.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const bytes = async function* (value: string) {
  yield Buffer.from(value);
};
it("resumes after restart, rejects offset conflicts and publishes only a complete file", async () => {
  const root = mkdtempSync(join(tmpdir(), "wa-resume-"));
  roots.push(root);
  let store = new WorkspaceStore(join(root, "work"), join(root, "home"));
  const project = store.create("project");
  const other = store.create("other");
  const row = store.uploads.create(project.id, {
    path: "folder/report.txt",
    name: "report.txt",
    size: 6,
    lastModified: 1,
  });
  await store.uploads.append(project.id, row.id, 0, bytes("abc"));
  expect(() => store.uploads.get(other.id, row.id)).toThrow("upload_not_found");
  await expect(store.uploads.finish(project.id, row.id)).rejects.toThrow(
    "upload_incomplete",
  );
  store = new WorkspaceStore(join(root, "work"), join(root, "home"));
  expect(store.uploads.get(project.id, row.id).offset).toBe(3);
  await expect(
    store.uploads.append(project.id, row.id, 0, bytes("bad")),
  ).rejects.toThrow("upload_offset_conflict");
  await expect(
    store.uploads.append(
      project.id,
      row.id,
      3,
      (async function* () {
        yield Buffer.from("d");
        throw new Error("disconnected");
      })(),
    ),
  ).rejects.toThrow("disconnected");
  expect(store.uploads.get(project.id, row.id).offset).toBe(3);
  await store.uploads.append(project.id, row.id, 3, bytes("def"));
  await store.uploads.finish(project.id, row.id);
  expect(store.read(project.id, "folder/report.txt").toString()).toBe("abcdef");
  expect(store.uploads.list(project.id)).toEqual([]);
  const collision = store.uploads.create(project.id, {
    path: "folder/report.txt",
    name: "report.txt",
    size: 3,
    lastModified: 2,
  });
  await store.uploads.append(project.id, collision.id, 0, bytes("new"));
  await expect(store.uploads.finish(project.id, collision.id)).rejects.toThrow(
    "destination_exists",
  );
  expect(store.read(project.id, "folder/report.txt").toString()).toBe("abcdef");
  store.uploads.cancel(project.id, collision.id);
  expect(store.uploads.list(project.id)).toEqual([]);
  expect(() =>
    store.uploads.create(project.id, {
      path: "../escape",
      name: "escape",
      size: 0,
      lastModified: 0,
    }),
  ).toThrow("invalid_relative_path");
});
