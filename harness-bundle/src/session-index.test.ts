import { mkdirSync, mkdtempSync, readFileSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionIndex, type StoredSession } from "./session-index.js";

const operationSession = (): StoredSession & {
  creation: NonNullable<StoredSession["creation"]>;
} => ({
  id: "session-op-personal_durable",
  nativeId: "session-op-personal_durable",
  engine: "codex",
  title: "Task",
  createdAt: "2026-09-12T00:00:00Z",
  updatedAt: "2026-09-12T00:00:00Z",
  creation: {
    operationId: "personal_durable",
    input: {
      engine: "codex",
      title: "Task",
      workspace: "default",
      presetId: "builtin-codex",
    },
  },
});

// Making the temporary file a directory causes a real writeFileSync failure on
// Windows and Linux without relying on disk capacity or elevated permissions.
const blockWrite = (home: string, file: string) => {
  const temporary = join(home, "workagent", `${file}.${process.pid}.tmp`);
  mkdirSync(temporary, { recursive: true });
  return () => rmdirSync(temporary);
};

describe("SID-private session index", () => {
  it("retains only the operation ID separately after deleting conversation content", () => {
    const home = mkdtempSync(join(tmpdir(), "workagent-session-tombstone-"));
    const index = new SessionIndex(home);
    const creation = {
      operationId: "personal_deleted",
      input: {
        engine: "codex" as const,
        title: "Task",
        workspace: "default",
        presetId: "builtin-codex",
      },
    };
    index.createOnce({
      id: "session-op-personal_deleted",
      nativeId: "native-id",
      engine: "codex",
      title: "Task",
      createdAt: "2026-09-12T00:00:00Z",
      updatedAt: "2026-09-12T00:00:00Z",
      creation,
      queue: [{ messageId: "message-1", content: "private queued content" }],
      pendingContext: "private inherited context",
    });
    index.delete("session-op-personal_deleted");
    const recovered = new SessionIndex(home);
    expect(recovered.list()).toEqual([]);
    expect(() => recovered.operation(creation)).toThrow("operation_deleted");
    const saved = readFileSync(
      join(home, "workagent", "sessions.json"),
      "utf8",
    );
    expect(saved).not.toContain("private queued content");
    expect(saved).not.toContain("private inherited context");
    expect(JSON.parse(saved)).toEqual([]);
    expect(
      JSON.parse(
        readFileSync(
          join(home, "workagent", "session-operations.json"),
          "utf8",
        ),
      ),
    ).toEqual([creation.operationId]);
    expect(recovered.lookupOperation(creation.operationId)).toEqual({
      session: undefined,
      state: "deleted",
    });
  });

  it("keeps rollback readers' session array free of cancellation and deleted rows", () => {
    const home = mkdtempSync(join(tmpdir(), "workagent-session-rollback-"));
    const index = new SessionIndex(home);
    const session = operationSession();
    index.createOnce(session);
    index.cancelOperation("personal_never_created");
    const rows = JSON.parse(
      readFileSync(join(home, "workagent", "sessions.json"), "utf8"),
    ) as StoredSession[];
    // The released reader validates every row, then lists all rows without any
    // knowledge of operation IDs or deleted flags.
    expect(rows).toEqual([session]);
    expect(
      rows.every(
        (row) =>
          typeof row.id === "string" &&
          typeof row.nativeId === "string" &&
          typeof row.engine === "string" &&
          typeof row.title === "string" &&
          typeof row.createdAt === "string" &&
          typeof row.updatedAt === "string",
      ),
    ).toBe(true);
    index.delete(session.id);
    expect(
      JSON.parse(
        readFileSync(join(home, "workagent", "sessions.json"), "utf8"),
      ),
    ).toEqual([]);
  });

  it("does not acknowledge an operation existing only in memory after a failed create write", () => {
    const home = mkdtempSync(
      join(tmpdir(), "workagent-session-create-failure-"),
    );
    const index = new SessionIndex(home);
    const session = operationSession();
    const unblock = blockWrite(home, "sessions.json");
    try {
      expect(() => index.createOnce(session)).toThrow();
      expect(index.operation(session.creation)).toBeUndefined();
      expect(index.list()).toEqual([]);
      expect(
        new SessionIndex(home).operation(session.creation),
      ).toBeUndefined();
    } finally {
      unblock();
    }
    index.createOnce(session);
    expect(new SessionIndex(home).operation(session.creation)).toEqual(session);
  });

  it("does not commit a failed update or cancellation to memory", () => {
    const home = mkdtempSync(
      join(tmpdir(), "workagent-session-update-failure-"),
    );
    const index = new SessionIndex(home);
    const session = operationSession();
    index.createOnce(session);
    let unblock = blockWrite(home, "sessions.json");
    try {
      expect(() => index.set({ ...session, title: "Not persisted" })).toThrow();
      expect(index.operation(session.creation)).toEqual(session);
      expect(new SessionIndex(home).operation(session.creation)).toEqual(
        session,
      );
    } finally {
      unblock();
    }
    unblock = blockWrite(home, "session-operations.json");
    try {
      expect(() =>
        index.cancelOperation(session.creation.operationId),
      ).toThrow();
      expect(index.lookupOperation(session.creation.operationId)?.state).toBe(
        "ready",
      );
      expect(
        new SessionIndex(home).lookupOperation(session.creation.operationId)
          ?.state,
      ).toBe("ready");
    } finally {
      unblock();
    }
  });

  it("recovers a durable delete intent after the session removal write fails", () => {
    const home = mkdtempSync(
      join(tmpdir(), "workagent-session-delete-failure-"),
    );
    const index = new SessionIndex(home);
    const session = operationSession();
    index.createOnce(session);
    const unblock = blockWrite(home, "sessions.json");
    try {
      expect(() => index.delete(session.id)).toThrow();
      expect(index.lookupOperation(session.creation.operationId)).toEqual({
        session,
        state: "deleting",
      });
      expect(index.list()).toEqual([]);
      expect(() => index.createOnce(session)).toThrow("operation_deleted");
      const recovered = new SessionIndex(home);
      expect(recovered.lookupOperation(session.creation.operationId)).toEqual({
        session,
        state: "deleting",
      });
      expect(recovered.list()).toEqual([]);
    } finally {
      unblock();
    }
    const recovered = new SessionIndex(home);
    recovered.delete(session.id);
    expect(recovered.lookupOperation(session.creation.operationId)).toEqual({
      session: undefined,
      state: "deleted",
    });
    expect(
      new SessionIndex(home).lookupOperation(session.creation.operationId),
    ).toEqual({ session: undefined, state: "deleted" });
  });
  it("persists only runtime metadata and reloads newest first", () => {
    const home = mkdtempSync(join(tmpdir(), "workagent-session-index-"));
    const index = new SessionIndex(home);
    index.set({
      id: "session-old",
      nativeId: "native-old",
      engine: "codex",
      title: "Old",
      createdAt: "2026-08-29T10:00:00.000Z",
      updatedAt: "2026-08-29T10:00:00.000Z",
    });
    index.set({
      id: "session-new",
      nativeId: "native-new",
      engine: "kimi",
      title: "New",
      createdAt: "2026-08-30T10:00:00.000Z",
      updatedAt: "2026-08-30T10:00:00.000Z",
      lastTurn: {
        id: "turn-done",
        completedAt: "2026-08-30T10:00:00.000Z",
        status: "completed",
      },
    });

    expect(new SessionIndex(home).list().map((item) => item.id)).toEqual([
      "session-new",
      "session-old",
    ]);
    expect(new SessionIndex(home).list()[0]?.lastTurn).toEqual({
      id: "turn-done",
      completedAt: "2026-08-30T10:00:00.000Z",
      status: "completed",
    });
    expect(new SessionIndex(home).list()[1]?.lastTurn).toBeUndefined();
    expect(
      readFileSync(join(home, "workagent", "sessions.json"), "utf8"),
    ).not.toContain("password");
  });
});
