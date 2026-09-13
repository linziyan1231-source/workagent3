import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { apply as applyHost } from "./index.js";

describe("WorkAgent dsh client composition", () => {
  const client = readFileSync(new URL("./client.js", import.meta.url), "utf8");

  it("uses only official slot extension points", () => {
    expect(client).toContain('ctx.slots.inject("settings.section"');
    expect(client).toContain('ctx.slots.inject("sidebar.footer.action"');
    expect(client).toContain('ctx.slots.inject("conversation.hero.brand.mark"');
    expect(client).toContain('ctx.slots.inject("conversation.hero.workspace"');
    expect(client).toContain('ctx.slots.inject("sidebar.workspaces"');
    expect(client).not.toContain("Harness Key");
  });

  it("routes assistants to the real preset editor", () => {
    expect(client).toContain('assistants: ["助手", navigate("assistants")]');
    expect(client).toContain(
      'localStorage.getItem(CHAT_PAGE_KEY) || "/chatgpt/"',
    );
  });

  it("uses the WorkAgent visual language for shell actions and agents", () => {
    expect(client).toContain("workagent-brand-mark");
    expect(client).toContain('name: "notifications"');
    expect(client).toContain("workagent-agent-strip");
    expect(client).toContain("workagent-hero-composer");
    expect(client).not.toContain('preset.engine !== "harness"');
    expect(client).not.toContain("wide ? label : label.slice(0, 1)");
    expect(client).toContain("workagent-overlay");
  });

  it.each([
    "MCP与技能",
    "网页发布",
    "引擎",
    "助手",
    "模型",
    "定时任务",
    "团队",
    "通知",
  ])("registers %s", (name) => {
    expect(client).toContain(name);
  });
});

describe("WorkAgent dsh host composition", () => {
  const host = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  it("serves the isolated document renderer and its pinned browser dependencies", async () => {
    const routes = [];
    applyHost({
      effect: (callback) => callback(),
      webServer: { register: (value) => routes.push(value) },
    });
    for (const name of [
      "document-preview.html",
      "docx-preview.js",
      "jszip.js",
    ]) {
      const route = routes.find((value) => value.path.endsWith(`/${name}`));
      let body;
      await route.handler(
        { method: "GET" },
        {
          writeHead: (status) => expect(status).toBe(200),
          end: (data) => (body = data.toString()),
        },
      );
      expect(body.length).toBeGreaterThan(1000);
      if (name === "docx-preview.js") expect(body).toContain("factory");
      if (name === "document-preview.html")
        expect(body).toContain("renderAltChunks: false");
    }
  });

  it("exports package metadata for DSH client discovery", () => {
    const require = createRequire(import.meta.url);
    expect(require.resolve("@workagent/dsh-client/package.json")).toMatch(
      /dsh-client-workagent[\\/]package\.json$/,
    );
  });

  it("serves the external token stylesheet from the client plugin path", () => {
    expect(host).toContain("/plugins/@workagent/dsh-client/tokens.css");
    expect(host).toContain('"content-type": "text/css; charset=utf-8"');
  });

  it("returns the stylesheet with a CSS content type", async () => {
    let registration;
    applyHost({
      effect: (callback) => callback(),
      webServer: { register: (value) => (registration = value) },
    });
    let status;
    let headers;
    let body;
    await registration.handler(
      { method: "GET" },
      {
        writeHead: (nextStatus, nextHeaders) => {
          status = nextStatus;
          headers = nextHeaders;
        },
        end: (value) => {
          body = value;
        },
      },
    );
    expect(status).toBe(200);
    expect(headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(body.toString()).toContain("--dsw-color-bg");
  });
});
