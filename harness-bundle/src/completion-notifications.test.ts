import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  CompletionNotifications,
  completionMessage,
  splitNotification,
  type Completion,
} from "./completion-notifications.js";
import { WorkspaceStore } from "./workspace-store.js";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "completion-notifications-"));
  const workspaces = new WorkspaceStore(join(home, "workspaces"), home);
  const target = {
    id: "test-target",
    label: "飞书 · 私聊",
    connected: true,
    channelId: "feishu",
    chatId: "test",
    kind: "dm" as const,
  };
  const transport = {
    targets: () => [target],
    send: vi.fn().mockResolvedValue(undefined),
  };
  const service = new CompletionNotifications(home, workspaces);
  service.attach(transport);
  const settings = {
    enabled: true,
    targetId: target.id,
    baseURL: "https://workagent.example.com",
  };
  const completion: Completion = {
    sessionId: "session-task",
    turnId: "turn-1",
    title: "生成报告",
    reply: "报告已完成",
    workspaceId: "default",
    startedAt: new Date(0).toISOString(),
  };
  return { home, workspaces, target, transport, service, settings, completion };
}

describe("completion notification delivery", () => {
  it("is off by default, persists preferences privately, and requires a connected target", async () => {
    const a = fixture();
    const b = fixture();
    await a.service.complete(a.completion);
    expect(a.transport.send).not.toHaveBeenCalled();
    expect(() =>
      a.service.configure({ ...a.settings, targetId: "unknown" }),
    ).toThrow("请选择");
    expect(() =>
      a.service.configure({
        ...a.settings,
        baseURL: "https://user:secret@example.com",
      }),
    ).toThrow("网址");
    a.service.configure(a.settings);
    expect(
      new CompletionNotifications(a.home, a.workspaces).snapshot(),
    ).toMatchObject(a.settings);
    expect(b.service.snapshot().enabled).toBe(false);
  });

  it("sends reply and real artifacts, excludes uploads/missing/outside files, and deduplicates turns across restart", async () => {
    const a = fixture();
    a.service.configure(a.settings);
    a.workspaces.write("default", "报告.txt", Buffer.from("report"));
    a.workspaces.registerArtifact(
      "default",
      a.completion.sessionId,
      "报告.txt",
    );
    a.workspaces.addAttachment(
      "default",
      a.completion.sessionId,
      "输入.txt",
      "text/plain",
      Buffer.from("private input"),
    );
    const completed = {
      ...a.completion,
      reply: `[报告](${join(a.workspaces.engineRoot("default"), "报告.txt")})\n[缺失](missing.txt)\n[外部](../secret.txt)`,
    };
    await Promise.all([
      a.service.complete(completed),
      a.service.complete(completed),
    ]);
    const text = a.transport.send.mock.calls.map(([, text]) => text).join("\n");
    expect(text).toContain("任务已完成：生成报告");
    expect(text).toContain("/content?path=%E6%8A%A5%E5%91%8A.txt");
    expect(text).not.toContain("/content?path=missing");
    expect(text).not.toContain("/content?path=..%2Fsecret");
    expect(text).not.toContain("输入.txt");
    expect(a.service.snapshot().deliveries).toHaveLength(1);
    expect(a.service.snapshot().deliveries[0]?.status).toBe("sent");
    const restarted = new CompletionNotifications(a.home, a.workspaces);
    restarted.attach(a.transport);
    const count = a.transport.send.mock.calls.length;
    await restarted.complete(completed);
    expect(a.transport.send).toHaveBeenCalledTimes(count);
  });

  it("never duplicates a channel conversation's own reply", async () => {
    const a = fixture();
    a.service.configure(a.settings);
    await a.service.complete({
      ...a.completion,
      sessionId: "session-channel-test",
    });
    await a.service.complete({
      ...a.completion,
      sessionId: "im:feishu:dm:123",
    });
    expect(a.transport.send).not.toHaveBeenCalled();
  });

  it("checkpoints sent parts and resumes only the remaining parts on manual retry", async () => {
    const a = fixture();
    a.service.configure(a.settings);
    a.transport.send
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("network"));
    await a.service.complete({ ...a.completion, reply: "文".repeat(5000) });
    expect(a.service.snapshot().deliveries[0]).toMatchObject({
      status: "failed",
      sentParts: 1,
    });
    const first = a.transport.send.mock.calls[0]![1];
    const restarted = new CompletionNotifications(a.home, a.workspaces);
    restarted.attach(a.transport);
    a.transport.send.mockClear();
    await restarted.retry(restarted.snapshot().deliveries[0]!.id);
    expect(restarted.snapshot().deliveries[0]?.status).toBe("sent");
    expect(a.transport.send.mock.calls.map(([, text]) => text)).not.toContain(
      first,
    );
  });

  it("stops subsequent parts when disabled while sending and does not report an interrupted send as delivered", async () => {
    const a = fixture();
    a.service.configure(a.settings);
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    a.transport.send.mockImplementationOnce(async () => {
      a.service.configure({ ...a.settings, enabled: false });
      await wait;
    });
    const sending = a.service.complete({
      ...a.completion,
      reply: "x".repeat(6000),
    });
    await vi.waitFor(() => expect(a.transport.send).toHaveBeenCalledOnce());
    finish();
    await sending;
    expect(a.service.snapshot().deliveries[0]?.status).toBe("cancelled");
    expect(a.transport.send).toHaveBeenCalledOnce();
    const path = join(a.home, "workagent", "completion-notifications.json");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    saved.deliveries[0].status = "sending";
    writeFileSync(path, JSON.stringify(saved));
    expect(
      new CompletionNotifications(a.home, a.workspaces).snapshot()
        .deliveries[0],
    ).toMatchObject({
      status: "failed",
      error: expect.stringContaining("重启"),
    });
  });

  it("keeps normal artifact URLs intact when splitting long Unicode replies", async () => {
    const a = fixture();
    const link = "https://example.com/" + "a".repeat(150);
    const parts = splitNotification("😀".repeat(440) + "\n" + link);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toBe(link);
    expect(parts.every((part) => Buffer.byteLength(part) <= 1800)).toBe(true);
    expect(
      splitNotification("中文😀".repeat(1000)).every(
        (part) => Buffer.byteLength(part) <= 1800,
      ),
    ).toBe(true);
    const text = await completionMessage(
      a.completion,
      a.settings.baseURL,
      a.workspaces,
    );
    expect(text).toContain("?frontend=dsh&session=session-task");
  });
});
