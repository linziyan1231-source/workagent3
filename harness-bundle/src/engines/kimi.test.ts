import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KimiBridge, KimiSession, kimiSessionFailure } from "./kimi.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe("Kimi bridge startup", () => {
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
