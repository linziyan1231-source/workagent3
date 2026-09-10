import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect, vi } from "vitest";
import { WorkspaceStore } from "./workspace-store.js";
import { nativeImages } from "./native-images.js";
import { CodexSession } from "./engines/codex.js";
import { KimiSession } from "./engines/kimi.js";
it("reads only scoped explicit image references and sends native image blocks to both engines", async () => {
  const root = mkdtempSync(join(tmpdir(), "wa-image-"));
  const store = new WorkspaceStore(join(root, "work"), join(root, "home"));
  try {
    const project = store.create("images");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO3sAAAAASUVORK5CYII=",
      "base64",
    );
    store.write(project.id, "图片.png", png);
    const images = await nativeImages(
      store,
      project.id,
      '项目文件："图片.png"\n请看这张图片',
    );
    expect(images).toEqual([
      { mimeType: "image/png", data: png.toString("base64") },
    ]);
    await expect(
      nativeImages(store, project.id, '项目文件："../图片.png"'),
    ).rejects.toThrow("invalid_relative_path");
    store.write(project.id, "fake.png", Buffer.from("not an image"));
    await expect(
      nativeImages(store, project.id, '项目文件："fake.png"'),
    ).rejects.toThrow("invalid_image_content");
    const request = vi.fn(async (_method: string, _input: unknown) => ({ turn: { id: "t" } }));
    const codex = new CodexSession(
      { request } as never,
      "s",
      () => {},
      () => {},
    );
    await codex.send("describe", images);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      input: [
        { type: "text", text: "describe" },
        { type: "image", url: `data:image/png;base64,${images[0]!.data}` },
      ],
    });
    const prompt = vi.fn(async (_input: unknown) => ({ stopReason: "end_turn" }));
    const kimi = new KimiSession(
      { prompt } as never,
      "s",
      () => {},
      () => {},
    );
    await kimi.send("describe", images);
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({
      prompt: [
        { type: "text", text: "describe" },
        { type: "image", mimeType: "image/png", data: images[0]!.data },
      ],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
