import { afterEach, expect, test, vi } from "vitest";
import { authPort } from "./authPort.js";

afterEach(() => vi.unstubAllGlobals());

test("remembered login uses the device cookie without sending a password", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"user":{"username":"alice"}}', {
    headers: { "content-type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  await authPort.loginRemembered("alice");
  expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", expect.objectContaining({
    method: "POST",
    body: JSON.stringify({ username: "alice", useRemembered: true, remember: true }),
  }));
});

test("password change projects Renderer fields onto the Portal contract", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response('{"success":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    authPort.changePassword({
      username: "alice",
      currentPassword: "current password",
      newPassword: "replacement password",
      confirmPassword: "replacement password",
    }),
  ).resolves.toEqual({ success: true });
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/auth/password",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        username: "alice",
        current_password: "current password",
        new_password: "replacement password",
        confirm_password: "replacement password",
      }),
    }),
  );
});

test("password change maps Portal policy failures for the formal Renderer", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response('{"code":"PASSWORD_REUSED"}', {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    ),
  );

  await expect(
    authPort.changePassword({
      username: "alice",
      currentPassword: "same password value",
      newPassword: "same password value",
      confirmPassword: "same password value",
    }),
  ).resolves.toEqual({ success: false, code: "passwordReused" });
});
test("login sends the selected persistent-session preference", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response('{"user":{"username":"alice"}}', {
        headers: { "content-type": "application/json" },
      }),
    );
  vi.stubGlobal("fetch", fetchMock);
  await authPort.login("alice", "a test password", true);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/auth/login",
    expect.objectContaining({
      body: JSON.stringify({
        username: "alice",
        password: "a test password",
        remember: true,
      }),
    }),
  );
});
