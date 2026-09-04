// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let registration;
let client;

beforeAll(async () => {
  window.__ModuleLoader__ = { load: (value) => (registration = value) };
  await import("./client.js");
  client = registration.factory((name) => {
    if (name === "react") return React;
    throw new Error(`unexpected client external ${name}`);
  });
});

beforeEach(() => {
  const values = new Map();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => values.delete(key),
      setItem: (key, value) => values.set(key, String(value)),
    },
  });
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

function compose() {
  const entries = [];
  const theme = {
    getTheme: vi.fn(() => ({ preference: "light", resolved: "light" })),
    setTheme: vi.fn(),
  };
  const ctx = {
    theme,
    slots: {
      inject: (_name, callback) => {
        const result = callback();
        if (result?.[Symbol.iterator]) [...result];
        return () => {};
      },
      register: (options, Component) => {
        entries.push({ options, Component });
        return () => {};
      },
    },
  };
  client.apply(ctx);
  entries.theme = theme;
  return entries;
}

describe("WorkAgent dsh slot components", () => {
  it("renders WorkAgent branding through official brand slots", () => {
    const entries = compose();
    const brand = entries.find(
      (entry) => entry.options.name === "sidebar.brand.name",
    );
    render(React.createElement(brand.Component));
    expect(screen.getByText("WorkAgent")).toBeTruthy();
    expect(document.title).toBe("WorkAgent");
  });

  it("renders MCP state and calls the managed toggle API", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init = {}) => {
        if (init.method === "PATCH")
          return new Response("{}", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        return new Response(
          JSON.stringify([
            {
              id: "docs",
              name: "Docs",
              source: "user",
              enabled: true,
              oauthState: "needs_auth",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
    const entries = compose();
    const section = entries.find(
      (entry) => entry.options.id === "workagent-mcp",
    );
    render(React.createElement(section.Component));
    fireEvent.click(await screen.findByRole("button", { name: "Disable" }));
    expect(screen.getByRole("button", { name: "Authorize" })).toBeTruthy();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runtime/v1/mcp-servers/docs",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      enabled: false,
    });
  });

  it("creates an HTTP MCP server from the focused form", async () => {
    let rows = [];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_path, init = {}) => {
        if (init.method === "POST") {
          const input = JSON.parse(init.body);
          rows = [{ ...input, id: "docs", health: "unknown" }];
          return new Response(JSON.stringify(rows[0]), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
    const mcp = compose().find((entry) => entry.options.id === "workagent-mcp");
    const { container } = render(React.createElement(mcp.Component));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Docs" },
    });
    fireEvent.change(screen.getByLabelText("Endpoint"), {
      target: { value: "https://example.com/mcp" },
    });
    fireEvent.submit(container.querySelector("form"));
    expect(await screen.findByText("Docs")).toBeTruthy();
    expect(
      JSON.parse(
        fetchMock.mock.calls.find((call) => call[1]?.method === "POST")[1].body,
      ),
    ).toMatchObject({
      name: "Docs",
      transport: { kind: "http", url: "https://example.com/mcp" },
    });
  });

  it("renders all extension tabs", () => {
    const entries = compose();
    const section = entries.find(
      (entry) => entry.options.id === "workagent-extensions",
    );
    render(React.createElement(section.Component));
    expect(screen.getByText("Message channels")).toBeTruthy();
    expect(screen.getByText("Usage quota")).toBeTruthy();
    expect(screen.getByText("Data migration")).toBeTruthy();
  });

  it.each([
    [
      "Message channels",
      "/api/channels/connectors",
      [{ id: "weixin", display_name: "Weixin", state: { running: true } }],
    ],
    [
      "Usage quota",
      "/api/quota/gateway-usage",
      { dailyTokens: 12, weeklyTokens: 40 },
    ],
    [
      "Runtime components",
      "/api/system/status",
      { components: [{ id: "harness", status: "healthy" }] },
    ],
    [
      "Data migration",
      "/api/runtime/v1/migrations/skills-mcp",
      { items: [{ id: "legacy", disposition: "needs_review" }] },
    ],
  ])(
    "loads real data for the %s extension tab",
    async (name, endpoint, payload) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const section = compose().find(
        (entry) => entry.options.id === "workagent-extensions",
      );
      render(React.createElement(section.Component));
      fireEvent.click(screen.getByRole("button", { name }));
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(endpoint, expect.anything()),
      );
    },
  );

  it("creates, edits, and deletes a preset through the complete editor", async () => {
    let rows = [];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_path, init = {}) => {
        if (init.method === "POST") {
          const input = JSON.parse(init.body);
          rows = [{ ...input, id: "new", source: "user" }];
          return new Response(JSON.stringify(rows[0]), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (init.method === "PATCH") {
          rows = [{ ...rows[0], ...JSON.parse(init.body) }];
          return new Response(JSON.stringify(rows[0]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (init.method === "DELETE") {
          rows = [];
          return new Response(null, { status: 204 });
        }
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
    const section = compose().find(
      (entry) => entry.options.id === "workagent-presets",
    );
    const { container } = render(React.createElement(section.Component));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Writer" },
    });
    fireEvent.submit(container.querySelector("form"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runtime/v1/presets",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(
      JSON.parse(
        fetchMock.mock.calls.find((call) => call[1]?.method === "POST")[1].body,
      ),
    ).toMatchObject({
      name: "Writer",
      engine: "harness",
      skillIds: [],
      mcpServerIds: [],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Editor" },
    });
    fireEvent.submit(container.querySelector("form"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runtime/v1/presets/new",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runtime/v1/presets/new",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });

  it("renders centrally managed models without credential fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "deepseek",
            displayName: "DeepSeek",
            health: "healthy",
            authorization: { authorized: true },
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const section = compose().find(
      (entry) => entry.options.id === "workagent-models",
    );
    render(React.createElement(section.Component));
    expect(await screen.findByText("DeepSeek")).toBeTruthy();
    expect(screen.queryByLabelText(/key/i)).toBeNull();
  });

  it("uses the official theme service", () => {
    const entries = compose();
    const themeEntry = entries.find(
      (entry) => entry.options.id === "workagent-theme",
    );
    render(React.createElement(themeEntry.Component, { wide: true }));
    fireEvent.click(screen.getByRole("button", { name: "Theme" }));
    expect(entries.theme.setTheme).toHaveBeenCalledWith("dark");
  });

  it("runs scheduled tasks from the dedicated page", async () => {
    window.history.replaceState({}, "", "/?workagent=automations");
    const definition = {
      id: "daily",
      name: "Daily brief",
      nextRunAt: "tomorrow",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_path, init = {}) =>
        new Response(
          JSON.stringify(init.method === "POST" ? {} : [definition]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    const overlay = compose().find(
      (entry) => entry.options.id === "workagent-page",
    );
    render(React.createElement(overlay.Component));
    fireEvent.click(await screen.findByRole("button", { name: "Run now" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runtime/v1/automations/daily/run",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("dispatches work from the team page", async () => {
    window.history.replaceState({}, "", "/?workagent=teams");
    const team = {
      id: "team-1",
      name: "Research",
      members: [{ id: "lead", presetId: "writer" }],
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_path, init = {}) =>
        new Response(JSON.stringify(init.method === "POST" ? {} : [team]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const overlay = compose().find(
      (entry) => entry.options.id === "workagent-page",
    );
    render(React.createElement(overlay.Component));
    fireEvent.click(
      await screen.findByRole("button", { name: "Dispatch task" }),
    );
    fireEvent.change(screen.getByLabelText("Team action value"), {
      target: { value: "Investigate" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runtime/v1/teams/team-1/tasks",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("browses and previews workspace text files", async () => {
    window.history.replaceState({}, "", "/?workagent=workspaces");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (path) => {
      if (String(path).includes("/content?"))
        return new Response("hello workspace", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      const payload = String(path).endsWith("/files")
        ? [{ name: "notes.txt", path: "notes.txt", kind: "file" }]
        : [{ id: "workspace-1", name: "Project" }];
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const overlay = compose().find(
      (entry) => entry.options.id === "workagent-page",
    );
    render(React.createElement(overlay.Component));
    fireEvent.click(await screen.findByRole("button", { name: "Browse" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    expect(await screen.findByText("hello workspace")).toBeTruthy();
  });

  it("shows unread notifications and acknowledges them", async () => {
    window.history.replaceState({}, "", "/?workagent=notifications");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_path, init = {}) =>
        new Response(
          JSON.stringify(
            init.method === "POST"
              ? { success: true }
              : {
                  notifications: [
                    { id: "notice-1", kind: "task", message: "Done" },
                  ],
                },
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const overlay = compose().find(
      (entry) => entry.options.id === "workagent-page",
    );
    render(React.createElement(overlay.Component));
    expect(await screen.findByText("Done")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/portal/me/notifications/notice-1/acknowledge",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("searches messages inside the active conversation", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (path, init = {}) =>
        new Response(
          JSON.stringify(
            init.method === "POST"
              ? null
              : {
                  items: [
                    {
                      session: { id: "session-1" },
                      message: { id: "message-1", content: "needle result" },
                    },
                  ],
                },
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const utility = compose().find(
      (entry) => entry.options.id === "workagent-message-search",
    );
    const { container } = render(
      React.createElement(utility.Component, { sessionId: "session-1" }),
    );
    fireEvent.change(screen.getByLabelText("Search messages"), {
      target: { value: "needle" },
    });
    fireEvent.submit(container.querySelector("form"));
    expect(await screen.findByText("needle result")).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toContain("session_id=session-1");
    fireEvent.click(screen.getByRole("button", { name: "Edit and resend" }));
    const editor = screen.getByLabelText("Edit message");
    expect(editor.value).toBe("needle result");
    fireEvent.change(editor, { target: { value: "edited result" } });
    fireEvent.click(screen.getByRole("button", { name: "Resend" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runtime/v1/sessions/session-1/fork",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            messageId: "message-1",
            replacementContent: "edited result",
          }),
        }),
      ),
    );
  });

  it("opens message search for a session deep link", () => {
    window.history.replaceState({}, "", "/?session=session-1");
    const overlay = compose().find(
      (entry) => entry.options.id === "workagent-page",
    );
    render(React.createElement(overlay.Component));
    expect(screen.getByRole("dialog", { name: "message search" })).toBeTruthy();
    expect(screen.getByLabelText("Search messages")).toBeTruthy();
  });

  it("scrolls to and highlights an opened search result", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              session: { id: "session-1" },
              message: { id: "message-1", content: "needle result" },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const target = document.createElement("article");
    target.textContent = "needle result";
    target.scrollIntoView = vi.fn();
    document.body.append(target);
    const utility = compose().find(
      (entry) => entry.options.id === "workagent-message-search",
    );
    const { container } = render(
      React.createElement(utility.Component, { sessionId: "session-1" }),
    );
    fireEvent.change(screen.getByLabelText("Search messages"), {
      target: { value: "needle" },
    });
    fireEvent.submit(container.querySelector("form"));
    fireEvent.click(await screen.findByRole("button", { name: "Open result" }));
    expect(target.scrollIntoView).toHaveBeenCalled();
    expect(target.classList.contains("workagent-message-highlight")).toBe(true);
  });
});
