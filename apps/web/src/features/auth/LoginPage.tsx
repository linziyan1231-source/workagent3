import { MemoryRouter } from "react-router-dom";
import RendererLoginPage from "@renderer/pages/login";
import { WorkAgentAuthProvider } from "../../shared/aion-adapter/authContext.js";
import { ApiError } from "../../shared/api/http.js";
import { authPort } from "./authPort.js";

type Props = {
  onLogin: (username: string, password: string) => Promise<void>;
};

/** WorkAgent3 auth-port adapter around the original Renderer login page. */
export function LoginPage({ onLogin }: Props) {
  return (
    <WorkAgentAuthProvider
      changePassword={authPort.changePassword}
      login={async ({ username, password }) => {
        try {
          await onLogin(username, password);
          return { success: true };
        } catch (reason) {
          if (
            reason instanceof ApiError &&
            reason.code === "invalid_credentials"
          ) {
            return { success: false, code: "invalidCredentials" };
          }
          return { success: false, code: "networkError" };
        }
      }}
    >
      <MemoryRouter initialEntries={["/login"]}>
        <RendererLoginPage />
      </MemoryRouter>
    </WorkAgentAuthProvider>
  );
}
