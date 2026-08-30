import { createContext, useContext, type PropsWithChildren } from "react";

type LoginResult =
  | { success: true }
  | { success: false; code: "invalidCredentials" | "networkError" | "unknown"; message?: string };

type AuthAdapter = {
  status: "unauthenticated";
  login(input: { username: string; password: string; remember: boolean }): Promise<LoginResult>;
};

const AuthContext = createContext<AuthAdapter | null>(null);

export function WorkAgentAuthProvider({
  login,
  children,
}: PropsWithChildren<{ login: AuthAdapter["login"] }>) {
  return <AuthContext.Provider value={{ status: "unauthenticated", login }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("WorkAgentAuthProvider is missing");
  return value;
}
