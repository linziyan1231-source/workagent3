// Pending receipts are private to this browser tab, keyed by the same identity
// used by the standard prompt RPC and the durable user message.
export function createMessageDelivery(React) {
  const sessions = new Map();
  const listeners = new Set();
  const key = (id) => `workagent.draft.delivery.${id}`;
  function get(id) {
    if (!sessions.has(id)) {
      let rows = [];
      try {
        rows = JSON.parse(sessionStorage.getItem(key(id)) || "[]");
      } catch {
        /* Storage is optional; in-memory receipts still work. */
      }
      sessions.set(
        id,
        rows.map((row) => ({
          ...row,
          status: "failed",
          error: "发送结果待确认，可安全重试。",
        })),
      );
    }
    return sessions.get(id);
  }
  function set(id, rows) {
    sessions.set(id, rows);
    try {
      if (rows.length) sessionStorage.setItem(key(id), JSON.stringify(rows));
      else sessionStorage.removeItem(key(id));
    } catch {
      /* Storage quota must not discard a message in this page. */
    }
    listeners.forEach((listener) => listener());
  }
  function update(id, row) {
    const rows = get(id);
    const index = rows.findIndex((item) => item.id === row.id);
    set(
      id,
      index < 0
        ? [...rows, row]
        : rows.map((item) => (item.id === row.id ? { ...item, ...row } : item)),
    );
  }
  function reconcile(id, messages, queue) {
    const known = new Set([
      ...messages.map((row) => row.id),
      ...queue.map((row) => row.messageId),
    ]);
    const rows = get(id);
    const remaining = rows.filter((row) => !known.has(row.id));
    if (remaining.length !== rows.length) set(id, remaining);
  }
  function useRows(id) {
    return React.useSyncExternalStore(
      React.useCallback((listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }, []),
      React.useCallback(() => get(id), [id]),
    );
  }
  return { get, update, reconcile, useRows };
}
