import { requestJson } from "../../shared/api/http.js";
import type { AuthUser } from "../../shared/types/auth.js";
export type { AuthUser } from "../../shared/types/auth.js";

type UserEnvelope = { user: AuthUser };

export const authPort = {
  async currentUser(): Promise<AuthUser> {
    return (await requestJson<UserEnvelope>("/api/auth/me")).user;
  },
  async login(username: string, password: string): Promise<AuthUser> {
    return (
      await requestJson<UserEnvelope>("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      })
    ).user;
  },
  logout(): Promise<void> {
    return requestJson("/api/auth/logout", { method: "POST" });
  },
};
