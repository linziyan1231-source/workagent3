import { createContext, useContext, type PropsWithChildren } from "react";

type LoginResult =
  | { success: true }
  | {
      success: false;
      code: "invalidCredentials" | "networkError" | "unknown";
      message?: string;
    };

type AuthAdapter = {
  ready: boolean;
  status: "unauthenticated" | "authenticated";
  startupError: boolean;
  user?: {
    id: number;
    username: string;
    display_name: string;
    collaboration_enabled: boolean;
    collaboration_capable: boolean;
    admin: boolean;
  };
  login(input: {
    username: string;
    password: string;
    remember: boolean;
  }): Promise<LoginResult>;
  changePassword(): Promise<{ success: false; code: "unknown" }>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
  clearAuthCache(): void;
};

const AuthContext = createContext<AuthAdapter | null>(null);

export function WorkAgentAuthProvider({
  login,
  logout = async () => undefined,
  refresh = async () => undefined,
  user,
  children,
}: PropsWithChildren<{
  login: AuthAdapter["login"];
  logout?: AuthAdapter["logout"];
  refresh?: AuthAdapter["refresh"];
  user?: AuthAdapter["user"];
}>) {
  return (
    <AuthContext.Provider
      value={{
        ready: true,
        status: user ? "authenticated" : "unauthenticated",
        startupError: false,
        user,
        login,
        changePassword: async () => ({ success: false, code: "unknown" }),
        logout,
        refresh,
        clearAuthCache: () => undefined,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("WorkAgentAuthProvider is missing");
  return value;
}

export function useOptionalAuth() {
  return useContext(AuthContext);
}
