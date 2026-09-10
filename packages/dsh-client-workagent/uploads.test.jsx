// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createUploads } from "./src/uploads.js";
afterEach(() => vi.unstubAllGlobals());
it("resumes from the server offset after a lost chunk response and finalizes once", async () => {
  let row;
  let attempts = 0;
  let finalized = 0;
  const offsets = [];
  const request = vi.fn(async (_url, init = {}) => {
    if (init.method === "POST" && init.body) {
      row = { ...JSON.parse(init.body), id: "pending", offset: 0 };
      return { ...row };
    }
    if (init.method === "POST") {
      finalized++;
      return {};
    }
    return row ? [{ ...row }] : [];
  });
  class XHR {
    upload = {};
    headers = {};
    open() {}
    setRequestHeader(key, value) {
      this.headers[key] = value;
    }
    send(blob) {
      offsets.push(Number(this.headers["Upload-Offset"]));
      row.offset += blob.size;
      this.upload.onprogress?.({ loaded: blob.size });
      queueMicrotask(() => {
        if (++attempts === 1) this.onerror();
        else {
          this.status = 200;
          this.responseText = JSON.stringify(row);
          this.onload();
        }
      });
    }
    abort() {
      this.onabort();
    }
  }
  vi.stubGlobal("XMLHttpRequest", XHR);
  const { uploadFile } = createUploads({
    React,
    request,
    apiRoot: "/api/runtime/v1",
    friendlyError: (value) => value,
  });
  const file = new File([new Uint8Array(8 * 1024 * 1024 + 2)], "large.bin", {
    lastModified: 1,
  });
  const progress = vi.fn();
  await expect(
    uploadFile("project", "large.bin", file, { onProgress: progress }),
  ).rejects.toThrow("网络中断");
  expect(finalized).toBe(0);
  await expect(
    uploadFile("project", "large.bin", file, { onProgress: progress }),
  ).resolves.toBe("large.bin");
  expect(offsets).toEqual([0, 8 * 1024 * 1024]);
  expect(finalized).toBe(1);
  expect(progress).toHaveBeenLastCalledWith(file.size);
  expect(request.mock.calls.filter(([, init]) => init?.body)).toHaveLength(1);
});
it("leaves a paused upload resumable without publishing or deleting it", async () => {
  const controller = new AbortController();
  let row;
  const request = vi.fn(async (_url, init = {}) => {
    if (init.method === "POST") {
      row = { ...JSON.parse(init.body), id: "pending", offset: 0 };
      return row;
    }
    return [];
  });
  class XHR {
    upload = {};
    open() {}
    setRequestHeader() {}
    send() {
      queueMicrotask(() => controller.abort());
    }
    abort() {
      this.onabort();
    }
  }
  vi.stubGlobal("XMLHttpRequest", XHR);
  const { uploadFile } = createUploads({
    React,
    request,
    apiRoot: "/api/runtime/v1",
    friendlyError: (value) => value,
  });
  await expect(
    uploadFile("project", "file.txt", new File(["data"], "file.txt"), {
      signal: controller.signal,
    }),
  ).rejects.toThrow("暂停");
  expect(
    request.mock.calls.some(
      ([url, init]) =>
        String(url).endsWith("/complete") || init?.method === "DELETE",
    ),
  ).toBe(false);
});
import { render, screen, waitFor, cleanup } from "@testing-library/react";
it("keeps the upload recovery panel absent when there are no pending files", async () => {
  const request = vi.fn(async () => []);
  const { Panel } = createUploads({
    React,
    request,
    apiRoot: "/api",
    friendlyError: (x) => x,
  });
  const view = render(React.createElement(Panel, { workspaceId: "project" }));
  await waitFor(() => expect(request).toHaveBeenCalled());
  expect(view.container.querySelector("details")).toBeNull();
  cleanup();
});
it("shows recoverable files with a compact disclosure and accessible file chooser", async () => {
  const request = vi.fn(async () => [
    { id: "pending", name: "draft.txt", size: 10, offset: 4 },
  ]);
  const { Panel } = createUploads({
    React,
    request,
    apiRoot: "/api",
    friendlyError: (x) => x,
  });
  render(React.createElement(Panel, { workspaceId: "project" }));
  await screen.findByText("待继续上传");
  expect(screen.getByLabelText("继续上传 draft.txt").type).toBe("file");
  expect(screen.getByLabelText("draft.txt 上传进度").value).toBe(4);
  cleanup();
});
