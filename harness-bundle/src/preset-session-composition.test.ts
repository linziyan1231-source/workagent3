import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelAccessStore } from "./model-access-store.js";
import { PresetStore } from "./preset-store.js";
import { SessionIndex } from "./session-index.js";

describe("Preset and persisted session composition", () => {
  it("keeps an existing session on its resolved Preset version after update and restart", () => {
    const home = mkdtempSync(join(tmpdir(), "workagent-preset-session-"));
    const presets = new PresetStore(home, new ModelAccessStore(home));
    const created = presets.create({
      name: "Stable native assistant",
      engine: "codex",
      systemPrompt: "Version one",
    });
    const originalBinding = presets.resolve(created.id);
    const sessions = new SessionIndex(home);
    sessions.set({
      id: "session-existing",
      nativeId: "native-existing",
      engine: "codex",
      title: "Existing conversation",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      workspaceId: "workspace-1",
      preset: originalBinding,
    });

    presets.update(created.id, {
      systemPrompt: "Version two",
      approvalPolicy: "always_ask",
    });

    const restartedPresets = new PresetStore(home, new ModelAccessStore(home));
    const restartedSession = new SessionIndex(home).list()[0];
    expect(restartedPresets.resolve(created.id)).toMatchObject({
      presetVersion: 2,
      resolvedSnapshot: {
        systemPrompt: "Version two",
        approvalPolicy: "always_ask",
      },
    });
    expect(restartedSession?.preset).toMatchObject({
      presetVersion: 1,
      resolvedSnapshot: {
        systemPrompt: "Version one",
        approvalPolicy: "on_risk",
      },
    });
  });
});
