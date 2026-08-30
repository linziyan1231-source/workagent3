import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ipcBridge } from '@/common';
// M6: CSRF removed with legacy webserver — stub functions for compatibility, re-implement in M7
const withCsrfToken = <T extends Record<string, unknown>>(data: T): T => data;
const hasValidCsrfToken = (): boolean => true;
const clearCookie = (_name: string, _path?: string): void => {};
const CSRF_COOKIE_NAME = 'csrf-token';

type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated';

export interface AuthUser {
  id: string;
  username: string;
  display_name?: string;
  admin?: boolean;
  collaboration_enabled?: boolean;
  collaboration_capable?: boolean;
}

interface LoginParams {
  username: string;
  password: string;
  remember?: boolean;
}

export interface ChangePasswordParams {
  username: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

type LoginErrorCode =
  | 'invalidCredentials'
  | 'tooManyAttempts'
  | 'serverError'
  | 'networkError'
  | 'csrfError'
  | 'unknown';

interface LoginResult {
  success: boolean;
  message?: string;
  code?: LoginErrorCode;
  shouldClearCache?: boolean;
}

export type ChangePasswordErrorCode =
  | 'requiredFields'
  | 'passwordMismatch'
  | 'invalidCurrentPassword'
  | 'passwordPolicy'
  | 'passwordReused'
  | 'tooManyAttempts'
  | 'serverError'
  | 'networkError'
  | 'securityError'
  | 'unknown';

export interface ChangePasswordResult {
  success: boolean;
  message?: string;
  code?: ChangePasswordErrorCode;
}

interface AuthContextValue {
  ready: boolean;
  user: AuthUser | null;
  status: AuthStatus;
  startupError: boolean;
  login: (params: LoginParams) => Promise<LoginResult>;
  changePassword: (params: ChangePasswordParams) => Promise<ChangePasswordResult>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  clearAuthCache: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const AUTH_USER_ENDPOINT = '/api/auth/user';
export const AUTH_USER_TIMEOUT_MS = 10_000;

const isDesktopRuntime = typeof window !== 'undefined' && Boolean(window.electronAPI);

// Clear expired auth cache including cookies and localStorage
// 清除过期的认证缓存，包括 Cookie 和 localStorage
function clearAuthCache(): void {
  if (typeof window === 'undefined') return;

  try {
    // Clear CSRF cookie
    clearCookie(CSRF_COOKIE_NAME);
    clearCookie(CSRF_COOKIE_NAME, '/');

    // Clear localStorage auth-related items
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.includes('auth') || key.includes('csrf') || key.includes('token'))) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key));
  } catch (error) {
    console.error('Failed to clear auth cache:', error);
  }
}

type CurrentUserResult =
  | { kind: 'authenticated'; user: AuthUser }
  | { kind: 'unauthenticated' }
  | { kind: 'unavailable' };

async function fetchCurrentUser(signal?: AbortSignal): Promise<CurrentUserResult> {
  try {
    const response = await fetch(AUTH_USER_ENDPOINT, {
      method: 'GET',
      credentials: 'include',
      signal,
    });

    if (response.status === 401 || response.status === 403) {
      return { kind: 'unauthenticated' };
    }
    if (!response.ok) {
      return { kind: 'unavailable' };
    }

    const data = (await response.json()) as {
      success: boolean;
      user?: AuthUser;
    };
    if (data.success && data.user) {
      return { kind: 'authenticated', user: data.user };
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      return { kind: 'unavailable' };
    }
    console.error('Failed to fetch current user:', error);
  }

  return { kind: 'unavailable' };
}

export const AuthProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('checking');
  const [ready, setReady] = useState(false);
  const [startupError, setStartupError] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (isDesktopRuntime) {
      setStatus('authenticated');
      setUser(null);
      setStartupError(false);
      setReady(true);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('checking');
    setStartupError(false);
    setReady(false);

    const timeoutId = globalThis.setTimeout(() => controller.abort(), AUTH_USER_TIMEOUT_MS);
    const result = await fetchCurrentUser(controller.signal);
    globalThis.clearTimeout(timeoutId);

    // A newer refresh or provider unmount owns the state now.
    if (abortRef.current !== controller) return;

    if (result.kind === 'authenticated') {
      setUser(result.user);
      setStatus('authenticated');
    } else if (result.kind === 'unauthenticated') {
      setUser(null);
      setStatus('unauthenticated');
    } else {
      setUser(null);
      setStatus('checking');
      setStartupError(true);
    }
    setReady(true);
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [refresh]);

  useEffect(() => {
    if (isDesktopRuntime || typeof WebSocket === 'undefined') return;
    const errorEmitter = ipcBridge.realtime?.error;
    if (!errorEmitter) return;
    return errorEmitter.on((event) => {
      if (event.code !== 'REALTIME_AUTH_MISSING' && event.code !== 'REALTIME_AUTH_EXPIRED') return;
      abortRef.current?.abort();
      setUser(null);
      setStatus('unauthenticated');
      setStartupError(false);
      setReady(true);
      clearAuthCache();
      if (!window.location.hash.includes('/login')) {
        window.location.hash = '/login';
      }
    });
  }, []);

  const login = useCallback(async ({ username, password, remember }: LoginParams): Promise<LoginResult> => {
    try {
      if (isDesktopRuntime) {
        setReady(true);
        return { success: true };
      }

      // Check CSRF token availability before login
      // If token is missing, clear cache and inform user
      const csrfTokenValid = hasValidCsrfToken();
      if (!csrfTokenValid) {
        console.warn('CSRF token missing or invalid, clearing cache');
        clearAuthCache();
        // Allow login to proceed anyway - server will set new token
      }

      // P1 安全修复：登录请求需要 CSRF Token / P1 Security fix: Login needs CSRF token
      // Backend route is /login; web-host's static-server explicitly proxies it.
      const response = await fetch('/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify(withCsrfToken({ username, password, remember })),
      });

      const data = (await response.json()) as {
        success: boolean;
        message?: string;
        user?: AuthUser;
      };

      if (!response.ok || !data.success || !data.user) {
        let code: LoginErrorCode = 'unknown';
        let message = data?.message ?? 'Login failed';
        let shouldClearCache = false;

        if (response.status === 401) {
          code = 'invalidCredentials';
        } else if (response.status === 403) {
          // CSRF validation failed - clear cache
          code = 'csrfError';
          message = 'Security token expired. Please try again.';
          shouldClearCache = true;
        } else if (response.status === 429) {
          code = 'tooManyAttempts';
        } else if (response.status >= 500) {
          code = 'serverError';
        } else if (!csrfTokenValid) {
          // If we knew CSRF was invalid and login failed, suggest cache clear
          code = 'csrfError';
          message = 'Login failed due to cached data. Please clear your browser cache and try again.';
          shouldClearCache = true;
        }

        // Clear cache on CSRF-related errors
        if (shouldClearCache) {
          clearAuthCache();
        }

        return {
          success: false,
          message,
          code,
          shouldClearCache,
        };
      }

      setUser(data.user);
      setStatus('authenticated');
      setReady(true);

      // Re-enable WebSocket reconnection after successful login (WebUI mode only)
      if (typeof window !== 'undefined' && (window as any).__websocketReconnect) {
        (window as any).__websocketReconnect();
      }
      if (typeof window !== 'undefined') {
        void import('@/common/adapter/httpBridge').then(({ reconnectRealtime }) => {
          reconnectRealtime();
        });
      }

      return { success: true };
    } catch (error) {
      console.error('Login request failed:', error);

      // Check if error is related to CSRF token parsing
      const errorMessage = (error as Error).message;
      if (errorMessage?.includes('parse') || errorMessage?.includes('csrf') || errorMessage?.includes('cookie')) {
        // CSRF or cookie parsing error - clear cache
        clearAuthCache();
        return {
          success: false,
          message: 'Login failed due to cached data. Please clear your browser cache and try again.',
          code: 'csrfError',
          shouldClearCache: true,
        };
      }

      return {
        success: false,
        message: 'Network error. Please try again.',
        code: 'networkError',
      };
    }
  }, []);

  const changePassword = useCallback(
    async ({
      username,
      currentPassword,
      newPassword,
      confirmPassword,
    }: ChangePasswordParams): Promise<ChangePasswordResult> => {
      if (isDesktopRuntime) {
        return { success: false, code: 'serverError' };
      }

      try {
        const response = await fetch('/api/auth/password', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify({
            username,
            current_password: currentPassword,
            new_password: newPassword,
            confirm_password: confirmPassword,
          }),
        });

        const data = (await response.json()) as {
          success?: boolean;
          code?: string;
          message?: string;
        };

        if (response.ok && data.success) {
          return { success: true };
        }

        const backendCodeMap: Record<string, ChangePasswordErrorCode> = {
          REQUIRED_FIELDS: 'requiredFields',
          PASSWORD_MISMATCH: 'passwordMismatch',
          INVALID_CURRENT_PASSWORD: 'invalidCurrentPassword',
          PASSWORD_POLICY: 'passwordPolicy',
          PASSWORD_REUSED: 'passwordReused',
          RATE_LIMITED: 'tooManyAttempts',
          ORIGIN_REJECTED: 'securityError',
        };
        let code: ChangePasswordErrorCode = backendCodeMap[data.code ?? ''] ?? 'unknown';
        if (response.status === 401) code = 'invalidCurrentPassword';
        if (response.status === 403) code = 'securityError';
        if (response.status === 429) code = 'tooManyAttempts';
        if (response.status >= 500) code = 'serverError';

        return { success: false, code, message: data.message };
      } catch (error) {
        console.error('Password change request failed:', error);
        return { success: false, code: 'networkError' };
      }
    },
    []
  );

  const logout = useCallback(async () => {
    if (isDesktopRuntime) {
      setUser(null);
      setStatus('authenticated');
      setReady(true);
      return;
    }

    const response = await fetch('/logout', {
      method: 'POST',
      // Logout also needs CSRF token / 登出同样需要 CSRF Token
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify(withCsrfToken({})),
    });
    if (!response.ok) {
      throw new Error(`Logout failed with status ${response.status}`);
    }

    setUser(null);
    setStatus('unauthenticated');
    // A full reload clears every user-scoped in-memory provider before another account can sign in.
    clearAuthCache();
    globalThis.location.reload();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ready,
      user,
      status,
      startupError,
      login,
      changePassword,
      logout,
      refresh,
      clearAuthCache,
    }),
    [changePassword, login, logout, ready, refresh, startupError, status, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

/** Optional access for components that are also rendered in isolated desktop tests/previews. */
export function useOptionalAuth(): AuthContextValue | undefined {
  return useContext(AuthContext);
}
