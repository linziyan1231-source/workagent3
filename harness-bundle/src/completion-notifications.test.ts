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
  const service = new CompletionNotifications(
    home,
    workspaces,
    "https://workagent.example.com",
  );
  service.attach(transport);
  const settings = {
    enabled: true,
    targetId: target.id,
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
  it("uses the deployment origin despite legacy preferences and client-supplied addresses", async () => {
    const a = fixture();
    a.service.configure(a.settings);
    const path = join(a.home, "workagent", "completion-notifications.json");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    saved.settings.baseURL = "https://old.example.com";
    writeFileSync(path, JSON.stringify(saved));
    const restarted = new CompletionNotifications(
      a.home,
      a.workspaces,
      "https://deployment.example.com/",
    );
    restarted.attach(a.transport);
    restarted.configure({
      ...a.settings,
      ...{ baseURL: "https://client.example.com" },
    });
    a.workspaces.write("default", "report.txt", Buffer.from("report"));
    a.workspaces.registerArtifact(
      "default",
      a.completion.sessionId,
      "report.txt",
    );
    await restarted.complete(a.completion);
    const text = a.transport.send.mock.calls.map(([, text]) => text).join("\n");
    expect(text).toContain("https://deployment.example.com/?frontend=dsh");
    expect(text).toContain(
      "https://deployment.example.com/api/runtime/v1/workspaces/",
    );
    expect(text).not.toContain("old.example.com");
    expect(text).not.toContain("client.example.com");
    expect(restarted.snapshot()).not.toHaveProperty("baseURL");
    expect(JSON.parse(readFileSync(path, "utf8")).settings).not.toHaveProperty(
      "baseURL",
    );
  });

  it("requires an administrator-configured HTTP origin before enabling reminders", () => {
    const a = fixture();
    const missing = new CompletionNotifications(a.home, a.workspaces);
    missing.attach(a.transport);
    expect(() => missing.configure(a.settings)).toThrow("管理员");
    expect(() =>
      missing.configure({ ...a.settings, enabled: false }),
    ).not.toThrow();
    for (const address of [
      "file:///tmp",
      "https://user:secret@example.com",
      "https://example.com/path",
      "https://example.com/?q=1",
    ]) {
      expect(
        () => new CompletionNotifications(a.home, a.workspaces, address),
      ).toThrow();
    }
  });

  it("sends validated artifact bytes through native file transport and retries files without replaying text", async () => {
    const a = fixture();
    a.workspaces.write("default", "report.bin", Buffer.from([0, 255, 128]));
    a.workspaces.registerArtifact(
      "default",
      a.completion.sessionId,
      "report.bin",
    );
    const sendFile = vi.fn(async (_target: string, path: string) => {
      expect(readFileSync(path)).toEqual(Buffer.from([0, 255, 128]));
      if (sendFile.mock.calls.length === 1)
        throw new Error("delivery uncertain");
    });
    a.service.attach({
      ...a.transport,
      targets: () => [{ ...a.target, supportsFiles: true }],
      sendFile,
    });
    a.service.configure({ ...a.settings, attachFiles: true });
    await a.service.complete(a.completion);
    const failed = a.service.snapshot().deliveries[0]!;
    expect(failed.status).toBe("failed");
    const textCalls = a.transport.send.mock.calls.length;
    await a.service.retry(failed.id);
    expect(sendFile).toHaveBeenCalledTimes(2);
    expect(a.transport.send).toHaveBeenCalledTimes(textCalls);
    expect(a.service.snapshot().deliveries[0]).toMatchObject({
      status: "sent",
      sentFiles: 1,
    });
  });
  it("persists per-session muting and resumes only after it is explicitly enabled", async () => {
    const a = fixture();
    a.service.configure(a.settings);
    a.service.configureSession(a.completion.sessionId, false);
    const restarted = new CompletionNotifications(
      a.home,
      a.workspaces,
      "https://workagent.example.com",
    );
    restarted.attach(a.transport);
    await restarted.complete(a.completion);
    expect(a.transport.send).not.toHaveBeenCalled();
    restarted.configureSession(a.completion.sessionId, true);
    await restarted.complete(a.completion);
    expect(a.transport.send).toHaveBeenCalled();
  });
  it("allows one conversation or automation to choose a target while the global reminder is off", async () => {
    const a = fixture();
    a.service.configureSession(a.completion.sessionId, true, a.target.id);
    await a.service.complete(a.completion);
    expect(a.transport.send).toHaveBeenCalled();
    expect(a.service.snapshot().sessionSettings).toMatchObject({
      [a.completion.sessionId]: {
        enabled: true,
        targetId: a.target.id,
      },
    });

    a.transport.send.mockClear();
    await a.service.complete({
      ...a.completion,
      sessionId: "automation-session",
      turnId: "automation-turn",
      notification: { enabled: true, targetId: a.target.id },
    });
    expect(a.transport.send).toHaveBeenCalled();
  });
  it("remembers the most recently selected chat and sends requested workspace files", async () => {
    const a = fixture();
    const sendFile = vi.fn(async (_target: string, path: string) => {
      expect(readFileSync(path)).toEqual(Buffer.from("manual file"));
    });
    a.service.attach({
      ...a.transport,
      targets: () => [{ ...a.target, supportsFiles: true }],
      sendFile,
    });
    a.service.configureSession(a.completion.sessionId, true, a.target.id);
    expect(a.service.snapshot().lastTargetId).toBe(a.target.id);
    a.workspaces.write(
      "default",
      "reports/weekly.txt",
      Buffer.from("manual file"),
    );
    await a.service.sendMessage({
      targetId: a.target.id,
      text: "周报文件",
      workspaceId: "default",
      filePath: "reports/weekly.txt",
    });
    expect(a.transport.send).toHaveBeenCalledWith(a.target.id, "周报文件");
    expect(sendFile).toHaveBeenCalledOnce();
    expect(
      new CompletionNotifications(
        a.home,
        a.workspaces,
        "https://workagent.example.com",
      ).snapshot().lastTargetId,
    ).toBe(a.target.id);
  });
  it("is off by default, persists preferences privately, and requires a connected target", async () => {
    const a = fixture();
    const b = fixture();
    await a.service.complete(a.completion);
    expect(a.transport.send).not.toHaveBeenCalled();
    expect(() =>
      a.service.configure({ ...a.settings, targetId: "unknown" }),
    ).toThrow("请选择");
    a.service.configure(a.settings);
    expect(
      new CompletionNotifications(
        a.home,
        a.workspaces,
        "https://workagent.example.com",
      ).snapshot(),
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
    const restarted = new CompletionNotifications(
      a.home,
      a.workspaces,
      "https://workagent.example.com",
    );
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
      source: "im",
    });
    await a.service.complete({
      ...a.completion,
      sessionId: "im:feishu:dm:123",
      source: "im",
    });
    expect(a.transport.send).not.toHaveBeenCalled();
  });

  it("notifies webpage turns in IM-created tasks and rebinds the chat to the notified session", async () => {
    const a = fixture();
    a.service.configure(a.settings);
    await a.service.complete({
      ...a.completion,
      sessionId: "session-channel-test",
      source: "web",
    });
    const text = a.transport.send.mock.calls.map(([, text]) => text).join("\n");
    expect(text).toContain("当前聊天已关联到该任务，直接回复即可继续。");
    expect(text).toContain("项目：");
    for (const call of a.transport.send.mock.calls)
      expect(call[2]).toBe("session-channel-test");
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
    const restarted = new CompletionNotifications(
      a.home,
      a.workspaces,
      "https://workagent.example.com",
    );
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
      new CompletionNotifications(
        a.home,
        a.workspaces,
        "https://workagent.example.com",
      ).snapshot().deliveries[0],
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
      "https://workagent.example.com",
      a.workspaces,
    );
    expect(text).toContain("?frontend=dsh&session=session-task");
  });
});
