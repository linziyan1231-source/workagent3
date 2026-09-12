import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { CollaborationChannels } from "./collaboration-channels.js";
import { CompletionNotifications } from "./completion-notifications.js";
import { WorkspaceStore } from "./workspace-store.js";

afterEach(() => vi.unstubAllGlobals());
it("pushes only agent completions with shared files, persists cursors and rechecks membership on retry", async () => {
  const home = mkdtempSync(join(tmpdir(), "collab-im-"));
  const project = "shared_project_0001",
    conversation = "discussion_00000001",
    owner = "S-1-5-21-owner";
  const root = join(home, "shared", owner, project);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "report.txt"), "artifact");
  const config = {
    baseURL: new URL("http://127.0.0.1:8080/"),
    sid: "S-1-5-21-member",
    token: "private-fixture-credential",
  };
  let cursor = 0,
    denied = false;
  const requests: any[] = [];
  const create = () =>
    new CollaborationChannels(home, join(home, "shared", config.sid), config);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const input = JSON.parse(init.body);
      requests.push(input);
      if (input.action === "feed")
        return Response.json({
          cursor: cursor++,
          messages:
            input.after === undefined
              ? []
              : [
                  {
                    kind: "user",
                    id: "human",
                    conversation_id: conversation,
                    body: "Do not push human speech",
                  },
                  {
                    kind: "assistant",
                    seq: 1,
                    id: "done",
                    conversation_id: conversation,
                    author_name: "Codex",
                    body: `Done [report](${join(root, "report.txt")})`,
                    created_at: new Date().toISOString(),
                  },
                ],
        });
      if (denied)
        return Response.json(
          { error: "shared_project_forbidden" },
          { status: 403 },
        );
      return Response.json({
        conversation: {
          id: conversation,
          name: "Discussion",
          project_id: project,
        },
        project: { id: project, name: "Shared", ownerSid: owner },
      });
    }),
  );
  const notifications = new CompletionNotifications(
    home,
    new WorkspaceStore(join(home, "personal"), home),
    "https://example.test",
  );
  const target = {
    id: "im",
    label: "IM",
    channelId: "test",
    chatId: "user",
    kind: "dm" as const,
    connected: true,
    supportsFiles: true,
  };
  const send = vi.fn().mockResolvedValue(undefined),
    sendFile = vi.fn(async (_target, path) => {
      expect(readFileSync(path, "utf8")).toBe("artifact");
      throw new Error("offline");
    });
  notifications.attach({ targets: () => [target], send, sendFile });
  notifications.configure({ enabled: true, targetId: "im", attachFiles: true });
  let client = create();
  notifications.attachCollaboration(client);
  await client.poll(notifications);
  expect(send).not.toHaveBeenCalled();
  await client.poll(notifications);
  expect(send.mock.calls.flat().join(" ")).toContain("协作 Agent 已完成");
  expect(send.mock.calls.flat().join(" ")).not.toContain(
    "Do not push human speech",
  );
  expect(send.mock.calls.flat().join(" ")).toContain(
    `/api/portal/shared-workspaces/${project}/content`,
  );
  expect(send.mock.calls.flat().join(" ")).toContain(
    `discussion=${conversation}`,
  );
  expect(send.mock.calls[0]![2]).toBe(`collaboration:${conversation}`);
  expect(sendFile).toHaveBeenCalledTimes(1);
  expect(notifications.snapshot().deliveries[0]?.status).toBe("failed");
  client = create();
  notifications.attachCollaboration(client);
  await client.poll(notifications);
  expect(requests.filter((r) => r.action === "feed").at(-1).after).toBe(1);
  expect(sendFile).toHaveBeenCalledTimes(1);
  denied = true;
  await notifications.retry(`collaboration:${conversation}:done`);
  expect(sendFile).toHaveBeenCalledTimes(1);
  expect(notifications.snapshot().deliveries[0]?.status).toBe("failed");
});
