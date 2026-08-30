import { useEffect } from "react";

export function OAuthCallbackPage() {
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    window.opener?.postMessage(
      {
        type: "workagent:mcp-oauth",
        code: query.get("code"),
        state: query.get("state"),
        error: query.get("error"),
      },
      window.location.origin,
    );
    window.close();
  }, []);

  return <div className="app-loading">Completing authorization…</div>;
}
