import { useCallback, useEffect, useState } from "react";
import { accountApi, type Employee } from "./accountApi.js";
import { errorMessage } from "../shared/adminErrors.js";

export function useAccountDirectory() {
  const [users, setUsers] = useState<Employee[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await accountApi.users();
      setUsers(result.users ?? []);
      setSources(result.kimi_datasource_sources ?? []);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { users, sources, loading, error, reload };
}
export type AccountDirectory = ReturnType<typeof useAccountDirectory>;
