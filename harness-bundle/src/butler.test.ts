import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowedButlerRequest,
  butlerRequest,
  redactButlerValue,
  butlerPrompt,
} from "./butler.js";
import { PresetStore } from "./preset-store.js";
import { ModelAccessStore } from "./model-access-store.js";

describe("PuxinAI butler", () => {
  it("uses a normal built-in assistant and preserves its switch", () => {
    const home = mkdtempSync(join(tmpdir(), "wa3-butler-"));
    const store = new PresetStore(home, new ModelAccessStore(home));
    const preset = store.resolve("builtin-puxin-butler").resolvedSnapshot;
    expect(preset.engine).toBe("codex");
    expect(preset.systemPrompt).toContain("butler_overview");
    store.update("builtin-puxin-butler", { enabled: false });
    expect(
      new PresetStore(home, new ModelAccessStore(home)).get(
        "builtin-puxin-butler",
      )?.enabled,
    ).toBe(false);
    expect(butlerPrompt()).not.toContain(
      process.env.WORKAGENT_RUNTIME_TOKEN || "NEVER_INCLUDE_TOKEN",
    );
  });
  it("limits operations to employee configuration and suppresses nested secrets", () => {
    expect(
      allowedButlerRequest(
        "POST",
        "/dsh-im-connect/api/accounts/weixin:one/settings",
      ),
    ).toBe(true);
    expect(
      allowedButlerRequest("GET", "/v1/completion-notifications/targets"),
    ).toBe(true);
    expect(
      allowedButlerRequest("POST", "/v1/completion-notifications/send"),
    ).toBe(true);
    for (const path of [
      "https://example.test",
      "/internal/mcp-projection",
      "/v1/../internal/test",
      "/v1/skills/%2e%2e",
      "/api/admin/employees",
      "/v1/sessions/one/turns",
    ])
      expect(allowedButlerRequest("POST", path)).toBe(false);
    expect(
      redactButlerValue({
        config: { appSecret: "hidden", password: "hidden", api_key: "hidden" },
        url: "https://example.test?token=hidden",
        state: "ready",
      }),
    ).toEqual({
      config: {
        appSecret: "[已隐藏]",
        password: "[已隐藏]",
        api_key: "[已隐藏]",
      },
      url: "https://example.test?token=[已隐藏]",
      state: "ready",
    });
  });
  it("updates the same channel API with authentication, then reads back state", async () => {
    const home = mkdtempSync(join(tmpdir(), "wa3-butler-api-"));
    mkdirSync(join(home, "workagent"));
    let settings = { name: "before" };
    const server = createServer(async (req, res) => {
      expect(req.headers.authorization).toBe("Bearer fixture-secret");
      expect(req.headers["x-dsh-im-connect-client"]).toBe("1");
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        settings = JSON.parse(body);
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, settings, token: "must-not-leak" }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address() as { port: number };
      writeFileSync(
        join(home, "workagent", "runtime-gateway.json"),
        JSON.stringify({
          baseURL: `http://127.0.0.1:${address.port}`,
          token: "fixture-secret",
        }),
      );
      const env = { DSH_HOME: home, WORKAGENT_RUNTIME_TOKEN: "fixture-secret" };
      expect(
        (
          await butlerRequest(
            "POST",
            "/dsh-im-connect/api/accounts/weixin/settings",
            { name: "after" },
            env,
          )
        ).ok,
      ).toBe(true);
      const result = await butlerRequest(
        "GET",
        "/dsh-im-connect/api/channels",
        undefined,
        env,
      );
      expect(result.data).toEqual({
        ok: true,
        settings: { name: "after" },
        token: "[已隐藏]",
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
