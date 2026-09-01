import { describe, expect, it } from "vitest";
import { KimiSession } from "./kimi.js";

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
