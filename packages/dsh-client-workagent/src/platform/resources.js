import { request } from "./api.js";
import React from "react";

function useResource(endpoint, select = (value) => value, cache) {
  const cached = () => cache?.get(endpoint);
  const [state, setState] = React.useState(
    () =>
      cached() || {
        loading: true,
        rows: [],
        error: "",
      },
  );
  const resourceGeneration = React.useRef(0);
  const load = React.useCallback(
    async (signal, quiet = false) => {
      if (!endpoint) return;
      const generation = ++resourceGeneration.current;
      if (!quiet && !cached())
        setState((value) => ({ ...value, loading: true, error: "" }));
      try {
        const value = await request(endpoint, { signal });
        if (signal?.aborted || generation !== resourceGeneration.current)
          return;
        const selected = select(value);
        const next = {
          loading: false,
          rows: Array.isArray(selected)
            ? selected
            : selected == null
              ? []
              : [selected],
          error: "",
        };
        cache?.set(endpoint, next);
        setState(next);
      } catch (error) {
        if (signal?.aborted || generation !== resourceGeneration.current)
          return;
        if ([401, 403, 404].includes(error.status)) cache?.remove(endpoint);
        if (error.name !== "AbortError")
          setState((value) => ({
            loading: false,
            rows:
              quiet && ![401, 403, 404].includes(error.status)
                ? value.rows
                : [],
            error: error.message,
          }));
      }
    },
    [endpoint],
  );
  React.useEffect(() => {
    const controller = new AbortController();
    setState(cached() || { loading: true, rows: [], error: "" });
    void load(controller.signal);
    return () => {
      resourceGeneration.current += 1;
      controller.abort();
    };
  }, [load]);
  const refresh = React.useCallback(() => load(undefined, true), [load]);
  return [state, refresh];
}

export { useResource };
