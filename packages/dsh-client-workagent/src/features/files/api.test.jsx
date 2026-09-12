// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { fileURL, uploads } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

it.each([
  ["shared:project/one", "/api/portal/shared-workspaces/project%2Fone"],
  ["personal/one", "/api/runtime/v1/workspaces/personal%2Fone"],
])(
  "routes %s previews and uploads to its owning workspace",
  async (id, root) => {
    expect(fileURL(id, "资料/image.png", true, "file/one", true)).toBe(
      `${root}/content?path=${encodeURIComponent("资料/image.png")}&preview=1&fileId=file%2Fone&reference=1`,
    );
    const fetch = vi.fn(async (url, init) => {
      const result =
        init?.method === "POST"
          ? String(url).endsWith("/complete")
            ? { path: "new.txt", fileId: "created-file" }
            : { id: "pending", path: "new.txt", offset: 0, size: 0 }
          : [];
      return new Response(JSON.stringify(result), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const onEntry = vi.fn();
    await expect(
      uploads.uploadFile(id, "new.txt", new File([], "new.txt"), { onEntry }),
    ).resolves.toBe("new.txt");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${root}/uploads`,
      `${root}/uploads`,
      `${root}/uploads/pending/complete`,
    ]);
    expect(onEntry).toHaveBeenCalledWith({
      path: "new.txt",
      fileId: "created-file",
    });
  },
);
