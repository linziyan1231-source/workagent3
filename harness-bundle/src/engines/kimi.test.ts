import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KimiBridge,
  KimiSession,
  kimiSessionFailure,
  applyKimiOptions,
  kimiPermission,
} from "./kimi.js";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";

const roots: string[] = [];
it("rejects a requested sandbox when legacy ACP only offers unrestricted execution", async () => {
  const connection = { setSessionMode: vi.fn() };
  await expect(
    applyKimiOptions(
      connection as never,
      "session-1",
      {
        mcpServers: [],
        permissionMode: "workspace_write",
        requirePermission: true,
      },
      { currentModeId: "yolo", availableModes: [{ id: "yolo", name: "YOLO" }] },
    ),
  ).rejects.toThrow("engine_permission_unavailable");
  expect(connection.setSessionMode).not.toHaveBeenCalled();
});
it("reports the native permission and does not guess for an unrecognised restored mode", () => {
  expect(kimiPermission({ modes: { currentModeId: "plan" } })).toBe(
    "read_only",
  );
  expect(kimiPermission({ modes: { currentModeId: "auto" } })).toBe(
    "workspace_write",
  );
  expect(kimiPermission({ modes: { currentModeId: "yolo" } })).toBe(
    "full_access",
  );
  expect(kimiPermission({ modes: { currentModeId: "default" } })).toBe(
    "manual_approval",
  );
  expect(
    kimiPermission({ modes: { currentModeId: "future-mode" } }),
  ).toBeUndefined();
  expect(
    kimiPermission({
      modes: { currentModeId: "auto" },
      configOptions: [
        {
          type: "select",
          id: "mode",
          name: "Mode",
          category: "mode",
          currentValue: "plan",
          options: [{ value: "plan", name: "Plan" }],
        },
      ],
    }),
  ).toBe("read_only");
});
it("waits for ACP cancellation before steering and rejects concurrent steering", async () => {
  let finish!: (result: { stopReason: string }) => void;
  const prompt = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ stopReason: "end_turn" });
  const cancel = vi.fn().mockResolvedValue(undefined);
  const session = new KimiSession(
    { prompt, cancel } as never,
    "native-session",
    () => {},
    () => {},
  );
  await session.send("original");
  const steered = session.steer("correction");
  await expect(session.steer("duplicate")).rejects.toThrow(
    "session_input_pending",
  );
  expect(prompt).toHaveBeenCalledTimes(1);
  finish({ stopReason: "cancelled" });
  await expect(steered).resolves.toMatch(/^turn-/);
  expect(prompt).toHaveBeenLastCalledWith({
    sessionId: "native-session",
    prompt: [{ type: "text", text: "correction" }],
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe("Kimi bridge startup", () => {
  it("accepts Kimi's already-restored plan state but preserves other mode failures", async () => {
    const configOptions: SessionConfigOption[] = [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "live",
        options: [{ value: "live", name: "Live" }],
      },
      {
        type: "select",
        id: "mode",
        name: "Mode",
        category: "mode",
        currentValue: "default",
        options: [{ value: "plan", name: "Plan" }],
      },
    ];
    const alreadySet = Object.assign(new Error("Internal error"), {
      data: { details: "Already in plan mode" },
    });
    const connection = {
      setSessionConfigOption: vi.fn().mockRejectedValue(alreadySet),
    };
    await expect(
      applyKimiOptions(
        connection as never,
        "session-1",
        { mcpServers: [], permissionMode: "read_only" },
        undefined,
        configOptions,
      ),
    ).resolves.toBeUndefined();
    connection.setSessionConfigOption.mockRejectedValue(
      new Error("mode failed"),
    );
    await expect(
      applyKimiOptions(
        connection as never,
        "session-1",
        { mcpServers: [], permissionMode: "read_only" },
        undefined,
        configOptions,
      ),
    ).rejects.toThrow("mode failed");
  });

  it("applies selected model and thinking level through current ACP configuration", async () => {
    const configOptions: SessionConfigOption[] = [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "previous",
        options: [{ value: "live", name: "Live" }],
      },
      {
        type: "select",
        id: "thinking",
        name: "Thinking",
        category: "thought_level",
        currentValue: "low",
        options: [
          { value: "low", name: "Low" },
          { value: "max", name: "Max" },
        ],
      },
      {
        type: "select",
        id: "mode",
        name: "Mode",
        category: "mode",
        currentValue: "default",
        options: [{ value: "plan", name: "Plan" }],
      },
    ];
    const connection = {
      setSessionConfigOption: vi.fn().mockResolvedValue({ configOptions }),
    };
    await applyKimiOptions(
      connection as never,
      "session-1",
      {
        modelId: "live",
        thinkingEffort: "max",
        permissionMode: "read_only",
        mcpServers: [],
      },
      undefined,
      configOptions,
    );
    expect(
      connection.setSessionConfigOption.mock.calls.map(([request]) => request),
    ).toEqual([
      { sessionId: "session-1", configId: "model", value: "live" },
      { sessionId: "session-1", configId: "thinking", value: "max" },
      { sessionId: "session-1", configId: "mode", value: "plan" },
    ]);
  });

  it("rejects session creation with the real cause when the CLI cannot spawn", async () => {
    const home = mkdtempSync(join(tmpdir(), "workagent-kimi-home-"));
    roots.push(home);
    vi.stubEnv("KIMI_CODE_HOME", home);
    const bridge = new KimiBridge("workagent-missing-kimi-binary");
    // A spawn failure must reject create() instead of escaping as an
    // uncaught child error event; vitest fails the run on uncaught errors.
    await expect(
      bridge.create(home, () => {}, { mcpServers: [] }),
    ).rejects.toThrow(
      /^engine_start_failed:spawn workagent-missing-kimi-binary/,
    );
    await bridge.close();
  });

  it("re-codes opaque ACP session failures with engine context and data", () => {
    // The agent answers session/new with a bare JSON-RPC internal error; the
    // bridge must not propagate that bare message, because the team API would
    // otherwise emit a 400 {"error":"Internal error"}.
    const requestError = Object.assign(new Error("Internal error"), {
      code: -32603,
      data: { reason: "authentication required" },
    });
    expect(kimiSessionFailure("new", requestError).message).toBe(
      'engine_session_failed:kimi:new: Internal error {"reason":"authentication required"}',
    );
    expect(kimiSessionFailure("new", new Error("Internal error")).message).toBe(
      "engine_session_failed:kimi:new: Internal error",
    );
    expect(kimiSessionFailure("fork", "boom").message).toBe(
      "engine_session_failed:kimi:fork: boom",
    );
  });
});

describe("Kimi session terminal transitions", () => {
  it("accepts the next turn from a terminal event callback", async () => {
    let promptCount = 0;
    const connection = {
      prompt: async () => {
        promptCount += 1;
        return { stopReason: "end_turn" };
      },
      cancel: async () => undefined,
    };
    let followup: Promise<string> | undefined;
    const session = new KimiSession(
      connection as never,
      "session-1",
      (event) => {
        if (event.type === "turn.completed" && promptCount === 1) {
          followup = session.send("second turn");
        }
      },
      () => undefined,
    );

    await session.send("first turn");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(followup).resolves.toMatch(/^turn-/);
    expect(promptCount).toBe(2);
  });
});
