import type { JsonValue, NativeApprovalOption } from "./types.js";

/** Choice ids address the offered native value; clients never submit policy objects. */
export function codexApprovalChoices(
  values: readonly JsonValue[],
): NativeApprovalOption[] {
  return values.flatMap((value, index): NativeApprovalOption[] => {
    const id = `native-${index}`;
    if (value === "accept")
      return [{ id, label: "允许本次", outcome: "allow", scope: "once" }];
    if (value === "acceptForSession")
      return [
        { id, label: "在本会话允许", outcome: "allow", scope: "session" },
      ];
    if (value === "decline")
      return [{ id, label: "拒绝本次", outcome: "reject", scope: "once" }];
    if (value === "cancel")
      return [{ id, label: "取消操作", outcome: "cancel", scope: "once" }];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("acceptWithExecpolicyAmendment" in value)
        return [
          {
            id,
            label: "允许并记住此命令规则",
            outcome: "allow",
            scope: "rule",
          },
        ];
      if ("applyNetworkPolicyAmendment" in value) {
        const rule = value.applyNetworkPolicyAmendment;
        const amendment =
          rule && typeof rule === "object" && !Array.isArray(rule)
            ? (rule.networkPolicyAmendment ?? rule)
            : undefined;
        const reject =
          amendment &&
          typeof amendment === "object" &&
          !Array.isArray(amendment) &&
          amendment.action === "deny";
        return [
          {
            id,
            label: reject ? "拒绝并记住此网络规则" : "允许并记住此网络规则",
            outcome: reject ? "reject" : "allow",
            scope: "rule",
          },
        ];
      }
    }
    return [];
  });
}

export function acpApprovalChoices(
  values: readonly { optionId: string; name: string; kind: string }[],
): NativeApprovalOption[] {
  return values.map((value) => ({
    id: value.optionId,
    label: value.name,
    outcome: value.kind.startsWith("allow_") ? "allow" : "reject",
    scope: value.kind.endsWith("_always") ? "remember" : "once",
  }));
}
