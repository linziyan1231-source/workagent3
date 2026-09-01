import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CapabilitySettingsContent from "./CapabilitySettingsContent.js";
import { systemPort } from "./systemPort.js";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("component capability settings", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("shows platform health and required Runtime risk from the read model", async () => {
    vi.spyOn(systemPort, "capabilities").mockResolvedValue({
      schemaVersion: 1,
      platformModules: [
        {
          manifest: {
            id: "portal-auth",
            version: "1.0.0",
            layer: "platform",
            required: true,
            capabilities: ["auth.session"],
            dependencies: [],
            configSchema: "workagent://schemas/portal-auth/v1",
            dataOwner: "central users and browser sessions",
            healthCheck: "/api/auth/me",
          },
          status: "healthy",
        },
      ],
      runtimeModules: [
        {
          id: "personal-work",
          version: "1.0.0",
          layer: "runtime",
          required: true,
          capabilities: ["session.lifecycle"],
          dependencies: [],
          configSchema: "workagent://schemas/personal-work/v1",
          dataOwner: "employee SID private sessions",
          healthCheck: "/v1/sessions",
        },
      ],
      runtimeStatus: "unhealthy",
      engines: {},
    });

    await act(async () => {
      root.render(<CapabilitySettingsContent />);
    });

    expect(container.textContent).toContain("portal-auth");
    expect(container.textContent).toContain("personal-work");
    expect(container.textContent).toContain("unhealthy");
    expect(container.textContent).toContain("Required");
  });
});
