import { expect, it, vi } from "vitest";
import { apply } from "./index.js";

it("serves the palette stylesheet with GET/HEAD and rejects other methods", async () => {
  let route;
  apply({
    effect: (fn) => fn(),
    webServer: {
      register: (value) => {
        route = value;
      },
    },
  });
  for (const method of ["GET", "HEAD", "POST"]) {
    const response = { writeHead: vi.fn(), end: vi.fn() };
    await route.handler({ method }, response);
    expect(response.writeHead.mock.calls[0][0]).toBe(
      method === "POST" ? 405 : 200,
    );
    if (method === "GET")
      expect(response.end.mock.calls[0][0].toString()).toContain(
        'data-workagent-theme="graphite"',
      );
    else expect(response.end.mock.calls[0][0]).toBeUndefined();
  }
});
