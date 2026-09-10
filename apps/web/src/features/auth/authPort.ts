import { ApiError, requestJson } from "../../shared/api/http.js";
import type { AuthUser } from "../../shared/types/auth.js";
export type { AuthUser } from "../../shared/types/auth.js";

type UserEnvelope = { user: AuthUser };

export type ChangePasswordInput = {
  username: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

export type ChangePasswordErrorCode =
  | "requiredFields"
  | "passwordMismatch"
  | "invalidCurrentPassword"
  | "passwordPolicy"
  | "passwordReused"
  | "tooManyAttempts"
  | "serverError"
  | "networkError"
  | "securityError"
  | "unknown";

export type ChangePasswordResult = {
  success: boolean;
  message?: string;
  code?: ChangePasswordErrorCode;
};

export const authPort = {
  async currentUser(): Promise<AuthUser> {
    return (await requestJson<UserEnvelope>("/api/auth/me")).user;
  },
  async login(
    username: string,
    password: string,
    remember = false,
  ): Promise<AuthUser> {
    return (
      await requestJson<UserEnvelope>("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password, remember }),
      })
    ).user;
  },
  logout(): Promise<void> {
    return requestJson("/api/auth/logout", { method: "POST" });
  },
  rememberedLogin(): Promise<{ username: string | null }> {
    return requestJson("/api/auth/remembered");
  },
  forgetLogin(): Promise<void> {
    return requestJson("/api/auth/remembered", { method: "DELETE" });
  },
  async loginRemembered(username: string): Promise<AuthUser> {
    return (
      await requestJson<UserEnvelope>("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, useRemembered: true, remember: true }),
      })
    ).user;
  },
  async changePassword(
    input: ChangePasswordInput,
  ): Promise<ChangePasswordResult> {
    try {
      await requestJson<{ success: true }>("/api/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: input.username,
          current_password: input.currentPassword,
          new_password: input.newPassword,
          confirm_password: input.confirmPassword,
        }),
      });
      return { success: true };
    } catch (error) {
      if (!(error instanceof ApiError)) {
        return { success: false, code: "networkError" };
      }
      const codeMap: Record<string, ChangePasswordErrorCode> = {
        REQUIRED_FIELDS: "requiredFields",
        PASSWORD_MISMATCH: "passwordMismatch",
        INVALID_CURRENT_PASSWORD: "invalidCurrentPassword",
        PASSWORD_POLICY: "passwordPolicy",
        PASSWORD_REUSED: "passwordReused",
        RATE_LIMITED: "tooManyAttempts",
        ORIGIN_REJECTED: "securityError",
        SERVER_ERROR: "serverError",
      };
      return {
        success: false,
        code:
          codeMap[error.code] ??
          (error.status >= 500 ? "serverError" : "unknown"),
      };
    }
  },
};
