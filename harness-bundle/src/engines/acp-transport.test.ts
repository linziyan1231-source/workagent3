import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { AcpBridge, AcpSession } from "./acp-transport.js";
import { CodexSession } from "./codex.js";
import { withSkillCatalog } from "./skills.js";

it("negotiates a stdio agent, buffers early commands and returns the exact offered approval scope", async () => {
  const bridge = new AcpBridge({
    id: "acp",
    command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/acp-agent.mjs", import.meta.url))],
    environment: () => process.env,
    applyOptions: async () => {},
    permission: () => "manual_approval",
    models: async () => [],
  });
  const emit = vi.fn();
  const approval = vi.fn(async () => ({ optionId: "session" }));
  try {
    const session = await bridge.create(process.cwd(), emit, {
      mcpServers: [],
      requestApproval: approval,
    });
    expect(session.commands?.()).toMatchObject({
      supported: true,
      revision: 1,
      items: [{ id: "review", inputHint: "path" }],
    });
    await session.send("hello");
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "turn.completed" }),
      ),
    );
    expect(approval).toHaveBeenCalledWith(
      expect.objectContaining({
        choices: expect.arrayContaining([
          {
            id: "session",
            label: "Allow for session",
            outcome: "allow",
            scope: "remember",
          },
        ]),
      }),
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "assistant.completed",
        content: "session",
      }),
    );
  } finally {
    await bridge.close();
  }
});

it("replaces command catalogs while idle, ignores foreign sessions, and preserves native slash input", async () => {
  const prompt = vi.fn(async () => ({ stopReason: "end_turn" }));
  const raw = new AcpSession(
    { prompt } as never,
    "s",
    () => {},
    () => {},
  );
  const update = {
    sessionId: "s",
    update: {
      sessionUpdate: "available_commands_update" as const,
      availableCommands: [{ name: "review", description: "Review" }],
    },
  };
  raw.update({ ...update, sessionId: "other" });
  expect(raw.commands().items).toEqual([]);
  raw.update(update);
  const session = withSkillCatalog(raw, {
    mcpServers: [],
    systemPrompt: "context",
  });
  await session.send("/review path");
  expect(prompt).toHaveBeenLastCalledWith({
    sessionId: "s",
    prompt: [{ type: "text", text: "/review path" }],
  });
  await vi.waitFor(() => expect(raw.connected).toBe(true));
  raw.update({
    ...update,
    update: { ...update.update, availableCommands: [] },
  });
  expect(raw.commands()).toEqual({ supported: true, revision: 2, items: [] });
  await expect(raw.compact()).rejects.toThrow("engine_compact_unavailable");
});

it.each([
  "acceptForSession",
  { acceptWithExecpolicyAmendment: { execpolicyAmendment: ["git", "status"] } },
  {
    applyNetworkPolicyAmendment: {
      networkPolicyAmendment: { host: "example.com", action: "allow" },
    },
  },
])(
  "returns offered Codex policy %j without accepting arbitrary client policy",
  async (policy) => {
    const requestApproval = vi.fn(async () => ({ optionId: "native-1" }));
    const session = new CodexSession(
      {} as never,
      "s",
      () => {},
      () => {},
      undefined,
      undefined,
      { requestApproval },
    );
    session.notification("turn/started", { turn: { id: "t" } });
    const input = {
      threadId: "s",
      turnId: "t",
      command: "git status",
      availableDecisions: ["accept", policy, "cancel"],
    };
    expect(
      await session.requestApproval(
        "item/commandExecution/requestApproval",
        input,
      ),
    ).toEqual({ decision: policy });
    requestApproval.mockResolvedValue({ optionId: "injected" });
    expect(
      await session.requestApproval(
        "item/commandExecution/requestApproval",
        input,
      ),
    ).toEqual({ decision: "cancel" });
  },
);
