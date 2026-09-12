import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorkspaceStore } from "./workspace-store.js";
import { nativeFileInput } from "./native-images.js";
import { fileReferenceText } from "@workagent/contracts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wa-file-moves-"));
  roots.push(root);
  const store = new WorkspaceStore(join(root, "files"), join(root, "home"));
  const id = store.create("文书").id;
  return {
    root,
    store,
    id,
    reload: () => new WorkspaceStore(join(root, "files"), join(root, "home")),
  };
}
it("moves a batch, updates artifacts and stable/legacy links, survives restart and undoes without overwriting", () => {
  const f = fixture();
  const original = f.store.write(
    f.id,
    "港科 finance.docx",
    Buffer.from("original"),
  );
  f.store.write(f.id, "说明.txt", Buffer.from("notes"));
  f.store.registerArtifact(f.id, "session", original.path);
  const op = f.store.moves.request(f.id, [
    { source: original.path, destination: "历史参考文件/" + original.path },
    { source: "说明.txt", destination: "历史参考文件/说明.txt" },
  ]);
  expect(op.state).toBe("completed");
  const store = f.reload();
  expect(store.locate(f.id, original.path, original.fileId).path).toBe(
    "历史参考文件/" + original.path,
  );
  expect(store.locate(f.id, original.path, undefined, true).fileId).toBe(
    original.fileId,
  );
  expect(store.listAssets(f.id, "session")[0]?.path).toBe(
    "历史参考文件/" + original.path,
  );
  expect(
    nativeFileInput(
      store,
      f.id,
      fileReferenceText({ ...original, workspaceId: f.id }),
    ),
  ).toContain("历史参考文件");
  expect(store.moves.undo(f.id, op.id).state).toBe("completed");
  expect(store.read(f.id, original.path).toString()).toBe("original");
});
it("never opens a replacement file for a deleted identity or redirects a new identity to an old alias", () => {
  const { store, id } = fixture();
  const first = store.write(id, "稿件.txt", Buffer.from("first"));
  store.moves.request(id, [
    { source: first.path, destination: "历史/稿件.txt" },
  ]);
  const second = store.write(id, first.path, Buffer.from("second"));
  expect(first.fileId).not.toBe(second.fileId);
  expect(store.locate(id, first.path, first.fileId).path).toBe("历史/稿件.txt");
  expect(store.locate(id, second.path, second.fileId).path).toBe("稿件.txt");
  store.delete(id, "历史/稿件.txt");
  store.write(id, "历史/稿件.txt", Buffer.from("replacement"));
  expect(() => store.locate(id, first.path, first.fileId)).toThrow(
    "file_not_found",
  );
});
it("moves an entire directory including unlisted descendants and rejects self, subtree, overlap and conflicts", () => {
  const { store, id } = fixture();
  store.mkdir(id, "资料/子目录");
  writeFileSync(join(store.engineRoot(id), "资料/子目录/未列出.txt"), "bytes");
  for (const destination of [
    "资料",
    "资料/自身",
    "../escape",
    ".workagent/internal",
  ])
    expect(() =>
      store.moves.request(id, [{ source: "资料", destination }]),
    ).toThrow();
  store.write(id, "same.txt", Buffer.from("keep"));
  expect(() =>
    store.moves.request(id, [
      { source: "资料", destination: "归档" },
      { source: "same.txt", destination: "same.txt" },
    ]),
  ).toThrow();
  expect(store.listFiles(id).some((row) => row.path === "资料")).toBe(true);
  expect(
    store.moves.request(id, [{ source: "资料", destination: "归档" }]).state,
  ).toBe("completed");
  expect(store.locate(id, "资料/子目录/未列出.txt", undefined, true).path).toBe(
    "归档/子目录/未列出.txt",
  );
});
it("queues behind running agents and dirty editors, revalidates conflicts, supports cancellation and retains pending work after restart", () => {
  const f = fixture();
  f.store.write(f.id, "paper.txt", Buffer.from("old"));
  f.store.moves.busy = () => true;
  const op = f.store.moves.request(f.id, [
    { source: "paper.txt", destination: "历史/paper.txt" },
  ]);
  expect(op.state).toBe("queued");
  expect(f.store.read(f.id, "paper.txt").toString()).toBe("old");
  f.store.moves.lease(f.id, "editor-123456", "paper.txt");
  const store = f.reload();
  store.moves.drain(f.id);
  expect(store.moves.list(f.id)[0]?.state).toBe("queued");
  store.write(f.id, "paper.txt", Buffer.from("saved edit"));
  store.moves.lease(f.id, "editor-123456", undefined);
  store.moves.drain(f.id);
  expect(store.read(f.id, "历史/paper.txt").toString()).toBe("saved edit");
  store.moves.busy = () => true;
  const undo = store.moves.undo(f.id, op.id);
  store.moves.cancel(f.id, undo.id);
  store.moves.busy = () => false;
  store.moves.drain(f.id);
  expect(store.moves.list(f.id).at(-1)?.state).toBe("cancelled");
  store.moves.busy = () => true;
  const collision = store.moves.undo(f.id, op.id);
  store.write(f.id, "paper.txt", Buffer.from("new file"));
  store.moves.busy = () => false;
  store.moves.drain(f.id);
  expect(collision).toMatchObject({
    state: "failed",
    error: "destination_exists",
    applied: 0,
  });
  expect(store.read(f.id, "paper.txt").toString()).toBe("new file");
});
it("keeps both collision names and prevents a stale undo from moving another file", () => {
  const { store, id } = fixture();
  store.write(id, "a.txt", Buffer.from("a"));
  store.write(id, "历史/a.txt", Buffer.from("b"));
  const op = store.moves.request(
    id,
    [{ source: "a.txt", destination: "历史/a.txt" }],
    true,
  );
  expect(op.moves[0]?.destination).toBe("历史/a (1).txt");
  store.delete(id, "历史/a (1).txt");
  store.write(id, "历史/a (1).txt", Buffer.from("other"));
  expect(() => store.moves.undo(id, op.id)).toThrow("file_not_found");
});
it("recovers the rename-before-journal crash window without copying or losing identity", () => {
  const f = fixture();
  const file = f.store.write(f.id, "paper.txt", Buffer.from("saved"));
  f.store.moves.busy = () => true;
  const op = f.store.moves.request(f.id, [
    { source: "paper.txt", destination: "历史/paper.txt" },
  ]);
  const index = join(f.root, "home/workagent/file-moves.json");
  const state = JSON.parse(readFileSync(index, "utf8"));
  state.operations[0].state = "moving";
  writeFileSync(index, JSON.stringify(state));
  mkdirSync(join(f.store.engineRoot(f.id), "历史"));
  renameSync(
    join(f.store.engineRoot(f.id), "paper.txt"),
    join(f.store.engineRoot(f.id), "历史/paper.txt"),
  );
  const store = f.reload();
  expect(store.moves.list(f.id)[0]).toMatchObject({
    id: op.id,
    state: "completed",
    applied: 1,
  });
  expect(store.locate(f.id, file.path, file.fileId).path).toBe(
    "历史/paper.txt",
  );
});
it("holds moves throughout streaming writes and emits only changes newer than the session cursor", async () => {
  const { store, id } = fixture();
  store.mkdir(id, "资料");
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const write = store.writeStream(
    id,
    "资料/upload.txt",
    (async function* () {
      await gate;
      yield Buffer.from("upload");
    })(),
  );
  const op = store.moves.request(id, [{ source: "资料", destination: "历史" }]);
  expect(op.state).toBe("queued");
  finish();
  await write;
  store.moves.drain(id);
  expect(store.read(id, "历史/upload.txt").toString()).toBe("upload");
  const context = store.moves.context(id);
  expect(context.text).toContain('"to":"历史"');
  expect(store.moves.context(id, context.revision).text).toBe("");
  expect(existsSync(join(store.engineRoot(id), "资料"))).toBe(false);
});
