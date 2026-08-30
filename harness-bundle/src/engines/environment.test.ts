import { describe, expect, it } from "vitest";
import { nativeEngineEnvironment } from "./environment.js";

describe("native engine environment", () => {
  it("keeps the engine home while excluding runtime and unrelated secrets", () => {
    const environment = nativeEngineEnvironment(
      {
        Path: "C:\\Windows",
        CODEX_HOME: "C:\\private\\codex",
        KIMI_CODE_HOME: "C:\\private\\kimi",
        WORKAGENT_RUNTIME_TOKEN: "must-not-leak",
        OPENAI_API_KEY: "must-not-leak",
      },
      "CODEX_HOME",
    );

    expect(environment).toEqual({
      Path: "C:\\Windows",
      CODEX_HOME: "C:\\private\\codex",
    });
  });
});
