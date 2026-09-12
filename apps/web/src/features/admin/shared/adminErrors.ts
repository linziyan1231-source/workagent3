import { ApiError } from "../../../shared/api/http.js";

export function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      administrator_required: "当前账户没有管理权限。",
      invalid_employee: "请检查账户名和密码格式。",
      invalid_password: "密码不符合安全要求。",
      invalid_quota_adjustment: "请输入有效的非负整数额度。",
      employee_provision_failed: "账户创建未能启动，请检查账户名是否已存在。",
      employee_manager_failed: "操作未完成，请检查账户状态后重试。",
      quota_not_configured: "此账户尚未配置该模型额度。",
      quota_unavailable: "额度服务暂时不可用。",
    };
    return messages[error.code] ?? `操作未完成（${error.code}），请重试。`;
  }
  return "连接失败，请检查网络后重试。";
}
