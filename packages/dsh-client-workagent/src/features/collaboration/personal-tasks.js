import { request } from "../../platform/api.js";

export function sharedTaskProject(params) {
  return params.get("workagent") === "shared" &&
    params.get("personal") === "new" &&
    !params.has("session")
    ? params.get("project")
    : null;
}

export function personalTaskRoute(project, session) {
  return `/?workagent=shared&project=${encodeURIComponent(project)}&${session ? `session=${encodeURIComponent(session)}` : "personal=new"}`;
}

const endpoint = "/api/portal/shared-personal-tasks";
const creating = new Map();

// Keep the operation identity when a response is lost or the page is reloaded.
// Only the server creates, links or compensates the Runtime session.
export function createPersonalTask(project, options) {
  const configuration = JSON.stringify(options);
  const key = `workagent.personal-task.pending:${project.id}:${configuration}`;
  const activeKey = key;
  if (creating.has(activeKey)) return creating.get(activeKey);
  const run = (async () => {
    let pending;
    try {
      pending = JSON.parse(sessionStorage.getItem(key));
    } catch {}
    if (!pending || pending.configuration !== configuration)
      pending = { id: crypto.randomUUID(), configuration };
    sessionStorage.setItem(key, JSON.stringify(pending));
    let result = await request(endpoint, {
      method: "POST",
      body: JSON.stringify({
        operation_id: pending.id,
        project_id: project.id,
        options,
      }),
    });
    for (let attempt = 0; !result.session && attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      result = await request(
        `${endpoint}?id=${encodeURIComponent(result.operation.id)}`,
      );
    }
    if (!result.session)
      throw new Error("个人任务正在后台创建，请稍后在协作中查看");
    sessionStorage.removeItem(key);
    window.dispatchEvent(new CustomEvent("workagent:shared-changed"));
    return result.session;
  })()
    .catch((error) => {
      // A definitive terminal operation can be replaced by the next explicit
      // submit (for example after repairing its preset). Lost responses keep
      // their original identity and are always recovered first.
      if (error.status === 422 || error.status === 410)
        sessionStorage.removeItem(key);
      throw error;
    })
    .finally(() => creating.delete(activeKey));
  creating.set(activeKey, run);
  return run;
}

export async function deletePersonalTask(conversationId, send = request) {
  await send(endpoint, {
    method: "DELETE",
    body: JSON.stringify({ conversation_id: conversationId }),
  });
  window.dispatchEvent(new CustomEvent("workagent:shared-changed"));
}
