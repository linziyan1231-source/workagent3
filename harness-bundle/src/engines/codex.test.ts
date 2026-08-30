import { describe, expect, it } from "vitest";
import { codexAccountStatus } from "./codex.js";

describe("Codex account status", () => {
  it("requires native login only when the provider requires OpenAI auth", () => {
    expect(
      codexAccountStatus({ account: null, requiresOpenaiAuth: true }),
    ).toMatchObject({ state: "needs_auth", authenticated: false });
    expect(
      codexAccountStatus({ account: null, requiresOpenaiAuth: false }),
    ).toMatchObject({ state: "ready", authenticated: true });
    expect(
      codexAccountStatus({
        account: { type: "chatgpt" },
        requiresOpenaiAuth: true,
      }),
    ).toMatchObject({ state: "ready", authenticated: true });
  });
});
