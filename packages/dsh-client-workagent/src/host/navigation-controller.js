// One document owns the runtime; routes only select its visible workspace.
export function createNavigation(React, onNavigate = () => {}) {
  let notificationReturn = "/?frontend=dsh";
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
    // Switching sidebar tabs (任务/频道/协作) is not yet a content selection.
    // Keep the mobile drawer open until the user chooses a concrete session
    // or discussion.
    const tabSwitch =
      (url.searchParams.has("sidebar") &&
        !url.searchParams.has("session") &&
        !url.searchParams.has("project")) ||
      (url.searchParams.get("workagent") === "shared" &&
        !url.searchParams.has("discussion") &&
        !url.searchParams.has("session"));
    if (!tabSwitch) onNavigate();
    if (url.href === location.href) return;
    history.pushState(null, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
  function toggleNotifications() {
    if (
      new URLSearchParams(location.search).get("workagent") === "notifications"
    ) {
      navigate(notificationReturn);
    } else {
      notificationReturn = location.pathname + location.search;
      navigate("/?workagent=notifications");
    }
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
  return { navigate, toggleNotifications, useSearch, install };
}
