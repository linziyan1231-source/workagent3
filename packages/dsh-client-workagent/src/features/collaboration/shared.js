import { Dialog as Modal, ActionList, useConfirm } from "../../ui/dialog.js";
import {
  ConversationMenu,
  ConversationManagementDialog,
} from "../../ui/conversation-management.js";
import {
  SidebarAction,
  SidebarGroup,
  SidebarHeader,
  SidebarRow,
  SidebarSearch,
  SidebarStatus,
} from "../../ui/sidebar.js";
import { FileIconButton } from "../files/preview.js";
import {
  personalTaskRoute,
  deletePersonalTask as submitPersonalTaskDeletion,
} from "./personal-tasks.js";
import {
  bindComposerFiles,
  isComposerImage,
} from "../conversations/file-composer.js";

export function sortProjectsByChat(projects, conversations, pinned = []) {
  const latest = new Map();
  for (const conversation of conversations) {
    if (conversation.hidden || conversation.branchKind === "side_chat")
      continue;
    const projectId = conversation.workspaceId ?? conversation.project_id;
    const time = Date.parse(conversation.updatedAt ?? conversation.updated_at);
    if (time > (latest.get(projectId) ?? 0)) latest.set(projectId, time);
  }
  const time = (project) =>
    latest.get(project.id) ?? (Date.parse(project.createdAt) || 0);
  return projects
    .slice()
    .sort(
      (a, b) =>
        Number(pinned.includes(b.id)) - Number(pinned.includes(a.id)) ||
        time(b) - time(a),
    );
}

export function reconcileSharedMentions(before, after, mentions) {
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++;
  let end = before.length,
    nextEnd = after.length;
  while (
    end > start &&
    nextEnd > start &&
    before[end - 1] === after[nextEnd - 1]
  ) {
    end--;
    nextEnd--;
  }
  const delta = after.length - before.length;
  return mentions
    .flatMap((mention) =>
      mention.end <= start
        ? [mention]
        : mention.start >= end
          ? [
              {
                ...mention,
                start: mention.start + delta,
                end: mention.end + delta,
              },
            ]
          : [],
    )
    .filter(
      (mention) => after.slice(mention.start, mention.end) === mention.label,
    );
}

export function createShared({
  React,
  request,
  apiRoot,
  useResource,
  Button,
  Input,
  Markdown,
  friendlyError,
  navigation,
  Icon,
  EngineMark,
  SessionAvatar,
  createUploads,
  ComposerForm = "form",
  closeMobileSidebar,
  usePins,
  FileManager,
  SessionReminder,
  closeSidebar,
}) {
  const h = React.createElement,
    root = "/api/portal",
    enc = encodeURIComponent;
  const uid = () => crypto.randomUUID();
  const json = (body, method = "POST") => ({
    method,
    body: JSON.stringify(body),
  });
  async function sendDiscussion(input, conversation) {
    return request(
      `${root}/shared-messages`,
      json({ ...input, conversation_id: conversation.id }),
    );
  }

  const go = (path) =>
    navigation ? navigation.navigate(path) : location.assign(path);
  const useSearch = navigation ? navigation.useSearch : () => location.search;
  const route = (project, discussion) =>
    `/?workagent=shared${project ? `&project=${enc(project)}` : ""}${discussion ? `&discussion=${enc(discussion)}` : ""}`;
  const icon = (name, size = 18) => (Icon ? h(Icon, { name, size }) : null);
  const assistantAvatar = (backend, fallback) =>
    EngineMark ? h(EngineMark, { engine: backend || "harness" }) : fallback;
  const errorText = (error) =>
    ({
      shared_invite_already_pending: "邀请已经发出，正在等待对方接受。",
      shared_member_already_exists: "这位员工已经是项目成员。",
      invite_target_not_found: "无法邀请此账号，请搜索并选择可用员工。",
      shared_project_forbidden: "你已没有此项目的访问权限。",
      shared_project_not_found: "项目不存在，或你已不再是项目成员。",
      shared_project_busy: "项目正在准备或转移，请稍后重试。",
      shared_invite_expired: "邀请已过期，请联系负责人重新邀请。",
      shared_invite_link_revoked: "邀请链接已撤销。",
      shared_invite_link_exhausted: "邀请链接已被使用。",
      shared_invite_link_not_found: "邀请链接无效或已过期。",
      shared_run_busy: "助手正在处理，完成后可再次 @ 助手。",
      shared_assistant_locked:
        "助手身份不可更换，请邀请其他助手作为新成员加入。",
      shared_assistant_catalog_unavailable: "助手列表暂时不可用，请稍后重试。",
      invalid_shared_runtime: "请选择该助手当前支持的模型和思考强度。",
      shared_assistant_not_joined: "请先邀请该助手加入项目。",
      shared_assistant_unavailable: "这个助手不可用，请选择已启用的助手。",
      shared_context_too_large: "讨论超出助手上下文容量，请新建讨论后继续。",
      shared_context_unavailable: "消息已发送，但讨论上下文暂时无法读取。",
      shared_runtime_not_authorized: "所选模型尚未授权，请联系项目负责人调整。",
      shared_turn_unavailable: "助手暂时不可用。",
      shared_storage_exceeded: "共享空间不足，请联系管理员调整额度。",
      invalid_shared_mention: "提及对象已变化，请重新选择。",
      shared_project_conflict: "项目状态已变化，请刷新后重试。",
    })[error?.message || error] || friendlyError(error?.message || error);
  const fileRoot = (id) => `${root}/shared-workspaces/${enc(id)}`;
  const fileURL = (id, path, preview = false) =>
    `${fileRoot(id)}/content?path=${enc(path)}${preview ? "&preview=1" : ""}`;
  const uploads = createUploads?.({
    React,
    request,
    apiRoot,
    friendlyError: errorText,
    workspaceEndpoint: fileRoot,
  });
  let snapshot = {
      projects: [],
      invites: [],
      conversations: [],
      loading: true,
      error: "",
      revision: 0,
    },
    refreshing,
    stop;
  const subscribers = new Set();
  const refresh = () => {
    if (refreshing) return refreshing;
    refreshing = Promise.all([
      request(`${root}/shared-projects?include_hidden=true`),
      request(`${root}/shared-invites`),
      request(`${root}/shared-conversations?include_hidden=true`),
    ])
      .then(([p, i, c]) => {
        snapshot = {
          projects: p.projects || [],
          invites: i.invites || [],
          conversations: c.conversations || [],
          loading: false,
          error: "",
          revision: snapshot.revision + 1,
        };
      })
      .catch((error) => {
        snapshot = {
          ...snapshot,
          ...(error.status === 401
            ? { projects: [], invites: [], conversations: [] }
            : {}),
          loading: false,
          error: errorText(error),
        };
      })
      .finally(() => {
        refreshing = null;
        subscribers.forEach((fn) => fn());
      });
    return refreshing;
  };
  function subscribe(fn) {
    subscribers.add(fn);
    if (subscribers.size === 1) {
      void refresh();
      const events =
        typeof EventSource === "function"
          ? new EventSource(`${root}/shared-events`)
          : null;
      if (events) {
        events.onmessage = refresh;
        events.onopen = refresh;
        events.addEventListener?.("change", refresh);
      }
      const timer = setInterval(refresh, 5000);
      window.addEventListener("focus", refresh);
      window.addEventListener("workagent:shared-changed", refresh);
      stop = () => {
        clearInterval(timer);
        events?.close();
        window.removeEventListener("focus", refresh);
        window.removeEventListener("workagent:shared-changed", refresh);
      };
    }
    return () => {
      subscribers.delete(fn);
      if (!subscribers.size) stop?.();
    };
  }
  const useShared = () => React.useSyncExternalStore(subscribe, () => snapshot);
  async function mutate(path, body, method = "POST") {
    const value = await request(
      `${root}/${path}`,
      body === undefined ? { method } : json(body, method),
    );
    if (refreshing) await refreshing;
    await refresh();
    return value;
  }
  function PersonalTaskButton({ project, onClose }) {
    return h(
      Button,
      {
        className: "workagent-button workagent-personal-task-entry",
        "aria-label": "新建个人任务",
        onClick: () => {
          onClose();
          closeSidebar?.();
          go(personalTaskRoute(project.id));
        },
      },
      icon("workspace", 20),
      h(
        "span",
        null,
        h("strong", null, "个人任务"),
        h("small", null, "仅自己可见 · 在项目共享文件夹中运行"),
      ),
      icon("chevronRight", 18),
    );
  }
  async function deletePersonalTask(row) {
    await submitPersonalTaskDeletion(row.id, request);
    await refresh();
  }
  async function openProject(projectId, discussionId) {
    const selected =
      discussionId ||
      snapshot.conversations.find(
        (row) =>
          row.project_id === projectId &&
          !row.hidden &&
          row.kind !== "personal_task",
      )?.id;
    const discussion =
      selected ||
      (await mutate(`shared-projects/${enc(projectId)}/discussion`, {}))
        .conversation.id;
    go(route(projectId, discussion));
  }
  const Feedback = ({ error, notice }) =>
    h(
      React.Fragment,
      null,
      error
        ? h(
            "p",
            { role: "alert", className: "workagent-collab-feedback is-error" },
            error,
          )
        : null,
      notice
        ? h(
            "p",
            { role: "status", className: "workagent-collab-feedback" },
            notice,
          )
        : null,
    );
  function useMembers(project, revision) {
    const [members, setMembers] = React.useState([]);
    React.useEffect(() => {
      if (!project) {
        setMembers([]);
        return;
      }
      const abort = new AbortController();
      request(`${root}/shared-projects/${enc(project.id)}/members`, {
        signal: abort.signal,
      })
        .then((value) => {
          if (!abort.signal.aborted) setMembers(value.members);
        })
        .catch((error) => {
          if (!abort.signal.aborted && [403, 404].includes(error.status)) {
            setMembers([]);
            void refresh();
          }
        });
      return () => abort.abort();
    }, [project?.id, revision]);
    return members;
  }
  function MoreMenu({ children }) {
    const ref = React.useRef(null);
    React.useEffect(() => {
      const close = (event) => {
        if (event.type === "keydown" && event.key !== "Escape") return;
        if (event.type === "pointerdown" && ref.current.contains(event.target))
          return;
        if (ref.current.open) {
          ref.current.open = false;
          if (event.type === "keydown")
            ref.current.querySelector("summary").focus();
        }
      };
      document.addEventListener("pointerdown", close);
      document.addEventListener("keydown", close);
      return () => {
        document.removeEventListener("pointerdown", close);
        document.removeEventListener("keydown", close);
      };
    }, []);
    return h(
      "details",
      { className: "workagent-collab-more", ref },
      h("summary", { "aria-label": "项目更多操作" }, icon("more", 16)),
      h(
        "div",
        {
          className: "workagent-collab-menu-popover",
          onClick: (event) => {
            if (event.target.closest("button")) ref.current.open = false;
          },
        },
        children,
      ),
    );
  }
  function UserSearch({ onSelect, selected = [] }) {
    const [query, setQuery] = React.useState(""),
      [results, setResults] = React.useState([]),
      [error, setError] = React.useState("");
    React.useEffect(() => {
      setResults([]);
      if (!query.trim()) return;
      const abort = new AbortController();
      const timer = setTimeout(
        () =>
          request(`${root}/shared-users?q=${enc(query.trim())}`, {
            signal: abort.signal,
          })
            .then((value) => {
              if (!abort.signal.aborted) {
                setResults(value.users);
                setError("");
              }
            })
            .catch((error) => {
              if (!abort.signal.aborted) setError(errorText(error));
            }),
        250,
      );
      return () => {
        clearTimeout(timer);
        abort.abort();
      };
    }, [query]);
    return h(
      "div",
      { className: "workagent-collab-search" },
      h(Input, {
        "aria-label": "搜索员工",
        placeholder: "搜索姓名或用户名",
        value: query,
        onChange: (event) => setQuery(event.target.value),
      }),
      query
        ? h(
            "div",
            { className: "workagent-collab-search-results" },
            ...results
              .filter((user) => !selected.some((item) => item.id === user.id))
              .map((user) =>
                h(
                  Button,
                  {
                    key: user.id,
                    onClick: () => {
                      onSelect(user);
                      setQuery("");
                    },
                  },
                  user.display_name || user.username,
                  h("small", null, ` @${user.username}`),
                ),
              ),
          )
        : null,
      h(Feedback, { error }),
    );
  }
  function CreateProject({ onClose, onCreated }) {
    const [name, setName] = React.useState(""),
      [invitees, setInvitees] = React.useState([]);
    const [busy, setBusy] = React.useState(false),
      [error, setError] = React.useState("");
    const operation = React.useRef(uid()),
      created = React.useRef(null);
    async function create(event) {
      event.preventDefault();
      if (busy || !name.trim()) return;
      setBusy(true);
      setError("");
      try {
        const value =
          created.current ||
          (await mutate("shared-projects", {
            name: name.trim(),
            operation_id: operation.current,
          }));
        created.current = value;
        const failed = [];
        for (const user of invitees) {
          try {
            await mutate(`shared-projects/${enc(value.project.id)}/invites`, {
              targetUsername: user.username,
              expiresInHours: 72,
            });
          } catch (error) {
            if (
              ![
                "shared_invite_already_pending",
                "shared_member_already_exists",
              ].includes(error.message)
            )
              failed.push(
                `${user.display_name || user.username}：${errorText(error)}`,
              );
          }
        }
        sessionStorage.setItem(
          `workagent.shared.notice.${value.project.id}`,
          failed.length
            ? `项目已创建，以下邀请未发送：${failed.join("；")}。可在成员中重试。`
            : invitees.length
              ? "项目已创建，邀请已发送，等待同事接受。"
              : "项目已创建，可以开始讨论或邀请同事。",
        );
        await refresh();
        onCreated
          ? await onCreated(value)
          : go(route(value.project.id, value.conversation.id));
        onClose();
      } catch (error) {
        setError(
          `${created.current ? "项目已创建，后续操作未完成，可重试。" : ""}${errorText(error)}`,
        );
      } finally {
        setBusy(false);
      }
    }
    return h(
      Modal,
      {
        title: "新建协作项目",
        onClose: () => {
          if (!busy) onClose();
        },
      },
      h(
        "form",
        { onSubmit: create, className: "workagent-collab-form" },
        h(
          "label",
          null,
          "项目名称",
          h(Input, {
            "aria-label": "共享项目名称",
            value: name,
            disabled: !!created.current,
            required: true,
            maxLength: 120,
            placeholder: "例如：秋季产品发布",
            onChange: (event) => setName(event.target.value),
          }),
        ),
        h("label", null, "邀请同事 · 可稍后添加"),
        h(UserSearch, {
          selected: invitees,
          onSelect: (user) => setInvitees((rows) => [...rows, user]),
        }),
        h(
          "div",
          { className: "workagent-collab-chips" },
          ...invitees.map((user) =>
            h(
              Button,
              {
                key: user.id,
                onClick: () =>
                  setInvitees((rows) =>
                    rows.filter((row) => row.id !== user.id),
                  ),
              },
              user.display_name || user.username,
              " ×",
            ),
          ),
        ),
        h(Feedback, { error }),
        h(
          "footer",
          null,
          h(Button, { onClick: onClose, disabled: busy }, "取消"),
          h(
            Button,
            {
              type: "submit",
              className: "workagent-button is-primary",
              disabled: busy || !name.trim(),
            },
            busy ? "正在创建…" : created.current ? "继续完成" : "创建项目",
          ),
        ),
      ),
    );
  }
  function Invitations({ onClose }) {
    const state = useShared(),
      params = new URLSearchParams(useSearch()),
      token = params.get("token");
    const [busy, setBusy] = React.useState(""),
      [error, setError] = React.useState("");
    const pending = state.invites.filter((row) => row.status === "pending");
    async function act(invite, accept) {
      setBusy(invite?.id || "link");
      setError("");
      try {
        const value =
          token && !invite
            ? await mutate("shared-invite-links/accept", { token })
            : await mutate(
                `shared-invites/${enc(invite.id)}/${accept ? "accept" : "decline"}`,
                {},
              );
        if (accept) {
          onClose();
          await openProject(value.project.id);
        }
      } catch (error) {
        setError(errorText(error));
      } finally {
        setBusy("");
      }
    }
    return h(
      Modal,
      { title: "项目邀请", onClose },
      h(
        "div",
        { className: "workagent-collab-form" },
        h(Feedback, { error }),
        token
          ? h(
              "div",
              null,
              h("p", null, "接受后，你将加入此共享项目并看到项目文件和讨论。"),
              h(
                Button,
                { disabled: !!busy, onClick: () => act(null, true) },
                busy ? "正在加入…" : "接受邀请",
              ),
            )
          : null,
        ...pending.map((invite) =>
          h(
            "article",
            { key: invite.id, className: "workagent-collab-invite" },
            h(
              "div",
              null,
              h("strong", null, invite.projectName),
              h("p", null, `${invite.inviterName} 邀请你加入`),
              h(
                "small",
                null,
                `有效期至 ${new Date(invite.expiresAt).toLocaleString()}`,
              ),
            ),
            h(
              "div",
              { className: "workagent-collab-actions" },
              h(
                Button,
                { disabled: !!busy, onClick: () => act(invite, false) },
                "拒绝",
              ),
              h(
                Button,
                {
                  disabled: !!busy,
                  className: "workagent-button is-primary",
                  onClick: () => act(invite, true),
                },
                busy === invite.id ? "处理中…" : "接受",
              ),
            ),
          ),
        ),
        !pending.length && !token
          ? h(
              "p",
              { className: "workagent-collab-empty" },
              "暂时没有待处理的邀请。",
            )
          : null,
      ),
    );
  }
  function useAssistantMembers(project, revision) {
    const [state, setState] = React.useState({
      members: [],
      options: [],
      error: "",
    });
    React.useEffect(() => {
      const abort = new AbortController();
      Promise.all([
        request(`${root}/shared-projects/${enc(project.id)}/assistants`, {
          signal: abort.signal,
        }),
        project.currentRole === "owner"
          ? request(
              `${root}/shared-projects/${enc(project.id)}/assistant-options`,
              { signal: abort.signal },
            ).catch((error) => ({ assistants: [], error: errorText(error) }))
          : Promise.resolve({ assistants: [] }),
      ])
        .then(([members, options]) => {
          if (!abort.signal.aborted)
            setState({
              members: members.assistants,
              options: options.assistants,
              error: options.error || "",
            });
        })
        .catch((error) => {
          if (!abort.signal.aborted)
            setState((value) => ({ ...value, error: errorText(error) }));
        });
      return () => abort.abort();
    }, [project.id, project.currentRole, revision]);
    return state;
  }
  function AssistantMembers({ project, revision }) {
    const state = useAssistantMembers(project, revision);
    const [selected, setSelected] = React.useState(""),
      [busy, setBusy] = React.useState(false),
      [notice, setNotice] = React.useState(""),
      [error, setError] = React.useState("");
    const available = state.options.filter(
      (row) => !state.members.some((member) => member.assistant_id === row.id),
    );
    async function perform(action, notice) {
      if (busy) return;
      setBusy(true);
      setError("");
      try {
        await action();
        setNotice(notice);
        setSelected("");
      } catch (error) {
        setError(errorText(error));
      } finally {
        setBusy(false);
      }
    }
    return h(
      "section",
      { "aria-label": "助手成员", className: "workagent-collab-form" },
      h("strong", null, "助手成员"),
      project.currentRole === "owner"
        ? h(
            "div",
            { className: "workagent-collab-actions" },
            h(
              "select",
              {
                "aria-label": "邀请助手",
                className: "workagent-control",
                value: selected,
                onChange: (event) => setSelected(event.target.value),
              },
              h("option", { value: "" }, "选择要邀请的助手"),
              ...available.map((row) =>
                h("option", { key: row.id, value: row.id }, row.name),
              ),
            ),
            h(
              Button,
              {
                disabled: busy || !selected,
                onClick: () =>
                  perform(
                    () =>
                      mutate(
                        `shared-projects/${enc(project.id)}/assistant-invites`,
                        { assistant_id: selected },
                      ),
                    "助手已接受邀请并加入项目。",
                  ),
              },
              "发送助手邀请",
            ),
          )
        : null,
      h(Feedback, { error: error || state.error, notice }),
      ...state.members.map((member) =>
        h(
          "div",
          { key: member.assistant_id, className: "workagent-collab-member" },
          h(
            "span",
            { className: "workagent-collab-avatar", "aria-hidden": true },
            assistantAvatar(member.assistant_backend, icon("assistant")),
          ),
          h(
            "div",
            null,
            h("strong", null, member.name),
            h("small", null, `${member.assistant_backend} · 已加入`),
          ),
          project.currentRole === "owner"
            ? h(
                Button,
                {
                  disabled: busy || member.running,
                  "aria-label": `移除助手 ${member.name}`,
                  onClick: () =>
                    perform(
                      () =>
                        mutate(
                          `shared-projects/${enc(project.id)}/assistants/${enc(member.assistant_id)}`,
                          undefined,
                          "DELETE",
                        ),
                      "助手已移出，历史讨论保留。",
                    ),
                },
                "移除",
              )
            : null,
        ),
      ),
      !state.members.length
        ? h("p", null, "邀请助手加入后，成员才能 @ 它。")
        : null,
    );
  }
  function AssistantSettingsRow({ project, member, options }) {
    const [model, setModel] = React.useState(member.model_id),
      [effort, setEffort] = React.useState(member.thinking_effort),
      [busy, setBusy] = React.useState(false),
      [error, setError] = React.useState(""),
      [notice, setNotice] = React.useState("");
    React.useEffect(() => {
      setModel(member.model_id);
      setEffort(member.thinking_effort);
    }, [member.model_id, member.thinking_effort]);
    const choices = [
      ...new Map(
        options
          .filter((row) => row.engine === member.assistant_backend)
          .flatMap((row) => row.models)
          .map((row) => [row.id, row]),
      ).values(),
    ];
    if (!choices.some((row) => row.id === member.model_id))
      choices.unshift({ id: member.model_id, name: member.model_id });
    const selectedModel = choices.find((row) => row.id === model);
    const levels = selectedModel?.reasoning?.length
      ? selectedModel.reasoning
      : [{ id: "off", name: "关闭" }];
    const levelLabels = {
      off: "关闭",
      on: "开启",
      low: "低",
      medium: "中",
      high: "高",
      xhigh: "更高",
      max: "最高",
      minimal: "最低",
    };
    React.useEffect(() => {
      if (selectedModel?.reasoning && !levels.some((row) => row.id === effort))
        setEffort(selectedModel.defaultReasoning || levels[0].id);
    }, [
      model,
      selectedModel?.defaultReasoning,
      JSON.stringify(selectedModel?.reasoning),
    ]);
    return h(
      "form",
      {
        className: "workagent-collab-form",
        "aria-label": `${member.name} 的设置`,
        onSubmit: async (event) => {
          event.preventDefault();
          if (busy || member.running) return;
          setBusy(true);
          setError("");
          setNotice("");
          try {
            await mutate(
              `shared-projects/${enc(project.id)}/assistants/${enc(member.assistant_id)}`,
              { model_id: model, thinking_effort: effort },
              "PATCH",
            );
            setNotice("已保存，下次 @ 时生效。");
          } catch (error) {
            setError(errorText(error));
          } finally {
            setBusy(false);
          }
        },
      },
      h(
        "div",
        null,
        h("strong", null, member.name),
        h("small", null, ` · ${member.assistant_backend}`),
      ),
      h(
        "label",
        null,
        "模型",
        h(
          "select",
          {
            "aria-label": `${member.name} 模型`,
            className: "workagent-control",
            value: model,
            disabled: busy || member.running,
            onChange: (event) => setModel(event.target.value),
          },
          ...choices.map((row) =>
            h("option", { key: row.id, value: row.id }, row.name),
          ),
        ),
      ),
      h(
        "label",
        null,
        "思考强度",
        h(
          "select",
          {
            "aria-label": `${member.name} 思考强度`,
            className: "workagent-control",
            value: effort,
            disabled: busy || member.running,
            onChange: (event) => setEffort(event.target.value),
          },
          ...levels.map(({ id, name }) =>
            h("option", { key: id, value: id }, levelLabels[id] || name),
          ),
        ),
      ),
      member.running ? h("p", null, "助手正在执行，结束后可调整设置。") : null,
      h(Feedback, { error, notice }),
      h(
        Button,
        {
          type: "submit",
          className: "workagent-button is-primary",
          disabled: busy || member.running,
        },
        busy ? "保存中…" : "保存",
      ),
    );
  }
  function AssistantSettings({ project, revision, onClose }) {
    const state = useAssistantMembers(project, revision);
    return h(
      Modal,
      { title: "助手设置", onClose },
      h(
        "div",
        { className: "workagent-collab-form" },
        h("p", null, "分别调整群内助手的模型和思考强度，已有会话继续保留。"),
        h(Feedback, { error: state.error }),
        ...state.members.map((member) =>
          h(AssistantSettingsRow, {
            key: member.assistant_id,
            project,
            member,
            options: state.options,
          }),
        ),
        !state.members.length
          ? h("p", null, "请先在项目成员中邀请助手加入。")
          : null,
      ),
    );
  }
  function Members({ project, members, revision, onClose }) {
    const { confirm, confirmation } = useConfirm();
    const [outgoing, setOutgoing] = React.useState([]),
      [selected, setSelected] = React.useState(null),
      [busy, setBusy] = React.useState(false);
    const [notice, setNotice] = React.useState(""),
      [error, setError] = React.useState(""),
      [link, setLink] = React.useState(null);
    const owner = project.currentRole === "owner";
    React.useEffect(() => {
      if (!owner) return;
      const abort = new AbortController();
      request(`${root}/shared-projects/${enc(project.id)}/invites`, {
        signal: abort.signal,
      })
        .then((value) => {
          if (!abort.signal.aborted) setOutgoing(value.invites);
        })
        .catch((error) => {
          if (!abort.signal.aborted) setError(errorText(error));
        });
      return () => abort.abort();
    }, [project.id, owner, revision]);
    async function perform(fn, success) {
      if (busy) return;
      setBusy(true);
      setError("");
      setNotice("");
      try {
        await fn();
        setNotice(success);
      } catch (error) {
        setError(errorText(error));
      } finally {
        setBusy(false);
      }
    }
    const statuses = {
      pending: "等待接受",
      accepting: "正在加入",
      accepted: "已加入",
      declined: "已拒绝",
      expired: "已过期",
      revoked: "已撤销",
    };
    return h(
      Modal,
      { title: "项目成员", onClose },
      confirmation,
      h(
        "div",
        { className: "workagent-collab-form" },
        owner
          ? h(
              React.Fragment,
              null,
              h(UserSearch, { onSelect: setSelected }),
              selected
                ? h(
                    "div",
                    { className: "workagent-collab-actions" },
                    h("span", null, selected.display_name || selected.username),
                    h(
                      Button,
                      {
                        disabled: busy,
                        className: "workagent-button is-primary",
                        onClick: () =>
                          perform(
                            async () => {
                              await mutate(
                                `shared-projects/${enc(project.id)}/invites`,
                                {
                                  targetUsername: selected.username,
                                  expiresInHours: 72,
                                },
                              );
                              setSelected(null);
                            },
                            `已邀请${selected.display_name || selected.username}，等待接受。`,
                          ),
                      },
                      "发送邀请",
                    ),
                  )
                : null,
              h(
                Button,
                {
                  disabled: busy,
                  onClick: () =>
                    perform(async () => {
                      const value =
                        link ||
                        (
                          await mutate(
                            `shared-projects/${enc(project.id)}/invite-links`,
                            { expiresInHours: 72, singleUse: true },
                          )
                        ).link;
                      setLink(value);
                      const url = `${location.origin}/?frontend=dsh&workagent=shared&token=${enc(value.token)}`;
                      if (navigator.clipboard?.writeText)
                        await navigator.clipboard.writeText(url);
                      else {
                        const field = document.createElement("textarea");
                        field.value = url;
                        document.body.append(field);
                        field.select();
                        const copied = document.execCommand("copy");
                        field.remove();
                        if (!copied) throw new Error("请复制下方邀请链接。");
                      }
                    }, "邀请链接已复制，72 小时内有效，仅可使用一次。"),
                },
                "复制邀请链接",
              ),
              link
                ? h(
                    "div",
                    { className: "workagent-collab-link" },
                    h(Input, {
                      "aria-label": "邀请链接",
                      readOnly: true,
                      value: `${location.origin}/?frontend=dsh&workagent=shared&token=${enc(link.token)}`,
                      onFocus: (event) => event.target.select(),
                    }),
                    h(
                      Button,
                      {
                        disabled: busy,
                        onClick: () =>
                          perform(async () => {
                            await mutate(
                              `shared-projects/${enc(project.id)}/invite-links/${enc(link.token)}`,
                              undefined,
                              "DELETE",
                            );
                            setLink(null);
                          }, "邀请链接已撤销。"),
                      },
                      "撤销链接",
                    ),
                  )
                : null,
            )
          : null,
        h(Feedback, { notice, error }),
        h(AssistantMembers, { project, revision }),
        h(
          "div",
          { className: "workagent-collab-member-list" },
          ...members.map((member) =>
            h(
              "div",
              { key: member.userId, className: "workagent-collab-member" },
              h(
                "span",
                { className: "workagent-collab-avatar", "aria-hidden": true },
                Array.from(
                  (member.displayName || member.username || "员").trim(),
                )[0].toLocaleUpperCase(),
              ),
              h(
                "div",
                null,
                h("strong", null, member.displayName || member.username),
                h("small", null, member.role === "owner" ? "负责人" : "成员"),
              ),
              owner && member.role !== "owner"
                ? h(
                    "details",
                    { className: "workagent-collab-member-menu" },
                    h(
                      "summary",
                      {
                        "aria-label": `管理${member.displayName || member.username}`,
                      },
                      icon("more", 15),
                    ),
                    h(
                      Button,
                      {
                        disabled: busy,
                        onClick: async () => {
                          if (
                            await confirm(
                              `移除${member.displayName || member.username}？对方将无法继续访问项目。`,
                            )
                          )
                            void perform(
                              () =>
                                mutate(
                                  `shared-projects/${enc(project.id)}/members/${member.userId}`,
                                  undefined,
                                  "DELETE",
                                ),
                              "成员已移除。",
                            );
                        },
                      },
                      "移除成员",
                    ),
                    h(
                      Button,
                      {
                        disabled: busy,
                        onClick: async () => {
                          if (
                            await confirm(
                              `将项目转交给${member.displayName || member.username}？`,
                            )
                          )
                            void perform(
                              () =>
                                mutate(
                                  `shared-projects/${enc(project.id)}/ownership`,
                                  { targetUserId: member.userId },
                                ),
                              "项目负责人已更新。",
                            );
                        },
                      },
                      "转移所有权",
                    ),
                  )
                : null,
            ),
          ),
        ),
        owner && outgoing.length
          ? h(
              "section",
              null,
              h("h3", null, "邀请记录"),
              ...outgoing.map((invite) =>
                h(
                  "div",
                  { key: invite.id, className: "workagent-collab-invite-row" },
                  h("span", null, invite.displayName || invite.username),
                  h("small", null, statuses[invite.status] || invite.status),
                  invite.status === "pending"
                    ? h(
                        Button,
                        {
                          disabled: busy,
                          onClick: () =>
                            perform(
                              () =>
                                mutate(
                                  `shared-invites/${enc(invite.id)}`,
                                  undefined,
                                  "DELETE",
                                ),
                              "邀请已撤销。",
                            ),
                        },
                        "撤销",
                      )
                    : null,
                ),
              ),
            )
          : null,
      ),
    );
  }
  function Composer({
    conversation,
    members = [],
    initial = "",
    onSend,
    projectId,
  }) {
    const [body, setBody] = React.useState(initial),
      [mentions, setMentions] = React.useState([]),
      [caret, setCaret] = React.useState(initial.length),
      [choice, setChoice] = React.useState(0);
    const [busy, setBusy] = React.useState(false),
      [uploading, setUploading] = React.useState(false),
      [attachments, setAttachments] = React.useState([]),
      [error, setError] = React.useState(""),
      [notice, setNotice] = React.useState("");
    const messageID = React.useRef(null),
      textarea = React.useRef(null);
    React.useLayoutEffect(() => {
      const input = textarea.current;
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
    }, [body]);
    const uploadControl = React.useRef(null);
    React.useEffect(() => () => uploadControl.current?.abort(), []);
    async function upload(files) {
      if (
        !uploads ||
        !projectId ||
        busy ||
        uploadControl.current ||
        !files.length
      )
        return;
      const controller = new AbortController();
      uploadControl.current = controller;
      setUploading(true);
      setError("");
      try {
        const result = await uploads.uploadFiles(projectId, files, {
          signal: controller.signal,
          destination: (file) => ({
            path: `附件/${file.name}`,
            conflict: "rename",
          }),
          onUploaded: (path) => {
            if (controller.signal.aborted) return;
            setAttachments((rows) => [...new Set([...rows, path])]);
            messageID.current = null;
          },
        });
        if (!controller.signal.aborted) setError(result.failures.join("；"));
      } catch (error) {
        if (!controller.signal.aborted) setError(errorText(error));
      } finally {
        uploadControl.current = null;
        if (!controller.signal.aborted) setUploading(false);
      }
    }
    React.useEffect(
      () =>
        bindComposerFiles(
          textarea.current,
          upload,
          busy || uploading || !projectId,
        ),
      [busy, uploading, projectId],
    );
    const query = body.slice(0, caret).match(/(^|\s)@([^\s@]*)$/u);
    const agents = conversation?.assistants || [];
    const candidates = query
      ? [
          ...agents.map((row) => ({
            kind: "assistant",
            id: row.assistant_id,
            name: row.name,
            detail: `${row.assistant_backend} · 助手成员`,
          })),
          ...members.map((member) => ({
            kind: "member",
            id: String(member.userId),
            name: member.displayName || member.username,
            detail: "项目成员",
          })),
        ].filter((row) =>
          `${row.name} ${row.detail}`
            .toLowerCase()
            .includes(query[2].toLowerCase()),
        )
      : [];
    function select(candidate) {
      const start = caret - query[2].length - 1,
        label = `@${candidate.name}`,
        next = body.slice(0, start) + label + " " + body.slice(caret);
      setMentions([
        ...reconcileSharedMentions(body, next, mentions),
        {
          kind: candidate.kind,
          id: candidate.id,
          label,
          start,
          end: start + label.length,
        },
      ]);
      setBody(next);
      setCaret(start + label.length + 1);
      messageID.current = null;
      queueMicrotask(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(
          start + label.length + 1,
          start + label.length + 1,
        );
      });
    }
    async function send(event) {
      event.preventDefault();
      if (!body.trim() || busy || uploading) return;
      setBusy(true);
      setError("");
      setNotice("");
      messageID.current ||= uid();
      try {
        const selected = mentions
          .filter((row) => body.slice(row.start, row.end) === row.label)
          .map(({ kind, id }) => ({ kind, id }));
        const agentIDs = [
          ...new Set(
            selected
              .filter((row) => row.kind === "assistant")
              .map((row) => row.id),
          ),
        ];
        if (
          agentIDs.some(
            (id) => !agents.some((agent) => agent.assistant_id === id),
          )
        )
          throw new Error("请先邀请这个助手加入项目，再 @ 它。");
        const value = await onSend({
          body,
          mentions: selected,
          attachments,
          client_message_id: messageID.current,
        });
        setBody("");
        setMentions([]);
        setAttachments([]);
        setCaret(0);
        messageID.current = null;
        const declined =
          value?.assistants?.filter((row) => row.status !== "started") || [];
        if (declined.length)
          setNotice(
            `消息已发送。${declined.map((row) => `${agents.find((agent) => agent.assistant_id === row.assistant_id)?.name || "助手"}：${errorText(row.reason)}`).join("；")}`,
          );
        else if (["busy", "blocked"].includes(value?.ai_status))
          setNotice(
            `消息已发送。${errorText(value.ai_reason || "shared_turn_unavailable")}`,
          );
        else if (value?.ai_status === "already_sent")
          setNotice("消息已发送，没有重复发送或启动助手。");
      } catch (error) {
        setError(errorText(error));
      } finally {
        setBusy(false);
      }
    }
    return h(
      ComposerForm,
      {
        className: "workagent-conversation-composer workagent-collab-composer",
        onSubmit: send,
        ...(ComposerForm !== "form" ? { showSettings: false } : {}),
      },
      h(Feedback, { error, notice }),
      h(
        React.Fragment,
        null,
        candidates.length
          ? h(
              "div",
              {
                role: "listbox",
                "aria-label": "提及对象",
                className: "workagent-collab-mentions",
              },
              ...candidates.map((candidate, index) =>
                h(
                  "button",
                  {
                    key: `${candidate.kind}:${candidate.id}`,
                    type: "button",
                    role: "option",
                    "aria-selected": index === choice,
                    className: index === choice ? "is-active" : "",
                    onMouseDown: (event) => event.preventDefault(),
                    onClick: () => select(candidate),
                  },
                  h("strong", null, candidate.name),
                  h(
                    "small",
                    null,
                    candidate.kind === "assistant"
                      ? "仅本条消息请助手参与"
                      : "提醒这位同事",
                  ),
                ),
              ),
            )
          : null,
        attachments.length
          ? h(
              "div",
              { className: "workagent-composer-attachments" },
              ...attachments.map((path) =>
                h(
                  "span",
                  {
                    key: path,
                    className: `workagent-file-reference${isComposerImage(path) ? " workagent-image-reference" : ""}`,
                  },
                  h(
                    "a",
                    {
                      href: fileURL(projectId, path, true),
                      target: "_blank",
                      rel: "noopener",
                      "aria-label": `预览 ${path.split("/").at(-1)}`,
                    },
                    isComposerImage(path)
                      ? h("img", {
                          src: fileURL(projectId, path, true),
                          alt: path.split("/").at(-1),
                          draggable: false,
                        })
                      : path.split("/").at(-1),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      disabled: busy,
                      "aria-label": `移除附件 ${path.split("/").at(-1)}`,
                      onClick: () => {
                        setAttachments((rows) =>
                          rows.filter((row) => row !== path),
                        );
                        messageID.current = null;
                      },
                    },
                    "×",
                  ),
                ),
              ),
            )
          : null,
        h("textarea", {
          ref: textarea,
          "aria-label": "共享消息",
          value: body,
          disabled: busy,
          rows: 1,
          maxLength: 100000,
          placeholder: "输入消息，@ 提及成员或 Agent…",
          onChange: (event) => {
            setMentions(
              reconcileSharedMentions(body, event.target.value, mentions),
            );
            setBody(event.target.value);
            setCaret(event.target.selectionStart);
            setChoice(0);
            messageID.current = null;
          },
          onSelect: (event) => setCaret(event.target.selectionStart),
          onPaste: (event) => {
            if (event.clipboardData?.files.length) return;
            const { selectionStart: start, selectionEnd: end } = event.target;
            setMentions((rows) =>
              rows.filter((row) => row.end <= start || row.start >= end),
            );
            messageID.current = null;
          },
          onKeyDown: (event) => {
            if (event.nativeEvent?.isComposing || event.isComposing) return;
            if (
              candidates.length &&
              ["ArrowUp", "ArrowDown", "Enter", "Tab"].includes(event.key)
            ) {
              event.preventDefault();
              if (event.key === "ArrowUp" || event.key === "ArrowDown")
                setChoice(
                  (value) =>
                    (value +
                      (event.key === "ArrowUp" ? -1 : 1) +
                      candidates.length) %
                    candidates.length,
                );
              else select(candidates[Math.min(choice, candidates.length - 1)]);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) void send(event);
          },
        }),
        h(
          "div",
          {
            className:
              "workagent-conversation-composer-bar workagent-collab-composer-bar",
          },
          projectId && uploads
            ? h(
                "label",
                { className: "workagent-collab-attach", title: "添加附件" },
                icon("plus", 20),
                h("input", {
                  type: "file",
                  multiple: true,
                  "aria-label": "添加共享附件",
                  disabled: busy || uploading,
                  onChange: async (event) => {
                    const files = [...event.target.files];
                    event.target.value = "";
                    void upload(files);
                  },
                }),
              )
            : null,
          h(
            "small",
            null,
            uploading
              ? "正在上传…"
              : conversation?.assistant_id
                ? "只有 @ 助手才会执行"
                : "与项目成员讨论",
          ),
          h(
            "button",
            {
              type: "submit",
              className: "workagent-composer-send",
              "aria-label": "发送消息",
              disabled: busy || uploading || !body.trim(),
            },
            icon("send"),
          ),
        ),
      ),
    );
  }
  function Chat({ conversation, project, members, revision }) {
    const [messages, setMessages] = React.useState([]),
      [error, setError] = React.useState(""),
      [local, setLocal] = React.useState(0);
    const targetMessage = new URLSearchParams(useSearch()).get("message"),
      located = React.useRef("");
    const list = React.useRef(null),
      bottom = React.useRef(true);
    React.useEffect(() => {
      const abort = new AbortController();
      (async () => {
        const rows = [];
        let after = 0;
        for (;;) {
          const value = await request(
            `${root}/shared-messages?conversation_id=${enc(conversation.id)}&after=${after}&limit=200`,
            { signal: abort.signal },
          );
          rows.push(...value.messages);
          if (value.messages.length < 200) break;
          after = value.messages.at(-1).seq;
        }
        if (!abort.signal.aborted) {
          setMessages(rows);
          setError("");
        }
      })().catch((error) => {
        if (!abort.signal.aborted) {
          setError(errorText(error));
          if ([403, 404].includes(error.status)) {
            setMessages([]);
            void refresh();
          }
        }
      });
      return () => abort.abort();
    }, [conversation.id, revision, local]);
    React.useLayoutEffect(() => {
      const key = `${conversation.id}:${targetMessage}`;
      if (targetMessage && located.current !== key && list.current) {
        const target = [
          ...list.current.querySelectorAll("[data-shared-message-id]"),
        ].find((node) => node.dataset.sharedMessageId === targetMessage);
        if (target) {
          bottom.current = false;
          target.scrollIntoView?.({ block: "center" });
          located.current = key;
        }
      } else if (!targetMessage && bottom.current && list.current)
        list.current.scrollTop = list.current.scrollHeight;
    }, [messages, targetMessage, conversation.id]);
    const assistantBackend = (message) =>
      (conversation.assistants || []).find(
        (row) => row.assistant_id === message.author_assistant_id,
      )?.assistant_backend ||
      conversation.assistant_backend ||
      "harness";
    return h(
      "section",
      { className: "workagent-collab-chat", "aria-label": "共享对话" },
      h(Feedback, { error }),
      h(
        "div",
        {
          className: "workagent-collab-messages",
          ref: list,
          onScroll: () => {
            const node = list.current;
            bottom.current =
              node.scrollHeight - node.scrollTop - node.clientHeight < 100;
          },
        },
        !messages.length
          ? h(
              "div",
              { className: "workagent-collab-chat-empty" },
              icon("chat", 32),
              h("h2", null, "一起把事情做好"),
              h("p", null, "在这里讨论、分享文件，需要助手时再 @ 它。"),
            )
          : null,
        ...messages.map((message) =>
          h(
            "article",
            {
              key: message.id,
              "data-shared-message-id": message.id,
              className: `workagent-message workagent-collab-message is-${message.kind}${message.is_current_user ? " is-user is-mine" : ""}${message.id === targetMessage ? " workagent-message-highlight" : ""}`,
            },
            h(
              "header",
              null,
              h(
                "span",
                {
                  className: "workagent-collab-avatar workagent-member-avatar",
                  "aria-hidden": true,
                },
                message.kind === "assistant"
                  ? assistantAvatar(assistantBackend(message), icon("chat", 18))
                  : message.kind === "system"
                    ? icon("chat", 16)
                    : Array.from(
                        (message.author_name || "?").trim(),
                      )[0]?.toLocaleUpperCase(),
              ),
              h(
                "strong",
                null,
                message.kind === "assistant"
                  ? message.author_name || "助手"
                  : message.kind === "system"
                    ? "项目动态"
                    : message.author_name,
              ),
              h(
                "time",
                { dateTime: message.created_at },
                new Date(message.created_at).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              ),
            ),
            h(
              "div",
              {
                onClick: (event) => {
                  const anchor = event.target.closest?.("a[href]"),
                    raw = anchor?.getAttribute("href");
                  if (!raw || /^(?:https?:|mailto:|#|\/api\/)/i.test(raw))
                    return;
                  const path = raw
                    .replace(/^shared:\/\/[^/]+\//, "")
                    .replace(/^\.\//, "");
                  if (
                    !path.startsWith("/") &&
                    !path.includes(":") &&
                    !path.split("/").includes("..")
                  ) {
                    event.preventDefault();
                    window.open(
                      fileURL(project.id, path),
                      "_blank",
                      "noopener",
                    );
                  }
                },
              },
              h(Markdown, null, message.body),
            ),
            message.attachments?.length
              ? h(
                  "div",
                  { className: "workagent-collab-chips" },
                  ...message.attachments.map((path) =>
                    h(
                      "a",
                      {
                        key: path,
                        href: fileURL(project.id, path),
                        download: path.split("/").at(-1),
                      },
                      path.split("/").at(-1),
                    ),
                  ),
                )
              : null,
          ),
        ),
      ),
      ...(conversation.assistants || [])
        .filter((agent) => agent.active)
        .map((agent) =>
          h(
            "div",
            {
              key: agent.assistant_id,
              role: "status",
              className: "workagent-collab-running",
            },
            h("span", null, `${agent.name} 正在处理…`),
            h(
              Button,
              {
                "aria-label": `停止 ${agent.name}`,
                onClick: async () => {
                  try {
                    await mutate("shared-runs/cancel", {
                      conversation_id: conversation.id,
                      assistant_id: agent.assistant_id,
                    });
                  } catch (error) {
                    setError(errorText(error));
                  }
                },
              },
              "停止",
            ),
          ),
        ),
      h(Composer, {
        key: conversation.id,
        conversation,
        members,
        projectId: project.id,
        onSend: async (input) => {
          const value = await sendDiscussion(input, conversation);
          setMessages((rows) =>
            rows.some((row) => row.id === value.message.id)
              ? rows
              : [...rows, value.message],
          );
          bottom.current = true;
          setLocal((value) => value + 1);
          void refresh();
          return value;
        },
      }),
    );
  }
  function Files({ project, onClose, revision }) {
    const [wide, setWide] = React.useState(false);
    const resolveOfficePreview = async (_workspace, entry, signal) => {
      const result = await request(`${root}/shared-office-preview`, {
        ...json({ project_id: project.id, path: entry.path }),
        signal,
      });
      return result.url;
    };
    const createEmptyFile = async ({ directory, name }) => {
      const result = await uploads.uploadFiles(
        project.id,
        [new File([new Uint8Array(0)], name, { type: "text/plain" })],
        { directory },
      );
      if (result.failures.length) throw new Error(result.failures.join("；"));
    };
    return h(
      "aside",
      {
        className: `workagent-collab-files is-unified${wide ? " is-wide" : ""}`,
        "aria-label": "项目文件侧栏",
      },
      h(
        "header",
        { className: "workagent-files-panel-header" },
        h("strong", null, "项目文件"),
        h(FileIconButton, {
          name: "expand",
          label: wide ? "缩小文件侧栏" : "放大文件侧栏",
          onClick: () => setWide(!wide),
        }),
        h(FileIconButton, {
          name: "close",
          label: "关闭文件侧栏",
          onClick: onClose,
        }),
      ),
      h(
        "div",
        { className: "workagent-files-project", title: project.name },
        project.name,
      ),
      FileManager
        ? h(FileManager, {
            key: project.id,
            workspace: project,
            root: fileRoot(project.id),
            trashRoot: `${fileRoot(project.id)}/trash`,
            contentURL: fileURL,
            uploadClient: uploads,
            resolveOfficePreview,
            editable: false,
            createEmptyFile,
            onDismiss: onClose,
          })
        : h(
            "div",
            { className: "workagent-file-panel-empty" },
            "文件管理器暂不可用。",
          ),
    );
  }
  function Sidebar() {
    const { confirm, confirmation } = useConfirm();
    const state = useShared(),
      params = new URLSearchParams(useSearch()),
      selected = params.get("project"),
      pins = usePins("workagent.shared-project-pins.v1");
    const hasPersonalTasks = state.conversations.some(
      (row) => row.kind === "personal_task",
    );
    const [sessionState, reloadSessions] = useResource(
      hasPersonalTasks ? `${apiRoot}/sessions` : null,
    );
    React.useEffect(() => {
      if (hasPersonalTasks) void reloadSessions();
    }, [state.revision, hasPersonalTasks]);
    const taskSessions = new Map(sessionState.rows.map((row) => [row.id, row]));
    const [creating, setCreating] = React.useState(false),
      [invites, setInvites] = React.useState(false),
      [searching, setSearching] = React.useState(false),
      [collapsed, setCollapsed] = React.useState({}),
      [sectionClosed, setSectionClosed] = React.useState(false),
      [menu, setMenu] = React.useState(null),
      [action, setAction] = React.useState(null),
      [name, setName] = React.useState(""),
      [busy, setBusy] = React.useState(false),
      [query, setQuery] = React.useState(""),
      [hidden, setHidden] = React.useState(false),
      [error, setError] = React.useState("");
    const members = useMembers(
      action?.kind === "members" ? action.project : null,
      state.revision,
    );
    const operation = React.useRef(uid());
    const rows = sortProjectsByChat(
        state.projects,
        state.conversations,
        pins.pins,
      ).filter(
        (row) =>
          Boolean(row.hidden) === hidden &&
          (row.name.toLowerCase().includes(query.toLowerCase()) ||
            state.conversations.some(
              (discussion) =>
                discussion.project_id === row.id &&
                !discussion.hidden &&
                discussion.name.toLowerCase().includes(query.toLowerCase()),
            )),
      ),
      count = state.invites.filter((row) => row.status === "pending").length;
    React.useEffect(() => {
      const close = (event) => {
        if (event.defaultPrevented) return;
        if (event.key === "Escape") {
          if (menu) setMenu(null);
          else if (!action && !creating && !invites) closeMobileSidebar?.();
        }
      };
      window.addEventListener("keydown", close);
      return () => window.removeEventListener("keydown", close);
    }, [menu, action, creating, invites]);
    const begin = (kind, project, discussion) => {
      setMenu(null);
      setError("");
      setName(
        kind === "discussion" ? "" : discussion?.name || project?.name || "",
      );
      operation.current = uid();
      setAction({ kind, project, discussion });
    };
    const perform = async (fn) => {
      if (busy) return;
      setBusy(true);
      setError("");
      try {
        await fn();
        setMenu(null);
        setAction(null);
      } catch (error) {
        setError(errorText(error));
      } finally {
        setBusy(false);
      }
    };
    const updateDiscussion = (discussion, fields) =>
      mutate(
        "shared-conversations",
        { conversation_id: discussion.id, ...fields },
        "PATCH",
      );
    const more = (label, target) =>
      h(SidebarAction, {
        label,
        "aria-haspopup": "dialog",
        onClick: () => {
          setError("");
          setMenu(target);
        },
      });
    const menuItem = (label, glyph, onClick) =>
      h(Button, { disabled: busy, onClick }, icon(glyph, 16), label);
    return h(
      "section",
      {
        className: "workagent-sidebar-browser workagent-collab-sidebar",
        "aria-label": "协作项目",
      },
      h("button", {
        type: "button",
        className: "workagent-mobile-backdrop",
        "aria-label": "收起导航菜单",
        tabIndex: -1,
        onClick: closeMobileSidebar,
      }),
      h(SidebarHeader, {
        title: hidden ? "已隐藏项目" : "项目",
        expanded: !sectionClosed,
        onToggle: () => setSectionClosed(!sectionClosed),
        actions: h(
          React.Fragment,
          null,
          h(SidebarAction, {
            label: searching ? "关闭搜索" : "搜索共享项目",
            icon: searching ? "close" : "search",
            "aria-pressed": searching,
            onClick: () => {
              setSearching(!searching);
              setQuery("");
            },
          }),
          h(SidebarAction, {
            label: "新建协作项目",
            icon: "plus",
            onClick: () => setCreating(true),
          }),
          more("协作更多操作", {}),
        ),
      }),
      searching
        ? h(SidebarSearch, {
            autoFocus: true,
            "aria-label": "搜索共享项目",
            placeholder: "搜索项目",
            value: query,
            onChange: (event) => setQuery(event.target.value),
          })
        : null,
      count
        ? h(
            Button,
            {
              className: "workagent-collab-invite-entry",
              onClick: () => setInvites(true),
            },
            "项目邀请",
            h("span", { className: "workagent-badge" }, count),
          )
        : null,
      h(Feedback, { error: error || state.error }),
      h(
        "div",
        { className: "workagent-sidebar-projects" },
        ...(sectionClosed ? [] : rows).map((project) => {
          const discussions = state.conversations
            .filter((row) => row.project_id === project.id && !row.hidden)
            .sort((a, b) => Number(b.pinned) - Number(a.pinned));
          const firstDiscussion = discussions.find(
            (row) => row.kind !== "personal_task",
          );
          return h(
            SidebarGroup,
            {
              key: project.id,
              title: project.name,
              icon: icon("workspace", 15),
              pinned: pins.pins.includes(project.id),
              expanded: !collapsed[project.id],
              onToggle: () =>
                setCollapsed((value) => ({
                  ...value,
                  [project.id]: !value[project.id],
                })),
              actions: h(
                React.Fragment,
                null,
                h(SidebarAction, {
                  label: `在 ${project.name} 中新建讨论`,
                  icon: "plus",
                  onClick: () => begin("discussion", project),
                }),
                more(`项目操作 ${project.name}`, { project }),
              ),
            },
            ...discussions.map((discussion) => {
              const personalTask = discussion.kind === "personal_task";
              const active = personalTask
                ? params.get("session") === discussion.runtime_session_id
                : params.get("discussion") === discussion.id ||
                  (!params.get("discussion") &&
                    !params.get("session") &&
                    firstDiscussion === discussion);
              return h(SidebarRow, {
                key: discussion.id,
                title: discussion.name,
                selected: selected === project.id && active,
                icon: personalTask
                  ? SessionAvatar
                    ? h(SessionAvatar, {
                        session: taskSessions.get(
                          discussion.runtime_session_id,
                        ),
                      })
                    : assistantAvatar(null, icon("chat", 16))
                  : icon("teams", 16),
                meta: personalTask
                  ? h("span", { className: "workagent-badge" }, "个人")
                  : null,
                pinned: personalTask && !!discussion.pinned,
                status: h(SidebarStatus, {
                  running: discussion.state === "running",
                  label: "助手正在运行",
                }),
                onOpen: () =>
                  personalTask
                    ? go(
                        personalTaskRoute(
                          project.id,
                          discussion.runtime_session_id,
                        ),
                      )
                    : go(route(project.id, discussion.id)),
                actions: personalTask
                  ? more(`个人任务操作 ${discussion.name}`, {
                      project,
                      discussion,
                    })
                  : h(SidebarAction, {
                      label: `${discussion.pinned ? "取消置顶" : "置顶"} ${discussion.name}`,
                      icon: "pin",
                      disabled: busy,
                      "aria-pressed": !!discussion.pinned,
                      onClick: () =>
                        void perform(() =>
                          updateDiscussion(discussion, {
                            pinned: !discussion.pinned,
                          }),
                        ),
                    }),
              });
            }),
            !discussions.length
              ? h(
                  "button",
                  {
                    type: "button",
                    className:
                      "workagent-sidebar-empty workagent-collab-open-empty",
                    onClick: () =>
                      void openProject(project.id).catch((error) =>
                        setError(errorText(error)),
                      ),
                  },
                  "开始讨论",
                )
              : null,
          );
        }),
      ),
      !rows.length && !sectionClosed
        ? h(
            "p",
            { className: "workagent-collab-empty" },
            state.loading
              ? "正在加载…"
              : query
                ? "没有找到项目"
                : hidden
                  ? "没有隐藏项目"
                  : "创建项目，邀请同事一起协作。",
          )
        : null,
      menu?.discussion?.kind === "personal_task"
        ? h(ConversationMenu, {
            title: menu.discussion.name,
            projectName: menu.project.name,
            pinned: !!menu.discussion.pinned,
            busy,
            error,
            onPin: () =>
              void perform(() =>
                updateDiscussion(menu.discussion, {
                  pinned: !menu.discussion.pinned,
                }),
              ),
            onManage: () =>
              begin("rename-personal-task", menu.project, menu.discussion),
            onClose: () => {
              if (!busy) setMenu(null);
            },
          })
        : menu
          ? h(
              Modal,
              {
                title: menu.discussion?.name || menu.project?.name || "协作",
                onClose: () => setMenu(null),
              },
              h(
                ActionList,
                null,
                menu.discussion
                  ? h(
                      React.Fragment,
                      null,
                      menuItem(
                        menu.discussion.pinned ? "取消置顶" : "置顶讨论",
                        "pin",
                        () =>
                          void perform(() =>
                            updateDiscussion(menu.discussion, {
                              pinned: !menu.discussion.pinned,
                            }),
                          ),
                      ),
                      menuItem("重命名讨论", "edit", () =>
                        begin(
                          "rename-discussion",
                          menu.project,
                          menu.discussion,
                        ),
                      ),
                    )
                  : menu.project
                    ? h(
                        React.Fragment,
                        null,
                        menuItem(
                          pins.pins.includes(menu.project.id)
                            ? "取消置顶"
                            : "置顶项目",
                          "pin",
                          () => {
                            pins.toggle(menu.project.id);
                            setMenu(null);
                          },
                        ),
                        menuItem("新建讨论", "plus", () =>
                          begin("discussion", menu.project),
                        ),
                        menuItem(
                          menu.project.currentRole === "owner"
                            ? "邀请与成员"
                            : "项目成员",
                          "teams",
                          () => begin("members", menu.project),
                        ),
                        menu.project.currentRole === "owner"
                          ? menuItem("重命名项目", "edit", () =>
                              begin("rename", menu.project),
                            )
                          : null,
                        menu.project.currentRole === "owner"
                          ? menuItem("管理讨论", "list", () =>
                              begin("manage-discussions", menu.project),
                            )
                          : null,
                        menuItem(
                          menu.project.hidden ? "显示项目" : "隐藏项目",
                          "workspace",
                          () =>
                            void perform(() =>
                              mutate(
                                `shared-projects/${enc(menu.project.id)}`,
                                { hidden: !menu.project.hidden },
                                "PATCH",
                              ),
                            ),
                        ),
                      )
                    : h(
                        React.Fragment,
                        null,
                        menuItem(
                          count ? `项目邀请 · ${count}` : "项目邀请",
                          "teams",
                          () => {
                            setMenu(null);
                            setInvites(true);
                          },
                        ),
                        menuItem(
                          hidden ? "返回项目" : "已隐藏项目",
                          "workspace",
                          () => {
                            setHidden(!hidden);
                            setMenu(null);
                          },
                        ),
                      ),
              ),
              h(Feedback, { error }),
            )
          : null,
      action?.kind === "members"
        ? h(Members, {
            project: action.project,
            members,
            revision: state.revision,
            onClose: () => setAction(null),
          })
        : null,
      action?.kind === "manage-discussions"
        ? h(
            Modal,
            {
              title: "管理讨论",
              onClose: () => setAction(null),
            },
            h(
              "div",
              { className: "workagent-collab-discussion-manager" },
              ...state.conversations
                .filter(
                  (discussion) =>
                    discussion.project_id === action.project.id &&
                    !discussion.hidden &&
                    discussion.kind !== "personal_task",
                )
                .map((discussion) =>
                  h(
                    "div",
                    { key: discussion.id, className: "workagent-file-row" },
                    icon("teams", 16),
                    h(
                      "span",
                      { className: "workagent-file-name" },
                      discussion.name,
                    ),
                    h(
                      "div",
                      { className: "workagent-file-actions" },
                      h(
                        Button,
                        {
                          onClick: () =>
                            begin(
                              "rename-discussion",
                              action.project,
                              discussion,
                            ),
                        },
                        "重命名",
                      ),
                      h(
                        Button,
                        {
                          className: "workagent-button is-danger",
                          onClick: () =>
                            begin(
                              "delete-discussion",
                              action.project,
                              discussion,
                            ),
                        },
                        "删除",
                      ),
                    ),
                  ),
                ),
            ),
          )
        : null,
      action?.discussion?.kind === "personal_task"
        ? h(ConversationManagementDialog, {
            name,
            onNameChange: setName,
            busy,
            error,
            deleting: action.kind === "delete-personal-task",
            deleteDescription: `删除个人任务“${action.discussion.name}”？会话和消息将一并删除，项目文件会保留。此操作无法撤销。`,
            onClose: () => {
              if (!busy) setAction(null);
            },
            onRequestDelete: () =>
              begin("delete-personal-task", action.project, action.discussion),
            onSave: (event) => {
              event.preventDefault();
              if (!name.trim()) return;
              void perform(() =>
                updateDiscussion(action.discussion, { name: name.trim() }),
              );
            },
            onDelete: (event) => {
              event.preventDefault();
              void perform(async () => {
                await deletePersonalTask(action.discussion);
                if (
                  params.get("session") === action.discussion.runtime_session_id
                )
                  go(route(action.project.id));
              });
            },
          })
        : action && !["members", "manage-discussions"].includes(action.kind)
          ? h(
              Modal,
              {
                title:
                  action.kind === "discussion"
                    ? "新建讨论"
                    : action.kind === "rename"
                      ? "重命名项目"
                      : action.kind === "delete-discussion"
                        ? "删除讨论"
                        : "重命名讨论",
                onClose: () => {
                  if (!busy) setAction(null);
                },
              },
              h(
                "form",
                {
                  className: "workagent-collab-form",
                  onSubmit: (event) => {
                    event.preventDefault();
                    if (action.kind !== "delete-discussion" && !name.trim())
                      return;
                    void perform(async () => {
                      if (action.kind === "discussion") {
                        const value = await mutate("shared-conversations", {
                          project_id: action.project.id,
                          name: name.trim(),
                          operation_id: operation.current,
                        });
                        go(route(action.project.id, value.conversation.id));
                      } else if (action.kind === "rename")
                        await mutate(
                          `shared-projects/${enc(action.project.id)}`,
                          { name: name.trim() },
                          "PATCH",
                        );
                      else if (action.kind === "rename-discussion")
                        await updateDiscussion(action.discussion, {
                          name: name.trim(),
                        });
                      else {
                        await mutate(
                          "shared-conversations",
                          { conversation_id: action.discussion.id },
                          "DELETE",
                        );
                        if (params.get("discussion") === action.discussion.id) {
                          const next = state.conversations.find(
                            (row) =>
                              row.project_id === action.project.id &&
                              row.id !== action.discussion.id &&
                              !row.hidden &&
                              row.kind !== "personal_task",
                          );
                          go(route(action.project.id, next?.id));
                        }
                      }
                    });
                  },
                },
                action.kind === "delete-discussion"
                  ? h(
                      "p",
                      null,
                      `确定删除“${action.discussion.name}”及其全部消息？此操作无法撤销。`,
                    )
                  : h(Input, {
                      "aria-label": "名称",
                      required: true,
                      maxLength: 120,
                      value: name,
                      onChange: (event) => setName(event.target.value),
                    }),
                action.kind === "discussion"
                  ? h(PersonalTaskButton, {
                      project: action.project,
                      onClose: () => setAction(null),
                    })
                  : null,
                h(Feedback, { error }),
                h(
                  "footer",
                  null,
                  h(
                    Button,
                    { onClick: () => setAction(null), disabled: busy },
                    "取消",
                  ),
                  h(
                    Button,
                    {
                      type: "submit",
                      className:
                        action.kind === "delete-discussion"
                          ? "workagent-button is-danger"
                          : "workagent-button is-primary",
                      disabled:
                        busy ||
                        (action.kind !== "delete-discussion" && !name.trim()),
                    },
                    busy
                      ? "处理中…"
                      : action.kind === "delete-discussion"
                        ? "删除"
                        : "保存",
                  ),
                ),
              ),
            )
          : null,
      creating ? h(CreateProject, { onClose: () => setCreating(false) }) : null,
      invites ? h(Invitations, { onClose: () => setInvites(false) }) : null,
      confirmation,
    );
  }
  function Page() {
    const { confirm, confirmation } = useConfirm();
    const state = useShared(),
      search = useSearch(),
      params = new URLSearchParams(search),
      project = state.projects.find((row) => row.id === params.get("project"));
    const discussions = state.conversations.filter(
        (row) =>
          row.project_id === project?.id &&
          !row.hidden &&
          row.kind !== "personal_task",
      ),
      conversation =
        discussions.find((row) => row.id === params.get("discussion")) ||
        discussions[0],
      members = useMembers(project, state.revision);
    const [modal, setModal] = React.useState(""),
      [files, setFiles] = React.useState(false),
      [error, setError] = React.useState(""),
      [notice, setNotice] = React.useState(""),
      [name, setName] = React.useState(""),
      [busy, setBusy] = React.useState(false);
    const discussionOperation = React.useRef(uid());
    React.useEffect(() => {
      setModal(
        params.has("token") ||
          params.has("invite") ||
          params.get("view") === "invites"
          ? "invites"
          : "",
      );
      setError("");
    }, [search]);
    React.useEffect(() => {
      setFiles(false);
      const key = `workagent.shared.notice.${project?.id}`;
      setNotice(sessionStorage.getItem(key) || "");
      sessionStorage.removeItem(key);
      if (project && !discussions.length)
        void openProject(project.id).catch((error) =>
          setError(errorText(error)),
        );
    }, [project?.id]);
    async function perform(fn, success) {
      if (busy) return;
      setBusy(true);
      setError("");
      try {
        await fn();
        setNotice(success || "");
        setModal("");
      } catch (error) {
        setError(errorText(error));
      } finally {
        setBusy(false);
      }
    }
    return h(
      "div",
      { className: "workagent-collab-page" },
      confirmation,
      project
        ? h(
            React.Fragment,
            null,
            h(
              "header",
              { className: "workagent-collab-project-header" },
              h(
                "div",
                { className: "workagent-collab-project-title" },
                h("h1", null, project.name),
                h(
                  "select",
                  {
                    "aria-label": "切换讨论",
                    value: conversation?.id || "",
                    onChange: (event) =>
                      go(route(project.id, event.target.value)),
                  },
                  ...discussions.map((row) =>
                    h("option", { key: row.id, value: row.id }, row.name),
                  ),
                ),
              ),
              h(
                "div",
                { className: "workagent-collab-actions" },
                conversation && SessionReminder
                  ? h(
                      "details",
                      {
                        className: "workagent-collab-reminder",
                        key: conversation.id,
                      },
                      h(
                        "summary",
                        {
                          className: "workagent-button",
                          "aria-label": "消息提醒",
                        },
                        "消息提醒",
                      ),
                      h(
                        "div",
                        { className: "workagent-collab-reminder-popover" },
                        h("small", null, "仅接收 Agent 完成提醒和产物文件。"),
                        h(SessionReminder, {
                          sessionId: `collaboration:${conversation.id}`,
                        }),
                      ),
                    )
                  : null,
                h(
                  Button,
                  {
                    onClick: () => setModal("members"),
                    "aria-label": "查看项目成员",
                    title: `${members.length} 位成员`,
                    className: "workagent-collab-members-button",
                  },
                  h(
                    "span",
                    { className: "workagent-collab-avatars" },
                    ...members.slice(0, 3).map((member) =>
                      h(
                        "span",
                        {
                          key: member.userId,
                          className: "workagent-collab-avatar",
                        },
                        Array.from(
                          (
                            member.displayName ||
                            member.username ||
                            "员"
                          ).trim(),
                        )[0].toLocaleUpperCase(),
                      ),
                    ),
                  ),
                ),
                h(
                  Button,
                  {
                    "aria-pressed": files,
                    "aria-label": "文件",
                    title: "项目文件",
                    className: "workagent-collab-header-icon",
                    onClick: () => setFiles(!files),
                  },
                  icon("workspace"),
                ),
                h(
                  MoreMenu,
                  null,
                  h(
                    Button,
                    { onClick: () => setModal("members") },
                    project.currentRole === "owner" ? "邀请与成员" : "项目成员",
                  ),
                  h(
                    Button,
                    {
                      onClick: () =>
                        go(
                          `/?workagent=marketplace&marketProject=${enc(project.id)}`,
                        ),
                    },
                    "项目能力与版本",
                  ),
                  h(
                    Button,
                    {
                      onClick: () => {
                        setName("");
                        discussionOperation.current = uid();
                        setModal("discussion");
                      },
                    },
                    "新建讨论",
                  ),
                  project.currentRole === "owner"
                    ? h(
                        Button,
                        {
                          onClick: () => {
                            setName(project.name);
                            setModal("rename");
                          },
                        },
                        "重命名",
                      )
                    : null,
                  project.currentRole === "owner" && conversation
                    ? h(
                        Button,
                        {
                          onClick: () => {
                            setModal("assistant");
                          },
                        },
                        "助手设置",
                      )
                    : null,
                  h(
                    Button,
                    {
                      onClick: () =>
                        perform(
                          () =>
                            mutate(
                              `shared-projects/${enc(project.id)}`,
                              { hidden: !project.hidden },
                              "PATCH",
                            ),
                          project.hidden
                            ? "项目已显示。"
                            : "项目已隐藏，可从已隐藏列表找回。",
                        ),
                    },
                    project.hidden ? "显示项目" : "隐藏项目",
                  ),
                  project.currentRole !== "owner"
                    ? h(
                        Button,
                        {
                          onClick: async () => {
                            if (
                              await confirm(
                                "退出项目后将无法继续访问文件和讨论，确定退出？",
                              )
                            )
                              void perform(async () => {
                                await mutate(
                                  `shared-projects/${enc(project.id)}/members/me`,
                                  undefined,
                                  "DELETE",
                                );
                                go(route());
                              }, "已退出项目。");
                          },
                        },
                        "退出项目",
                      )
                    : null,
                ),
              ),
            ),
            h(Feedback, { error: error || state.error, notice }),
            h(
              "div",
              { className: "workagent-collab-workspace" },
              conversation
                ? h(Chat, {
                    key: conversation.id,
                    conversation,
                    project,
                    members,
                    revision: state.revision,
                  })
                : h("p", null, "正在准备讨论…"),
              files
                ? h(Files, {
                    key: project.id,
                    project,
                    revision: state.revision,
                    onClose: () => setFiles(false),
                  })
                : null,
            ),
          )
        : h(
            "div",
            { className: "workagent-collab-welcome" },
            icon("teams", 42),
            h("h1", null, "一起协作"),
            h(
              "p",
              null,
              params.get("project") && !state.loading
                ? "项目不存在，或你已没有访问权限。"
                : "共享项目、讨论和文件，需要助手时再 @ 它。",
            ),
            h(Feedback, { error: error || state.error }),
            h(
              "div",
              { className: "workagent-collab-actions" },
              h(
                Button,
                {
                  className: "workagent-button is-primary",
                  onClick: () => setModal("create"),
                },
                "新建协作项目",
              ),
              h(Button, { onClick: () => setModal("invites") }, "查看邀请"),
            ),
            state.projects.some((row) => !row.hidden)
              ? h(
                  "div",
                  { className: "workagent-collab-project-grid" },
                  ...state.projects
                    .filter((row) => !row.hidden)
                    .map((row) =>
                      h(
                        Button,
                        {
                          key: row.id,
                          onClick: () =>
                            void openProject(row.id).catch((error) =>
                              setError(errorText(error)),
                            ),
                        },
                        icon("workspace"),
                        row.name,
                      ),
                    ),
                )
              : null,
          ),
      modal === "create"
        ? h(CreateProject, { onClose: () => setModal("") })
        : null,
      modal === "invites"
        ? h(Invitations, {
            onClose: () => {
              setModal("");
              if (
                params.has("token") ||
                params.has("invite") ||
                params.has("view")
              )
                go(route(project?.id, conversation?.id));
            },
          })
        : null,
      modal === "members" && project
        ? h(Members, {
            project,
            members,
            revision: state.revision,
            onClose: () => setModal(""),
          })
        : null,
      modal === "assistant" && project
        ? h(AssistantSettings, {
            project,
            revision: state.revision,
            onClose: () => setModal(""),
          })
        : null,
      ["rename", "discussion"].includes(modal) && project
        ? h(
            Modal,
            {
              title: modal === "rename" ? "重命名项目" : "新建讨论",
              onClose: () => setModal(""),
            },
            h(
              "form",
              {
                className: "workagent-collab-form",
                onSubmit: (event) => {
                  event.preventDefault();
                  void perform(async () => {
                    if (modal === "rename")
                      await mutate(
                        `shared-projects/${enc(project.id)}`,
                        { name: name.trim() },
                        "PATCH",
                      );
                    else {
                      const value = await mutate("shared-conversations", {
                        project_id: project.id,
                        name: name.trim(),
                        operation_id: discussionOperation.current,
                      });
                      go(route(project.id, value.conversation.id));
                    }
                  }, "已保存。");
                },
              },
              h(
                "label",
                null,
                "名称",
                h(Input, {
                  "aria-label": modal === "rename" ? "项目名称" : "讨论名称",
                  value: name,
                  onChange: (event) => setName(event.target.value),
                  required: true,
                  maxLength: 128,
                }),
              ),
              modal === "discussion"
                ? h(PersonalTaskButton, {
                    project,
                    onClose: () => setModal(""),
                  })
                : null,
              h(
                "footer",
                null,
                h(Button, { onClick: () => setModal("") }, "取消"),
                h(
                  Button,
                  {
                    type: "submit",
                    className: "workagent-button is-primary",
                    disabled: busy,
                  },
                  busy ? "保存中…" : "保存",
                ),
              ),
            ),
          )
        : null,
    );
  }
  function Hero({ onExit, initial = "" }) {
    const state = useShared(),
      [projectId, setProjectId] = React.useState(""),
      [creating, setCreating] = React.useState(false),
      [pending, setPending] = React.useState(null);
    const project = state.projects.find((row) => row.id === projectId),
      conversation = state.conversations.find(
        (row) =>
          row.project_id === projectId &&
          !row.hidden &&
          row.kind !== "personal_task",
      ),
      members = useMembers(project, state.revision);
    async function send(input) {
      if (!project) {
        setPending(input);
        setCreating(true);
        throw new Error("先创建协作项目，消息将保留并在创建后发送。");
      }
      const target =
        conversation ||
        (await mutate(`shared-projects/${enc(project.id)}/discussion`, {}))
          .conversation;
      const result = await sendDiscussion(input, target);
      await refresh();
      go(route(project.id, target.id));
      return result;
    }
    return h(
      "div",
      { className: "workagent-collab-hero" },
      h(Composer, {
        key: projectId || "new",
        conversation,
        members,
        initial,
        projectId,
        onSend: send,
      }),
      h(
        "div",
        { className: "workagent-project-row" },
        h(
          "select",
          {
            "aria-label": "协作项目",
            value: projectId,
            onChange: (event) => setProjectId(event.target.value),
          },
          h("option", { value: "" }, "新建协作项目…"),
          ...state.projects
            .filter((row) => !row.hidden)
            .map((row) =>
              h("option", { key: row.id, value: row.id }, row.name),
            ),
        ),
        h(Button, { onClick: () => setCreating(true) }, "创建项目"),
        h(
          "label",
          { className: "workagent-team-toggle" },
          h("input", { type: "checkbox", checked: true, onChange: onExit }),
          "协作模式",
        ),
      ),
      creating
        ? h(CreateProject, {
            onClose: () => setCreating(false),
            onCreated: async (value) => {
              if (pending) {
                await sendDiscussion(pending, value.conversation);
                setPending(null);
              }
              await refresh();
              go(route(value.project.id, value.conversation.id));
            },
          })
        : null,
    );
  }
  return Object.assign(Page, {
    Sidebar,
    Hero,
    Invitations,
    CreateProject,
    Composer,
    AssistantMembers,
    AssistantSettings,
    Chat,
    useShared,
    refresh,
    openProject,
    route,
    errorText,
  });
}
