import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { apply as applyHost } from "./index.js";

describe("WorkAgent dsh client composition", () => {
  const client = readFileSync(new URL("./client.js", import.meta.url), "utf8");

  it("uses only official slot extension points", () => {
    expect(client).toContain('ctx.slots.inject("settings.section"');
    expect(client).toContain('ctx.slots.inject("sidebar.footer.action"');
    expect(client).toContain(
      'ctx.slots.inject("conversation.session.header.utilities"',
    );
    expect(client).not.toContain("Harness Key");
  });

  it("routes assistants to the real preset editor and supports message forks", () => {
    expect(client).toContain(
      'assistants: ["Assistants", navigate("assistants")]',
    );
    expect(client).toContain("/fork");
    expect(client).toContain("replacementContent");
  });

  it.each([
    "MCP servers",
    "Skills",
    "Engines",
    "Extensions",
    "Presets",
    "Models",
    "Scheduled tasks",
    "Teams",
    "Notifications",
  ])("registers %s", (name) => {
    expect(client).toContain(name);
  });
});

describe("WorkAgent dsh host composition", () => {
  const host = readFileSync(new URL("./index.js", import.meta.url), "utf8");

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
