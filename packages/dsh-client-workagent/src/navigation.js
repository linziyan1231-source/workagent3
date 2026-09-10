// One document owns the runtime; routes only select its visible workspace.
export function createNavigation(React, onNavigate = () => {}) {
  const subscribe = (notify) => {
    window.addEventListener("popstate", notify);
    return () => window.removeEventListener("popstate", notify);
  };
  const snapshot = () => location.search;
  const useSearch = () => React.useSyncExternalStore(subscribe, snapshot);
  function isAppURL(url) {
    return (
      url.origin === location.origin &&
      url.pathname === "/" &&
      (!url.searchParams.has("frontend") ||
        url.searchParams.get("frontend") === "dsh")
    );
  }
  function navigate(href) {
    const url = new URL(href, location.href);
    if (!isAppURL(url)) return location.assign(url.href);
    url.searchParams.set("frontend", "dsh");
    onNavigate();
    if (url.href === location.href) return;
    history.pushState(null, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
  function install() {
    const onClick = (event) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = event.target.closest?.("a[href]");
      if (
        !anchor ||
        anchor.hasAttribute("download") ||
        (anchor.target && anchor.target !== "_self")
      )
        return;
      const url = new URL(anchor.href, location.href);
      if (
        !isAppURL(url) ||
        (!url.searchParams.has("session") &&
          !url.searchParams.has("workagent") &&
          !url.searchParams.has("project"))
      )
        return;
      event.preventDefault();
      navigate(url.href);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }
  return { navigate, useSearch, install };
}

// Cache data, not mounted conversations or subscriptions. Bound by sessions and
// serialized size so a handful of large transcripts cannot grow without limit.
export function createConversationCache(
  limit = 12,
  maxBytes = 16 * 1024 * 1024,
) {
  const sessions = new Map();
  let bytes = 0;
  function remove(id) {
    const entry = sessions.get(id);
    if (entry) bytes -= entry.bytes;
    sessions.delete(id);
  }
  function get(id, key) {
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    sessions.set(id, entry);
    return entry.values.get(key)?.value;
  }
  function set(id, key, value) {
    const size = JSON.stringify(value).length * 2;
    if (size > maxBytes) {
      remove(id);
      return;
    }
    const entry = sessions.get(id) || { values: new Map(), bytes: 0 };
    const change = size - (entry.values.get(key)?.bytes || 0);
    entry.bytes += change;
    bytes += change;
    entry.values.set(key, { value, bytes: size });
    sessions.delete(id);
    sessions.set(id, entry);
    while (sessions.size > limit || bytes > maxBytes)
      remove(sessions.keys().next().value);
  }
  return { get, set, remove };
}
