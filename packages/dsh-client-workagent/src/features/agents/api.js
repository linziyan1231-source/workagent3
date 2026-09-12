import React from "react";
import { apiRoot, mutate } from "../../platform/api.js";
import { useResource } from "../../platform/resources.js";

export const PRESETS_CHANGED_EVENT = "workagent:presets-changed";

export function usePresets(select) {
  const resource = useResource(`${apiRoot}/presets`, select);
  const refresh = resource[1];
  React.useEffect(() => {
    const reload = () => void refresh();
    window.addEventListener(PRESETS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(PRESETS_CHANGED_EVENT, reload);
  }, [refresh]);
  return resource;
}

export async function mutatePreset(...args) {
  const saved = await mutate(...args);
  if (saved) window.dispatchEvent(new CustomEvent(PRESETS_CHANGED_EVENT));
  return saved;
}
