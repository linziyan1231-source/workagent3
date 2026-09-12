// Mobile transcripts use the document, just like the administrator pages.
// Preserve their position while the drawer temporarily occupies the page.
export function trackConversationScroll(list, sidebar, cache, sessionId, side) {
  const media = window.matchMedia("(max-width: 760px)");
  const inDocument = () => media.matches && !side;
  const drawerOpen = () => sidebar.isOpen();
  let wasOpen = drawerOpen();
  let position = cache.get(sessionId, "scroll") ?? 0;
  const save = (value) => {
    position = value;
    cache.set(sessionId, "scroll", value);
  };
  const restore = () => {
    if (inDocument()) window.scrollTo(0, drawerOpen() ? 0 : position);
    else {
      if (!side && window.scrollY) window.scrollTo(0, 0);
      list.scrollTop = position;
    }
  };
  const onDocumentScroll = () => {
    if (inDocument() && !drawerOpen()) save(window.scrollY);
  };
  const onListScroll = () => {
    if (!inDocument()) save(list.scrollTop);
  };
  const unsubscribeSidebar = sidebar.subscribe(() => {
    const open = drawerOpen();
    if (open === wasOpen) return;
    wasOpen = open;
    if (inDocument()) restore();
  });
  window.addEventListener("scroll", onDocumentScroll, { passive: true });
  list.addEventListener("scroll", onListScroll, { passive: true });
  media.addEventListener("change", restore);
  restore();
  return () => {
    unsubscribeSidebar();
    window.removeEventListener("scroll", onDocumentScroll);
    list.removeEventListener("scroll", onListScroll);
    media.removeEventListener("change", restore);
    if (inDocument()) window.scrollTo(0, 0);
  };
}
