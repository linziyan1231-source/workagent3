import { expect, it, vi } from "vitest";
import { CodexSession } from "./codex.js";
import { KimiSession } from "./kimi.js";

it("preserves native plan updates and public reasoning summaries separately from assistant answers", () => {
  const emit = vi.fn();
  const session = new CodexSession({} as never, "s", emit, () => {});
  session.notification("turn/plan/updated", {
    turnId: "t",
    explanation: "检查后验证",
    plan: [{ step: "检查", status: "in_progress" }],
  });
  session.notification("item/reasoning/summaryTextDelta", {
    turnId: "t",
    itemId: "r",
    summaryIndex: 0,
    delta: "正在核对接口",
  });
  expect(emit.mock.calls.map(([event]) => event)).toEqual([
    {
      type: "process.updated",
      turnId: "t",
      processId: "t-plan",
      kind: "plan",
      text: "检查后验证",
      data: [{ step: "检查", status: "in_progress" }],
    },
    {
      type: "process.updated",
      turnId: "t",
      processId: "r-summary-0",
      kind: "reasoning",
      delta: "正在核对接口",
    },
  ]);
});

it("preserves command, file changes and assistant identity", () => {
  const emit = vi.fn();
  const session = new CodexSession({} as never, "s", emit, () => {});
  session.notification("item/completed", {
    turnId: "t",
    item: {
      id: "c",
      type: "commandExecution",
      command: "dir",
      cwd: "C:/work",
      aggregatedOutput: "files",
      exitCode: 0,
      status: "completed",
    },
  });
  expect(emit).toHaveBeenLastCalledWith(
    expect.objectContaining({
      tool: "dir",
      output: "files",
      raw: expect.objectContaining({ exitCode: 0 }),
    }),
  );
  session.notification("item/completed", {
    turnId: "t",
    item: {
      id: "f",
      type: "fileChange",
      changes: [{ path: "a", diff: "+hello" }],
      status: "completed",
    },
  });
  expect(emit).toHaveBeenLastCalledWith(
    expect.objectContaining({
      toolCallId: "f",
      input: [{ path: "a", diff: "+hello" }],
    }),
  );
  session.notification("item/agentMessage/delta", {
    turnId: "t",
    itemId: "m",
    delta: "hi",
  });
  expect(emit).toHaveBeenLastCalledWith({
    type: "assistant.delta",
    turnId: "t",
    messageId: "m",
    delta: "hi",
  });
});

it("preserves incremental ACP tool detail through terminal updates", async () => {
  const emit = vi.fn();
  const s = new KimiSession(
    { prompt: () => new Promise(() => {}) } as never,
    "s",
    emit,
    () => {},
  );
  await s.send("hi");
  s.update({
    sessionId: "s",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "c",
      title: "Read",
      rawInput: { path: "a" },
      locations: [{ path: "a" }],
    },
  });
  s.update({
    sessionId: "s",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "c",
      rawOutput: { text: "hello" },
    },
  });
  expect(emit).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "tool.updated",
      input: { path: "a" },
      output: { text: "hello" },
    }),
  );
  s.update({
    sessionId: "s",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "c",
      status: "completed",
    },
  });
  expect(emit).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "tool.completed",
      tool: "Read",
      input: { path: "a" },
      output: { text: "hello" },
      locations: [{ path: "a" }],
    }),
  );
});

it.each(["allow", "reject", "cancel"] as const)(
  "maps Codex %s to the native decision",
  async (decision) => {
    const requestApproval = vi.fn(async () => decision);
    const s = new CodexSession(
      {} as never,
      "s",
      () => {},
      () => {},
      undefined,
      undefined,
      { requestApproval },
    );
    s.notification("turn/started", { turn: { id: "t" } });
    expect(
      await s.requestApproval("item/commandExecution/requestApproval", {
        threadId: "s",
        turnId: "t",
        command: "dir",
        availableDecisions: ["accept", "decline", "cancel"],
      }),
    ).toEqual({
      decision: { allow: "accept", reject: "decline", cancel: "cancel" }[
        decision
      ],
    });
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: "t",
        tool: "dir",
        signal: expect.any(AbortSignal),
      }),
    );
  },
);

it.each(["allow", "reject"] as const)(
  "selects only an offered ACP %s option",
  async (decision) => {
    const s = new KimiSession(
      { prompt: () => new Promise(() => {}) } as never,
      "s",
      () => {},
      () => {},
      { requestApproval: async () => decision },
    );
    await s.send("hi");
    expect(
      await s.requestPermission({
        sessionId: "s",
        toolCall: { toolCallId: "c", title: "Write" },
        options: [
          { optionId: "yes42", name: "Allow", kind: "allow_once" },
          { optionId: "no42", name: "Deny", kind: "reject_once" },
        ],
      }),
    ).toEqual({
      outcome: {
        outcome: "selected",
        optionId: decision === "allow" ? "yes42" : "no42",
      },
    });
    expect(
      await s.requestPermission({
        sessionId: "s",
        toolCall: { toolCallId: "c" },
        options: [],
      }),
    ).toEqual({ outcome: { outcome: "cancelled" } });
  },
);

it.each(["cancel", "close", "disconnected", "terminal"] as const)(
  "aborts pending Codex approval on %s",
  async (action) => {
    let signal!: AbortSignal;
    const s = new CodexSession(
      { request: async () => ({}) } as never,
      "s",
      () => {},
      () => {},
      undefined,
      undefined,
      {
        requestApproval: async (r) => {
          signal = r.signal;
          return new Promise(() => {});
        },
      },
    );
    s.notification("turn/started", { turn: { id: "t" } });
    const pending = s.requestApproval("item/fileChange/requestApproval", {
      threadId: "s",
      turnId: "t",
    });
    await Promise.resolve();
    if (action === "terminal")
      s.notification("turn/completed", {
        turn: { id: "t", status: "completed" },
      });
    else await s[action]();
    expect(signal.aborted).toBe(true);
    expect(await pending).toEqual({ decision: "cancel" });
  },
);

it("fails closed on approval callback rejection", async () => {
  const s = new KimiSession(
    { prompt: () => new Promise(() => {}) } as never,
    "s",
    () => {},
    () => {},
    {
      requestApproval: async () => {
        throw new Error("gone");
      },
    },
  );
  await s.send("hi");
  expect(
    await s.requestPermission({
      sessionId: "s",
      toolCall: { toolCallId: "c" },
      options: [],
    }),
  ).toEqual({ outcome: { outcome: "cancelled" } });
});

it.each(["cancel", "close", "disconnected", "terminal"] as const)(
  "aborts pending ACP approval on %s",
  async (action) => {
    let signal!: AbortSignal;
    let finish!: (value: { stopReason: string }) => void;
    const s = new KimiSession(
      {
        prompt: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        cancel: async () => {},
      } as never,
      "s",
      () => {},
      () => {},
      {
        requestApproval: async (r) => {
          signal = r.signal;
          return new Promise(() => {});
        },
      },
    );
    await s.send("hi");
    const pending = s.requestPermission({
      sessionId: "s",
      toolCall: { toolCallId: "c" },
      options: [],
    });
    await Promise.resolve();
    if (action === "terminal") {
      finish({ stopReason: "end_turn" });
      await Promise.resolve();
    } else await s[action]();
    expect(signal.aborted).toBe(true);
    expect(await pending).toEqual({ outcome: { outcome: "cancelled" } });
  },
);

it.each(["codex", "kimi"] as const)(
  "rejects late approval requests after %s cancellation",
  async (engine) => {
    const requestApproval = vi.fn(async () => "allow" as const);
    if (engine === "codex") {
      const s = new CodexSession(
        { request: async () => ({}) } as never,
        "s",
        () => {},
        () => {},
        undefined,
        undefined,
        { requestApproval },
      );
      s.notification("turn/started", { turn: { id: "t" } });
      await s.cancel();
      expect(
        await s.requestApproval("item/fileChange/requestApproval", {
          threadId: "s",
          turnId: "t",
        }),
      ).toEqual({ decision: "cancel" });
    } else {
      const s = new KimiSession(
        {
          prompt: () => new Promise(() => {}),
          cancel: async () => {},
        } as never,
        "s",
        () => {},
        () => {},
        { requestApproval },
      );
      await s.send("hi");
      await s.cancel();
      expect(
        await s.requestPermission({
          sessionId: "s",
          toolCall: { toolCallId: "c" },
          options: [{ kind: "allow_once", name: "yes", optionId: "yes" }],
        }),
      ).toEqual({ outcome: { outcome: "cancelled" } });
    }
    expect(requestApproval).not.toHaveBeenCalled();
  },
);

it("preserves Codex streaming tool output before completion", () => {
  const emit = vi.fn();
  const s = new CodexSession({} as never, "s", emit, () => {});
  s.notification("item/commandExecution/outputDelta", {
    turnId: "t",
    itemId: "c",
    delta: "progress\n",
  });
  expect(emit).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "tool.updated",
      toolCallId: "c",
      output: "progress\n",
      raw: { turnId: "t", itemId: "c", delta: "progress\n" },
    }),
  );
});

it.each(["allow", "reject"] as const)(
  "honors the real Codex offered decision set without decline for %s",
  async (decision) => {
    const options = [
      "accept",
      {
        acceptWithExecpolicyAmendment: {
          execpolicyAmendment: ["Get-ChildItem"],
        },
      },
      "cancel",
    ];
    const requestApproval = vi.fn(async () => decision);
    const session = new CodexSession(
      {} as never,
      "native-thread",
      () => {},
      () => {},
      undefined,
      undefined,
      { requestApproval },
    );
    session.notification("turn/started", { turn: { id: "native-turn" } });
    expect(
      await session.requestApproval("item/commandExecution/requestApproval", {
        threadId: "native-thread",
        turnId: "native-turn",
        itemId: "native-command",
        kind: "command",
        command: "Get-ChildItem -LiteralPath . -File -Name",
        cwd: "C:/project",
        availableDecisions: options,
      }),
    ).toEqual({ decision: decision === "allow" ? "accept" : "cancel" });
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        options,
        input: expect.objectContaining({
          kind: "command",
          availableDecisions: options,
        }),
      }),
    );
  },
);
