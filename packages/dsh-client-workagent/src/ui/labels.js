const valueLabels = {
  builtin: "系统内置",
  user: "用户添加",
  market: "技能市场",
  ready: "可用",
  healthy: "运行正常",
  unknown: "未知状态",
  disabled: "已停用",
  unavailable: "不可用",
  none: "无需授权",
  needs_auth: "需要授权",
  needs_review: "需要确认",
  pending: "等待中",
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  independent_sessions: "独立会话",
  harness: "通用引擎",
  codex: "Codex",
  kimi: "Kimi",
  "codex-native": "Codex 原生模型",
  "harness-default": "通用默认模型",
  "kimi-native": "Kimi 原生模型",
  "team.updated": "团队已更新",
  "member.added": "已添加成员",
  "task.queued": "任务已排队",
  "task.started": "任务已开始",
  "task.completed": "任务已完成",
  "task.failed": "任务失败",
  "task.cancelled": "任务已取消",
  "mail.received": "收到团队消息",
};

const displayValue = (value, fallback = "") =>
  valueLabels[value] || value || fallback;

const displayModelName = (model) =>
  valueLabels[model.id] || model.displayName || model.id;

const displayPresetName = (name) => (name === "General" ? "DSH" : name);

const displayWorkspaceName = (name) => {
  if (name === "Personal workspace") return "个人项目";
  const qa = /^QA wa3acc-([a-z])$/i.exec(name);
  return qa ? `测试项目 ${qa[1].toUpperCase()}` : name;
};

const displaySessionTitle = (title) =>
  title === "General" ? "通用会话" : title;

const plainSessionTitle = (value) =>
  String(value).replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();

const friendlyError = (value) => {
  const message = String(value || "");
  if (/high demand|overloaded|server.*busy/i.test(message))
    return "模型服务当前繁忙，请稍后重试，或在模型设置中选择其他模型。";
  if (message.startsWith("credential_needs_auth:codex"))
    return "Codex 尚未完成登录，请先在设置中连接 Codex。";
  if (message.startsWith("credential_needs_auth:kimi"))
    return "Kimi 尚未完成登录，请先在设置中连接 Kimi。";
  if (message.startsWith("unsupported_preset_approval_policy:"))
    return "此引擎无法执行助手要求的审批策略，请调整助手配置或选择明确支持的权限。";
  const labels = {
    session_close_failed: "对话暂时无法删除，请稍后重试。",
    engine_unavailable: "所选助手当前不可用，请检查引擎设置。",
    engine_start_failed: "助手启动失败，请检查引擎状态后重试。",
    engine_turn_rejected: "助手没有接受这条消息，请稍后重试。",
    quota_exceeded: "使用额度不足，请联系管理员调整额度，或等待下一周期。",
    quota_usage_stale: "用量统计服务暂不可用，请稍后重试。",
    quota_usage_pending: "上一轮用量正在结算，请稍后重试。",
    quota_not_configured: "此模型尚未配置使用额度，请联系管理员。",
    platform_quota_unconfigured: "额度服务尚未配置，请联系管理员。",
    engine_steer_rejected:
      "追加指令未被接受；任务可能已结束，请检查状态后重新发送。",
    no_active_turn: "当前任务已结束，请直接发送消息。",
    queued_message_not_found: "这条排队消息已发送或移除，请刷新列表。",
    session_input_pending: "当前会话正在处理另一条指令，请稍候。",
    edit_stop_timeout: "原任务仍在停止中，请等它结束后重试编辑。",
    fork_message_not_found: "找不到这条消息，请刷新会话后重试。",
    session_resume_failed: "恢复会话失败，请重新开始一个会话。",
    workspace_not_found: "所选项目不存在，请重新选择。",
    invalid_session: "会话参数无效，请重新选择助手和项目。",
    unsupported_preset_tool_allowlist:
      "此引擎无法执行助手的工具限制，任务尚未启动，请调整助手配置。",
    preset_workspace_required: "此助手要求指定项目，请先选择一个项目。",
    engine_permission_unavailable:
      "此引擎无法提供所选权限，任务尚未启动，请调整权限或更换引擎。",
    personal_task_already_deleted: "此个人任务已删除，请重新提交以创建新任务。",
    personal_task_retry_pending: "任务操作已记录，服务恢复后会继续处理。",
    content_required: "请输入要发送的内容。",
    invalid_move: "不能移入自身或子文件夹，也不能移动系统目录。",
    ambiguous_file_reference:
      "此旧路径对应多份历史文件，请从项目文件中选择所需文件。",
    move_not_pending: "此移动已处理，请刷新查看。",
    move_not_completed: "此移动尚未完成，暂时不能撤销。",
    destination_exists: "同名文件已存在，请换一个名称。",
    workspace_directory_exists: "工作区中已存在同名文件夹，请换一个项目名称。",
    invalid_workspace_name:
      "项目名称不能包含路径或特殊字符，也不能使用系统保留名称。",
    file_changed: "文件已被其他操作修改。请重新打开文件，确认后再编辑。",
    unsupported_text_encoding:
      "在线编辑仅支持 UTF-8 文本，请下载后使用对应编码的编辑器修改。",
    file_not_found: "文件已不存在，请刷新列表。",
    invalid_relative_path: "文件名或路径无效。",
    workspace_operation_failed: "文件操作失败，请刷新后重试。",
    request_too_large: UPLOAD_TOO_LARGE_MESSAGE,
    path_outside_workspace: "文件路径必须位于当前项目内。",
    reparse_point_rejected: "无法操作链接到项目外的文件。",
    im_gateway_unavailable: "消息渠道服务暂未启用。",
    market_unavailable: "市场暂时不可用，请稍后重试。",
    market_version_exists: "这个名称和版本已经发布，请填写新的版本号。",
    market_credentials_required: "请填写所需的连接凭据。",
    market_source_not_found: "所选内容已不存在，请重新选择。",
    market_builtin_dependency_unavailable:
      "当前账号缺少内置依赖，请联系管理员配置后重试。",
    market_skill_dependency_missing: "助手引用的技能不存在，请先修复绑定。",
    market_mcp_dependency_missing: "引用的 MCP 服务不存在，请先修复绑定。",
    market_mcp_url_contains_credentials:
      "服务地址含有密钥或密码，请先改为使用独立连接凭据。",
    market_mcp_command_not_portable:
      "MCP 使用了本机绝对路径，请先改成可在其他成员环境中运行的命令。",
    market_publish_own_assistant_only: "请发布自己创建的助手。",
    market_publish_own_skill_only:
      "内置技能无需重复发布，可以作为助手依赖共享。",
    market_skill_snapshot_unavailable:
      "此技能的原发布包不可用，请重新获取后再发布。",
    market_bundle_too_large: "包含的技能文件超过 50 MB，请缩小发布包。",
    invalid_market_publish: "请完整填写发布内容和三段式版本号，例如 1.0.0。",
  };
  if (message?.startsWith("market_runtime_"))
    return "安装或发布未完成，请检查依赖配置后重试；已经完成的安装步骤会保留。";
  if (message?.startsWith("invalid_mcp_binding:"))
    return "绑定的 MCP 尚未就绪，请先测试连接或完成授权。";
  if (message?.startsWith("invalid_skill_binding:"))
    return "绑定的技能尚未就绪，请先启用技能并检查依赖。";
  return labels[message] || message || "操作失败，请稍后重试。";
};

const reasoningLabel = (option) =>
  ({
    none: "无",
    minimal: "最低",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
    max: "最高",
    ultra: "极高",
    off: "关闭",
    thinking: "开启",
    on: "开启",
  })[option.id] ||
  option.name ||
  option.id;

export {
  displayValue,
  displayPresetName,
  displayWorkspaceName,
  displaySessionTitle,
  plainSessionTitle,
  friendlyError,
  reasoningLabel,
};
import { UPLOAD_TOO_LARGE_MESSAGE } from "@workagent/contracts/upload-policy";
