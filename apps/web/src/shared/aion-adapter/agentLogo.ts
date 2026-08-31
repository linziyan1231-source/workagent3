export function useAgentLogos() {
  return {};
}
export function resolveAgentLogo() {
  return null;
}

export function resolveAgentAvatar(
  _logos: Record<string, string>,
  options: { icon?: string | null },
) {
  const icon = options.icon?.trim();
  if (!icon) return { kind: "fallback" as const };
  if (
    /^(https?:|data:|\/)/i.test(icon) ||
    /\.(svg|png|jpe?g|webp|gif)$/i.test(icon)
  ) {
    return { kind: "image" as const, value: icon };
  }
  return { kind: "emoji" as const, value: icon };
}

export function isDefaultModel(value?: string | null, label?: string | null) {
  return `${value ?? ""} ${label ?? ""}`.toLowerCase().includes("default");
}

export function getModelDisplayLabel({
  selectedLabel,
  fallbackLabel,
}: {
  selectedLabel?: string | null;
  fallbackLabel: string;
}) {
  return selectedLabel || fallbackLabel;
}
